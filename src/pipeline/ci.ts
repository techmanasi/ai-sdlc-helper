// The full suite in CI (tests.fullSuite "ci"): is CI reachable, wait for the checks of a pushed commit, and sort what
// failed into infrastructure problems, failures the base already had, flaky tests, allowed failures, and side effects
// of the change (the only ones that block). Nothing here edits source; it reads GitHub through the gh CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from '../trace.js';
import { parseJestLike } from '../runners/jest.js';
import { parseNodeTest } from '../runners/nodeTest.js';
import type { RunParts } from '../runners/types.js';
import { checkAllowedFailures, isRedTest, matchesAllowEntry } from './allow-failures.js';
import type { Ctx } from './context.js';
import { keepError } from './errors.js';
import { clearPrCache, createOrGetPr, getPrStatus, getPrFromBrief, recordPrInBrief, type CheckRunStatus, type PrStatus } from './finalise.js';

export type CiClassification = 'infrastructure' | 'pre-existing' | 'flaky' | 'allowed' | 'side-effect';
export interface CiCheckResult { name: string; conclusion: string; detailsUrl?: string; log?: string }
export interface CiTestFailure {
  checkName: string;
  file: string;
  testName: string;
  message: string;
  runUrl: string;
  classification: CiClassification;
}
export interface CiStepResult {
  status: 'green' | 'green-with-warnings' | 'red' | 'timed-out' | 'unavailable';
  reason?: string;
  nonBlocking: CiTestFailure[];
  sideEffects: CiTestFailure[];
  /** Test files of the side-effect failures: the next local gate runs them too. */
  testFiles: string[];
  totalTests?: number;
  failedTests?: number;
  skippedTests?: number;
  durationMs?: number;
  /** The checks that failed (for the status file and the run page). */
  failingChecks?: string[];
  /** How many checks CI ran (for the status line when there is no test report). */
  totalChecks?: number;
}

export const REPORT_ARTIFACT = 'sdlc-test-report';
const POLL_MS = 60_000;
const NO_WORKFLOW_MS = 3 * 60_000;
const QUERY_FAILURES_ALLOWED = 3;
const REPORT_MISSING_LINE = 'CI test report not found: classifying by check';

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

/**
 * The line of a failed git command that says why. A rejected push starts with "To <url>", and the reason (the
 * [rejected] line, error:, hint:) comes after it, so the first line alone is useless.
 */
export function gitReason(message: string): string {
  const lines = String(message).replace(/^\s*git .*? failed:\s*/, '').split('\n').map(l => l.trim()).filter(Boolean);
  const pick = lines.find(l => /\[rejected\]|\[remote rejected\]/.test(l))
    || lines.find(l => /^(?:error:|fatal:|remote:)/.test(l))
    || lines.find(l => !l.startsWith('To '))
    || '';
  return pick.replace(/ {2,}/g, ' ');
}

// --- Availability ----------------------------------------------------------------------------------------------------

/** The title and body of the draft pull request a run opens. */
export function draftPrText(ctx: Ctx): { title: string; body: string } {
  return {
    title: `feat(${ctx.slug}): implement per ${ctx.docs}/specs-1.md`,
    body: `Automated draft for \`${ctx.slug}\`.\n\nSpecs: \`${ctx.docs}/specs-1.md\``,
  };
}

/**
 * Whether the full suite can run in CI: an origin remote, gh installed and signed in, the branch pushed (with upstream
 * tracking), and an open PR for it (a draft is opened when there is none). The PR link goes into brief.md.
 */
export async function checkCiAvailability(ctx: Ctx): Promise<{ available: boolean; reason?: string; pr?: string; prDraft?: boolean; rejected?: boolean }> {
  let remotes = '';
  try { remotes = ctx.git.run('remote'); } catch { remotes = ''; }
  if (!remotes.split('\n').map(s => s.trim()).includes('origin')) return { available: false, reason: 'no remote' };

  const gh = (args: string[]) => {
    try { return spawnSync('gh', args, { cwd: ctx.root, encoding: 'utf8', env: ctx.env, timeout: 30_000 }); } catch { return null; }
  };
  const version = gh(['--version']);
  if (!version || version.status !== 0) return { available: false, reason: 'gh not installed' };
  const auth = gh(['auth', 'status']);
  if (!auth || auth.status !== 0) {
    keepError(ctx, 'gh auth status', auth ? `${String(auth.stderr || '')}\n${String(auth.stdout || '')}`.trim() || 'no output available' : 'no output available');
    return { available: false, reason: 'gh not authenticated' };
  }

  const branch = ctx.branch;
  try { ctx.git.run('push', '-u', 'origin', branch); } catch (e) {
    const message = (e as Error).message;
    keepError(ctx, 'push', message);
    return {
      available: false,
      reason: `push failed: ${gitReason(message)}; the whole message is in ${ctx.log}/errors.log`,
      ...(/non-fast-forward|fetch first|\[rejected\]/.test(message) ? { rejected: true } : {}),
    };
  }

  clearPrCache();
  let pr: PrStatus | null = getPrStatus(ctx.root, branch, ctx.env);
  if (!pr) {
    const { title, body } = draftPrText(ctx);
    const url = createOrGetPr(ctx.root, branch, title, body, ctx.config.git.base || undefined, { draft: true });
    if (!url) {
      keepError(ctx, 'gh pr create', 'no output available');
      return { available: false, reason: 'PR could not be created' };
    }
    clearPrCache();
    pr = getPrStatus(ctx.root, url, ctx.env) || { url, state: 'OPEN', isDraft: true };
  }
  if (pr.state === 'CLOSED') return { available: false, reason: 'PR is closed' };
  if (pr.state === 'MERGED') return { available: false, reason: 'PR is merged' };

  const brief = path.join(ctx.root, ctx.docs, 'brief.md');
  try {
    if (fs.existsSync(brief)) {
      const text = fs.readFileSync(brief, 'utf8');
      if (getPrFromBrief(text) !== pr.url) fs.writeFileSync(brief, recordPrInBrief(text, pr.url));
    }
  } catch { /* the link in brief.md is a convenience */ }
  return { available: true, pr: pr.url, ...(typeof pr.isDraft === 'boolean' ? { prDraft: pr.isDraft } : {}) };
}

// --- Test reports ----------------------------------------------------------------------------------------------------

/** A report path from a CI machine (/home/runner/work/repo/repo/test/a.test.ts) as a path from the project root. */
function fromRoot(file: string | null): string | null {
  if (!file || !/^(?:\.\.\/|\/)/.test(file)) return file;
  const m =/^(?:\.\.\/)*(?:.*\/work\/[^/]+\/[^/]+\/)(.+)$/.exec(file);
  if (m) return m[1];
  return file.replace(/^(?:\.\.\/)+/, '');
}

function parseReportText(text: string, root: string): RunParts | null {
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  let parts: RunParts | null = null;
  if (json && typeof json === 'object') {
    const j = json as { testResults?: unknown; tests?: unknown; suiteErrors?: unknown };
    if (Array.isArray(j.testResults)) parts = parseJestLike(json, { root });
    else if (Array.isArray(j.tests)) parts = { tests: j.tests as RunParts['tests'], suiteErrors: Array.isArray(j.suiteErrors) ? j.suiteErrors as RunParts['suiteErrors'] : [] };
  } else {
    const n = parseNodeTest(text, { root });
    if (n.tests.length || n.suiteErrors.length) parts = n;
  }
  if (!parts) return null;
  return {
    tests: parts.tests.map(t => ({ ...t, file: fromRoot(t.file) })),
    suiteErrors: parts.suiteErrors.map(e => ({ ...e, file: fromRoot(e.file) })),
  };
}

function filesIn(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesIn(p)); else out.push(p);
  }
  return out;
}

/**
 * The tests of the sdlc-test-report artifact of run <runId>, downloaded into <destDir>: a Jest or Vitest JSON report, the
 * node:test reporter's lines, or the pipeline's own RunResult JSON. null when there is no artifact or nothing in it parses.
 */
export async function downloadTestReport(cwd: string, runId: string, destDir: string, env: NodeJS.ProcessEnv): Promise<RunParts | null> {
  let r;
  try { r = spawnSync('gh', ['run', 'download', runId, '-n', REPORT_ARTIFACT, '-D', destDir], { cwd, encoding: 'utf8', env, timeout: 120_000 }); } catch { return null; }
  if (!r || r.status !== 0) return null;
  const merged: RunParts = { tests: [], suiteErrors: [] };
  let found = false;
  for (const file of filesIn(destDir)) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const parts = parseReportText(text, cwd);
    if (!parts) continue;
    found = true;
    merged.tests.push(...parts.tests);
    merged.suiteErrors.push(...parts.suiteErrors);
  }
  return found ? merged : null;
}

async function reportOfRun(ctx: Ctx, runId: string): Promise<RunParts | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-ci-report-'));
  try { return await downloadTestReport(ctx.root, runId, path.join(dir, 'report'), ctx.env); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- gh helpers ------------------------------------------------------------------------------------------------------

function ghJson<T>(ctx: Ctx, args: string[]): T | null {
  try {
    const r = spawnSync('gh', args, { cwd: ctx.root, encoding: 'utf8', env: ctx.env, timeout: 60_000 });
    if (r.status !== 0 || !String(r.stdout).trim()) return null;
    return JSON.parse(String(r.stdout)) as T;
  } catch { return null; }
}

interface RunJob { name: string; conclusion?: string | null; status?: string }
interface RunInfo { status?: string; conclusion?: string | null; jobs?: RunJob[] }

const runView = (ctx: Ctx, runId: string): RunInfo | null => ghJson<RunInfo>(ctx, ['run', 'view', runId, '--json', 'status,conclusion,jobs']);

const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required', 'stale', 'error']);

/** The failed checks of the base's CI run and its test report, at the merge-base of HEAD and the configured base branch. */
export async function fetchBaseResults(ctx: Ctx): Promise<{ report: RunParts | null; failedChecks: string[] }> {
  const none = { report: null, failedChecks: [] as string[] };
  let sha = '';
  try { sha = ctx.git.run('merge-base', 'HEAD', ctx.config.git.base || 'main').trim(); } catch { return none; }
  if (!sha) return none;
  const runs = ghJson<{ databaseId: number; status?: string; conclusion?: string }[]>(
    ctx, ['run', 'list', '--commit', sha, '--json', 'databaseId,headSha,status,conclusion,url,workflowName', '-L', '20'],
  );
  const done = (runs || []).find(r => String(r.status || '').toLowerCase() === 'completed');
  if (!done) return none;
  const id = String(done.databaseId);
  const info = runView(ctx, id);
  const failedChecks = (info?.jobs || []).filter(j => FAILED.has(String(j.conclusion || '').toLowerCase())).map(j => j.name);
  return { report: await reportOfRun(ctx, id), failedChecks };
}

// --- Checks of the pushed commit ------------------------------------------------------------------------------------

interface Check { name: string; done: boolean; conclusion: string; detailsUrl?: string }

function normaliseCheck(c: CheckRunStatus): Check {
  const name = c.name || c.context || '(unnamed check)';
  if (c.state !== undefined && c.status === undefined) {
    const s = String(c.state).toUpperCase();
    const done = s === 'SUCCESS' || s === 'FAILURE' || s === 'ERROR';
    return { name, done, conclusion: s === 'SUCCESS' ? 'success' : done ? 'failure' : '', detailsUrl: c.targetUrl };
  }
  return { name, done: String(c.status || '').toUpperCase() === 'COMPLETED', conclusion: String(c.conclusion || '').toLowerCase(), detailsUrl: c.detailsUrl };
}

const runIdOf = (url?: string): string | null => (url && /\/actions\/runs\/(\d+)/.exec(url)?.[1]) || null;
const runUrlOf = (url?: string): string => (url && /^(.*\/actions\/runs\/\d+)/.exec(url)?.[1]) || url || '';
const INFRASTRUCTURE = new Set(['cancelled', 'timed_out', 'startup_failure']);
const PASSING = new Set(['success', 'skipped', 'neutral']);

function checksOf(pr: PrStatus, headSha: string): Check[] {
  if (pr.headRefOid && pr.headRefOid !== headSha) return [];
  return (pr.statusCheckRollup || []).map(normaliseCheck);
}

const TEST_OUTPUT = /\b(?:FAIL|PASS)\b|\bTests?:|Test Files|[✓✗✕×]|# (?:pass|fail)\b|\bnot ok\b|\d+ (?:passing|failing|passed|failed)/;
const hasTestOutput = (log: string): boolean => TEST_OUTPUT.test(log);

function failingFilesOf(log: string): string[] {
  const files = new Set<string>();
  for (const m of log.matchAll(/\bFAIL\s+(\S+)/g)) files.add(m[1].replace(/^\.\//, '').replace(/[:>,]+$/, ''));
  return [...files];
}

const failedLog = (ctx: Ctx, runId: string): string => {
  try {
    const r = spawnSync('gh', ['run', 'view', runId, '--log-failed'], { cwd: ctx.root, encoding: 'utf8', env: ctx.env, timeout: 120_000 });
    return r.status === 0 ? String(r.stdout) : '';
  } catch { return ''; }
};

const reported = new WeakSet<object>();

/** Appends the non-blocking failures to <docs>/logs/ci-failures.md and prints a WARNING for each. */
function logNonBlocking(ctx: Ctx, failures: CiTestFailure[]): void {
  if (!failures.length) return;
  const lines = failures.map(f => {
    const id = [f.file, f.testName].filter(Boolean).join(' :: ');
    return `- ${f.classification}: ${f.checkName}${id ? ` — ${id}` : ''}${f.runUrl ? ` — ${f.runUrl}` : ''}`;
  });
  try {
    const dir = path.join(ctx.root, ctx.docs, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ci-failures.md'), `${lines.join('\n')}\n`);
  } catch { /* the WARNING lines below still say it */ }
  for (const f of failures) {
    const id = [f.file, f.testName].filter(Boolean).join(' :: ');
    ctx.out(`WARNING: CI ${f.classification} failure not blocking: ${f.checkName}${id ? ` ${id}` : ''}${f.runUrl ? ` (${f.runUrl})` : ''}`);
  }
}

interface FailedCheck extends Check { runId: string | null }

type Candidate = CiTestFailure & { check: FailedCheck };

/**
 * Waits for the checks of <headSha> (polling the PR every minute), then classifies what failed. Returns green when every
 * check passed or was skipped; unavailable ("no workflow") when no check shows up within three minutes of the push;
 * timed-out after ci.waitMinutes; otherwise the failures sorted as described above (only side effects make it red).
 */
export async function waitForCiAndClassify(ctx: Ctx, headSha: string, options: { prUrl: string; startTime: number }): Promise<CiStepResult> {
  const limitMs = ctx.config.ci.waitMinutes * 60_000;
  const empty = { nonBlocking: [], sideEffects: [], testFiles: [] };
  let queryFailures = 0;
  let checks: Check[] = [];
  for (;;) {
    clearPrCache();
    const pr = getPrStatus(ctx.root, options.prUrl, ctx.env);
    const elapsed = Date.now() - options.startTime;
    if (!pr) {
      queryFailures++;
      if (queryFailures >= QUERY_FAILURES_ALLOWED) return { status: 'timed-out', reason: 'CI status could not be read', ...empty, durationMs: elapsed };
    } else {
      queryFailures = 0;
      checks = checksOf(pr, headSha);
      if (!checks.length) {
        if (elapsed >= NO_WORKFLOW_MS) return { status: 'unavailable', reason: 'no workflow', ...empty, durationMs: elapsed };
      } else if (checks.every(c => c.done)) break;
    }
    if (elapsed >= limitMs) return { status: 'timed-out', ...empty, durationMs: elapsed };
    await sleep(POLL_MS);
  }

  const failed: FailedCheck[] = checks.filter(c => !PASSING.has(c.conclusion)).map(c => ({ ...c, runId: runIdOf(c.detailsUrl) }));
  if (!failed.length) return { status: 'green', ...empty, totalChecks: checks.length, durationMs: Date.now() - options.startTime };
  return { ...(await classify(ctx, failed, options.startTime, limitMs)), totalChecks: checks.length };
}

async function classify(ctx: Ctx, failed: FailedCheck[], startTime: number, limitMs: number): Promise<CiStepResult> {
  const nonBlocking: CiTestFailure[] = [];
  const allow = ctx.config.tests.allowFailures || [];
  const isRed = (file: string, name?: string) => isRedTest(ctx, file, name);
  const infoOf = (c: FailedCheck, file = '', testName = '', message = '', classification: CiClassification = 'side-effect'): Candidate => ({
    checkName: c.name, file, testName, message, runUrl: runUrlOf(c.detailsUrl), classification, check: c,
  });
  const strip = ({ check: _check, ...f }: Candidate): CiTestFailure => f;

  // 1. Infrastructure, by conclusion.
  const real: FailedCheck[] = [];
  for (const c of failed) {
    if (INFRASTRUCTURE.has(c.conclusion)) nonBlocking.push(strip(infoOf(c, '', '', `check ${c.conclusion}`, 'infrastructure')));
    else real.push(c);
  }

  let base: { report: RunParts | null; failedChecks: string[] } | null = null;
  const baseResults = async () => (base ||= await fetchBaseResults(ctx));

  // Reports of the failing runs; a check without a report (or without a failed test in it) is classified by its log.
  const runIds = [...new Set(real.map(c => c.runId).filter((x): x is string => Boolean(x)))];
  const tests: RunParts['tests'] = [];
  const suiteErrors: RunParts['suiteErrors'] = [];
  let anyReport = false;
  const reportRuns = new Set<string>();
  for (const id of runIds) {
    const report = await reportOfRun(ctx, id);
    if (!report) continue;
    anyReport = true;
    reportRuns.add(id);
    tests.push(...report.tests);
    suiteErrors.push(...report.suiteErrors.filter(e => e.file));
  }
  const failedTests = tests.filter(t => t.status === 'failed' && t.file);
  const withTests = new Set<FailedCheck>();
  const candidates: Candidate[] = [];
  if (failedTests.length || suiteErrors.length) {
    const owner = real.find(c => c.runId && reportRuns.has(c.runId)) || real[0];
    for (const t of failedTests) candidates.push(infoOf(owner, t.file as string, t.name, t.message || '', 'side-effect'));
    for (const e of suiteErrors) candidates.push(infoOf(owner, e.file as string, '(test file failed to run)', e.message, 'side-effect'));
    for (const c of real) if (c.runId && reportRuns.has(c.runId)) withTests.add(c);
  }
  const byCheck = real.filter(c => !withTests.has(c));

  // Test-level classification (8.3): pre-existing, allowed, then flaky.
  const rest: Candidate[] = [];
  if (candidates.length) {
    const baseline = await baseResults();
    const baseFailed = new Set((baseline.report?.tests || []).filter(t => t.status === 'failed').map(t => `${t.file}\u0000${t.name}`));
    const afterBase: Candidate[] = [];
    for (const f of candidates) {
      if (baseFailed.has(`${f.file}\u0000${f.testName}`)) nonBlocking.push(strip({ ...f, classification: 'pre-existing' }));
      else afterBase.push(f);
    }
    const verdict = checkAllowedFailures(afterBase.map(f => ({ file: f.file, name: f.testName })), allow, isRed, msg => ctx.out(msg));
    for (const f of afterBase) {
      if (verdict.allowed.some(a => a.file === f.file && a.name === f.testName)) nonBlocking.push(strip({ ...f, classification: 'allowed' }));
      else rest.push(f);
    }
  }

  // Check-level classification (8.2) for checks without test results.
  const checkLevel: { c: FailedCheck; log: string }[] = [];
  for (const c of byCheck) {
    if (!reported.has(ctx)) { reported.add(ctx); ctx.out(REPORT_MISSING_LINE); }
    const log = c.runId ? failedLog(ctx, c.runId) : '';
    if (!hasTestOutput(log)) { nonBlocking.push(strip(infoOf(c, '', '', 'no test output in the log', 'infrastructure'))); continue; }
    const baseline = await baseResults();
    if (baseline.failedChecks.includes(c.name)) { nonBlocking.push(strip(infoOf(c, '', '', 'failed on the base too', 'pre-existing'))); continue; }
    const files = failingFilesOf(log);
    const wholeFile = (file: string) => allow.some(e => matchesAllowEntry(e, file));
    if (files.length && files.every(wholeFile) && !files.some(f => isRed(f))) {
      for (const f of files) nonBlocking.push(strip(infoOf(c, f, '', 'allowed by tests.allowFailures', 'allowed')));
      continue;
    }
    if (files.some(f => wholeFile(f) && isRed(f))) {
      for (const f of files.filter(x => wholeFile(x) && isRed(x))) ctx.out(`WARNING: tests.allowFailures entry ignored: ${f} is a red test and must pass`);
    }
    checkLevel.push({ c, log });
  }

  // Flaky: the failed jobs run once more; whatever passes then was flaky.
  const rerunRuns = [...new Set([...rest.map(f => f.check.runId), ...checkLevel.map(x => x.c.runId)].filter((x): x is string => Boolean(x)))];
  // Every failing run gets its failed jobs re-run once (one rerun per run of this pushed head), then waited for.
  const rerunReports = new Map<string, RunParts | null>();
  const jobConclusion = new Map<string, Map<string, string>>();
  if (rest.length || checkLevel.length) {
    for (const id of rerunRuns) {
      try { spawnSync('gh', ['run', 'rerun', id, '--failed'], { cwd: ctx.root, encoding: 'utf8', env: ctx.env, timeout: 60_000 }); } catch { /* the failure stays */ }
    }
    for (const id of rerunRuns) {
      const finished = await waitForRerun(ctx, id, startTime, limitMs);
      if (!finished) {
        return { status: 'timed-out', reason: 'rerun of failed jobs did not finish', nonBlocking: nonBlocking, sideEffects: [], testFiles: [], durationMs: Date.now() - startTime };
      }
      jobConclusion.set(id, new Map((finished.jobs || []).map(j => [j.name, String(j.conclusion || '').toLowerCase()])));
      rerunReports.set(id, await reportOfRun(ctx, id));
    }
  }
  const passedOnRerun = (c: FailedCheck): boolean => Boolean(c.runId && PASSING.has(jobConclusion.get(c.runId)?.get(c.name) || ''));
  const sideEffects: CiTestFailure[] = [];
  for (const f of rest) {
    const reran = Boolean(f.check.runId && jobConclusion.has(f.check.runId));
    const again = f.check.runId ? rerunReports.get(f.check.runId) : undefined;
    // Flaky only when the rerun shows the test passing (or, when its report lacks the test, the job passing).
    const inRerun = again ? again.tests.filter(t => t.file === f.file && t.name === f.testName) : [];
    const flaky = reran && (inRerun.length
      ? inRerun.every(t => t.status !== 'failed')
      : passedOnRerun(f.check));
    if (flaky) nonBlocking.push(strip({ ...f, classification: 'flaky' }));
    else sideEffects.push(strip(f));
  }
  for (const { c, log } of checkLevel) {
    const flaky = passedOnRerun(c);
    if (flaky) nonBlocking.push(strip(infoOf(c, '', '', 'passed on rerun', 'flaky')));
    else sideEffects.push(strip(infoOf(c, '', '', log.trim().split('\n').slice(-20).join('\n'), 'side-effect')));
  }
  const stillFailing = new Set(sideEffects.map(f => f.checkName));

  logNonBlocking(ctx, nonBlocking);
  const all = anyReport ? tests : [];
  return {
    status: sideEffects.length ? 'red' : 'green-with-warnings',
    nonBlocking, sideEffects,
    testFiles: [...new Set(sideEffects.map(f => f.file).filter(Boolean))],
    ...(anyReport ? { totalTests: all.length, failedTests: failedTests.length, skippedTests: all.filter(t => t.status === 'skipped').length } : {}),
    failingChecks: stillFailing.size ? [...stillFailing] : failed.map(c => c.name),
    durationMs: Date.now() - startTime,
  };
}

/** Waits until run <runId> (rerun for its failed jobs) completes; null when the configured wait ran out first. */
async function waitForRerun(ctx: Ctx, runId: string, startTime: number, limitMs: number): Promise<RunInfo | null> {
  for (;;) {
    await sleep(POLL_MS);
    const info = runView(ctx, runId);
    if (info && String(info.status || '').toLowerCase() === 'completed') return info;
    if (Date.now() - startTime >= limitMs) return null;
  }
}
