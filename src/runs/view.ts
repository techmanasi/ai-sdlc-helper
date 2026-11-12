// What a monitor (the web app, later the plugin's pane) shows of the board and of one run, read from the run's files:
// its record, status.json, run.out, questions.md, logs/permissions.json, tests.json and stage-files.json. Nothing here
// writes, except answerQuestions.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '../trace.js';
import { exists } from '../util.js';
import { resolve as resolveConfig } from '../config/settings.js';
import { backlogItems, type BacklogItem } from '../backlog/index.js';
import { isProtected, loadState, ruleFor, type Ask } from '../permissions/index.js';
import { alive, readRecord, runState, type RunRecord } from './records.js';
import { projectSlugs, readCheckpoint, runChanges, runWorktree, type RunContext } from './index.js';
import { ciSummaryOf, getPrFromBrief, getPrStatusCached, prCommentsEmpty, prPollOptions, syncPrStatus, type CiState, type PrRead } from '../pipeline/finalise.js';
import { readRounds, type Round } from '../pipeline/observe.js';
import { stageRecoveryHint, type StageRecovery } from '../pipeline/hints.js';
import { Git } from '../pipeline/git.js';
import { withAnswerLines } from '../pipeline/questions.js';
import { redPattern } from '../pipeline/stages.js';

export type ViewState = 'not started' | 'running' | 'paused' | 'done' | 'failed' | 'interrupted' | 'stopped' | 'refused';

/** One question of questions.md: "### Q<n>: <title>", a body, "**Suggested:** ...", "**Answer:** ...". */
export interface Question { n: number; title: string; body: string; suggested: string; answer: string }

export interface TestCounts { passed: number; failed: number; skipped: number; total: number }

export interface RunView {
  slug: string;
  state: ViewState;
  /** The stage status.json names (Spec, Plan, Red tests, Implement, Test repair, Review, Finalise), '' before the first. */
  stage: string;
  agent: string;
  model: string;
  effort: string;
  models: Record<string, { model: string; effort: string }>;
  attempt: string;
  /** Why a running run waits, for example a usage limit; '' otherwise. */
  note: string;
  agentStarted: string;
  /** What the stage is doing now (step i of n); absent when status.json carries none or it is malformed. */
  step?: { i: number; n: number; label: string; started: string };
  runStarted: string;
  updated: string;
  record: Partial<RunRecord> | null;
  /** The folder holding the run's files: its worktree, else the main working tree for a run started in place. */
  dir: string | null;
  worktree: string | null;
  branch: string;
  base: string;
  /** Why a start was refused or a run could not begin. */
  message: string;
  questions: Question[];
  /** Refused actions waiting for Allow or Deny. */
  permissions: Ask[];
  /** Previously denied actions that may be allowed or re-decided. */
  deniedPermissions: Ask[];
  tests: TestCounts | null;
  stageFiles: Record<string, string[]>;
  changes: { changed: number; uncommitted: number; files: string[] } | null;
  /** The last lines of run.out. */
  tail: string[];
  /** The item's files, from its folder: brief.md, specs-1.md, logs/run.out … */
  docs: string[];
  /** The command that brings a discarded branch back, '' when none was discarded. */
  discarded: string;
  /** The --from value that resumes the run where it stopped ('' for the start). */
  resumeFrom: string;
  /** The short sha of the red-tests commit on the run's branch, '' when there is none (Plan and Red tests are refused once it exists). */
  redCommit: string;
  /** How old the git facts (changes, redCommit, PR state) are in ms; null when they were just read or not asked for. */
  gitAgeMs: number | null;
  createPr?: boolean;
  pr?: string | null;
  prState?: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  /** The CI of the PR, and the names of its failing checks; ciSummary: error lines of the failure (ci-failure.md), when there is one. */
  prCi?: CiState | null;
  prFailing?: string[];
  prConflicts?: 'none' | 'conflicting' | 'unknown' | null;
  ciSummary?: string[];
  hasPrComments?: boolean;
  /** The last start can be undone: what it started from and when. */
  undo?: { from: string; at: string } | null;
  /** The last Resolve conflicts stopped on a failed check and its merged result is kept: "Fix with Implement" can repair it. */
  mergeFix?: boolean;
  testIssues?: string | null;
  recovery?: StageRecovery | null;
  /** What each agent round did (logs/attempts.jsonl), with its warnings; empty before the first round. */
  attempts: Round[];
  /** CI full-suite gate status; null unless tests.fullSuite is "ci". */
  ci?: CiView | null;
}

export interface CiView {
  enabled: boolean;
  state: string;
  pr: string | null;
  prDraft: boolean;
  reason?: string;
  failingChecks: string[];
  warnings: string[];
}

function ciView(root: string, env: NodeJS.ProcessEnv, status: any, brief: string | null): CiView | null {
  const c = status && typeof status === 'object' ? status.ci : null;
  if (!c || typeof c !== 'object') return null;
  let mode: string = 'local';
  try {
    const r = resolveConfig(root, { env });
    mode = r.config ? r.config.tests.fullSuite : String(env.SDLC_FULL_SUITE || readJson(path.join(root, 'sdlc.config.json'))?.tests?.fullSuite || 'local');
  } catch { /* keep local */ }
  if (mode !== 'ci') return null;
  const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    enabled: c.enabled !== false,
    state: typeof c.state === 'string' ? c.state : 'waiting',
    pr: typeof c.pr === 'string' ? c.pr : (brief ? getPrFromBrief(brief) : null),
    prDraft: c.prDraft === true,
    ...(typeof c.reason === 'string' ? { reason: c.reason } : {}),
    failingChecks: strs(c.failingChecks),
    warnings: strs(c.warnings),
  };
}

const readText = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** The questions of a questions.md text, in file order. */
export function parseQuestions(text: string): Question[] {
  const out: Question[] = [];
  let q: Question | null = null;
  let part: 'body' | 'suggested' | 'answer' = 'body';
  const add = (field: 'body' | 'suggested' | 'answer', line: string) => { if (q && line.trim()) q[field] = `${q[field]} ${line.trim()}`.trim(); };
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^### Q(\d+):\s*(.*)$/);
    if (head) {
      q = { n: Number(head[1]), title: head[2].trim(), body: '', suggested: '', answer: '' };
      out.push(q);
      part = 'body';
    } else if (/^\*\*Suggested:\*\*/.test(line)) {
      part = 'suggested';
      add(part, line.replace(/^\*\*Suggested:\*\*/, ''));
    } else if (/^\*\*Answer:\*\*/.test(line)) {
      part = 'answer';
      add(part, line.replace(/^\*\*Answer:\*\*/, ''));
    } else if (part !== 'answer') {
      add(part, line);
    }
  }
  return out;
}

/**
 * Puts each answer on its question's "**Answer:**" line (an answer is one line: newlines become spaces; an empty one
 * keeps what the line had). Returns how many questions there are and how many now have an answer. Throws when the file
 * is missing or a number names no question.
 */
export function answerQuestions(file: string, answers: Record<string, string>): { total: number; answered: number } {
  const text = readText(file);
  if (text === null) throw new Error(`no questions to answer: ${file} is missing`);
  const withLines = withAnswerLines(text);
  const numbers = new Set(parseQuestions(withLines).map(q => q.n));
  for (const k of Object.keys(answers)) if (!numbers.has(Number(k))) throw new Error(`there is no question ${k}`);
  let n = 0;
  const lines = withLines.split('\n').map(line => {
    const head = line.match(/^### Q(\d+):/);
    if (head) n = Number(head[1]);
    const a = (answers[String(n)] ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
    return /^\*\*Answer:\*\*/.test(line) && a ? `**Answer:** ${a}` : line;
  });
  fs.writeFileSync(file, lines.join('\n'));
  const after = parseQuestions(lines.join('\n'));
  return { total: after.length, answered: after.filter(q => q.answer).length };
}

/** The stage a run resumes at: Plan and Red tests at their own stage, Test repair if claims exist, else Implement. */
export function resumeStage(stage: string, hasTestIssues = false): string {
  if (stage === 'Resolve conflicts' || stage === 'resolve-conflicts') return 'resolve-conflicts';
  if (stage === 'Finalise' || stage === 'finalise') return 'finalise';
  if (stage === 'Review' || stage === 'review') return 'review';
  if (stage === 'Test repair' || stage === 'test-repair') return hasTestIssues === true ? 'test-repair' : 'implement';
  if (stage === 'Implement' || stage === 'implement') return 'implement';
  return stage === 'Plan' || stage === 'plan' ? 'plan' : stage === 'Red tests' || stage === 'red-tests' ? 'red-tests' : '';
}

const FROM_TO_STAGE: Record<string, string> = {
  spec: 'Spec',
  plan: 'Plan',
  'red-tests': 'Red tests',
  implement: 'Implement',
  'test-repair': 'Test repair',
  review: 'Review',
  finalise: 'Finalise',
  'resolve-conflicts': 'Resolve conflicts',
};

/** The step from status.json as `{ step }`, or `{}` when it is missing or malformed (an older status file has none). */
export function stepOf(raw: any): { step?: NonNullable<RunView['step']> } {
  if (!raw || typeof raw !== 'object') return {};
  const { i, n, label, started } = raw;
  if (!Number.isFinite(i) || !Number.isFinite(n) || typeof label !== 'string' || !label || typeof started !== 'string') return {};
  return { step: { i, n, label, started } };
}

function viewState(rec: Partial<RunRecord> | null, status: any): ViewState {
  if (rec) {
    const rs = runState(rec);
    if (rs === 'running' || rs === 'interrupted' || rs === 'stopped') return rs;
    if (rec.exit_code === '0') return 'done';
    if (rec.exit_code === '2') return 'paused';
    return !rec.worktree && rec.message ? 'refused' : 'failed';
  }
  if (!status) return 'not started';
  if (status.state === 'running') return alive(status.pid, typeof status.pid_start === 'string' && status.pid_start ? status.pid_start : undefined) ? 'running' : 'stopped';
  return ['paused', 'done', 'failed'].includes(status.state) ? status.state : 'failed';
}

function testCounts(result: any): TestCounts | null {
  if (!result || !Array.isArray(result.tests)) return null;
  const c = { passed: 0, failed: 0, skipped: 0, total: result.tests.length };
  for (const t of result.tests) if (t.status in c) (c as any)[t.status]++;
  c.failed += Array.isArray(result.suiteErrors) ? result.suiteErrors.length : 0;
  return c;
}

/** The last <n> lines of <file>, read from its last 64 KB. */
function tail(file: string, n: number): string[] {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
    if (len < size) lines.shift(); // the first line may be cut
    return lines.slice(-n);
  } finally { fs.closeSync(fd); }
}

function docFiles(docsDir: string): string[] {
  const list = (rel: string): string[] => {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(path.join(docsDir, rel), { withFileTypes: true }); } catch { return []; }
    return names.filter(d => d.isFile()).map(d => (rel ? `${rel}/${d.name}` : d.name));
  };
  return [...list('').sort(), ...list('logs').sort()];
}

/** The red-tests commit of <slug> in <worktree> ('' when none or git cannot say). */
function redCommitOf(worktree: string, slug: string): string {
  try { return new Git(worktree).findCommit([redPattern(slug)], '%h'); } catch { return ''; }
}

/** The folders a run writes to (the run register, the item folder in its worktree and in the checkout, and its logs) and its run.out. */
export function runPaths(ctx: RunContext, slug: string): { dirs: string[]; out: string | null } {
  const worktree = runWorktree(ctx, slug);
  const inPlace = exists(path.join(ctx.root, ctx.backlogDir, slug, 'logs', 'status.json')) ? ctx.root : null;
  const dir = worktree || inPlace;
  const docsDir = dir ? path.join(dir, ctx.backlogDir, slug) : path.join(ctx.root, ctx.backlogDir, slug);
  const dirs = [ctx.reg, docsDir, path.join(docsDir, 'logs'), path.join(ctx.root, ctx.backlogDir, slug)];
  return { dirs: [...new Set(dirs)].filter(d => exists(d)), out: dir ? path.join(docsDir, 'logs', 'run.out') : null };
}

/** The last <n> lines of a run's run.out ([] when none). */
export function runTail(ctx: RunContext, slug: string, n = 40): string[] {
  const out = runPaths(ctx, slug).out;
  return out ? tail(out, n) : [];
}

/** The parts of a run view: `live` (files only), `tail` (the end of run.out) and `git` (counts, Red tests commit, PR state). */
export type RunPart = 'live' | 'tail' | 'git';
export const RUN_PARTS: readonly RunPart[] = ['live', 'tail', 'git'];

interface GitFacts { changes: RunView['changes']; redCommit: string }
const gitCache = new Map<string, { key: string; at: number; facts: GitFacts }>();
const GIT_TTL_RUNNING_MS = 30_000;

/** Forgets the cached git facts (of one run, or all). */
export function clearGitFacts(worktree?: string, slug?: string): void {
  if (worktree && slug) gitCache.delete(`${worktree}::${slug}`); else gitCache.clear();
}

/** The kept merged result (refs/sdlc-attempt/<branch>) of the last Resolve conflicts, with the branch still where that attempt started. */
function mergeFixKept(worktree: string | null, branch: string, logs: string): boolean {
  if (!worktree || !fs.existsSync(worktree)) return false;
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(logs, 'resolve-conflicts.json'), 'utf8')) as { before?: string };
    const git = (...a: string[]) => spawnSync('git', ['-C', worktree, ...a], { encoding: 'utf8' });
    return git('rev-parse', '--verify', '-q', `refs/sdlc-attempt/${branch}`).status === 0 && !!rec.before && git('rev-parse', 'HEAD').stdout.trim() === rec.before;
  } catch { return false; }
}

/**
 * The git facts of a run from the cache, read again when the run's stage, attempt or state changed (the key), when a
 * running run's facts are older than 30 s, or when <refresh> is set. Returns the facts and their age (null: just read).
 */
function gitFactsOf(ctx: RunContext, slug: string, worktree: string, key: string, running: boolean, refresh: boolean, maxAgeMs?: number): { facts: GitFacts; ageMs: number | null } {
  const id = `${worktree}::${slug}`;
  const hit = gitCache.get(id);
  const now = Date.now();
  const limit = running ? Math.min(GIT_TTL_RUNNING_MS, maxAgeMs ?? Infinity) : maxAgeMs ?? Infinity;
  if (hit && !refresh && hit.key === key && now - hit.at < limit) return { facts: hit.facts, ageMs: now - hit.at };
  const c = runChanges(ctx, slug);
  const facts: GitFacts = { changes: 'error' in c ? null : { changed: c.changed, uncommitted: c.uncommitted, files: c.files }, redCommit: redCommitOf(worktree, slug) };
  gitCache.set(id, { key, at: now, facts });
  return { facts, ageMs: null };
}

/** Everything the run screen shows of <slug>; `changes: false` skips the git calls that count its files. */
export function runView(ctx: RunContext, slug: string, opts: {
  changes?: boolean; tailLines?: number; checkPr?: boolean;
  /** Which parts to build (default: all). Without `git` no git command runs and no PR is asked for. */
  parts?: readonly RunPart[];
  /** Take the git facts from the per-run cache (the web run route); a stage, attempt or state change reads them again. */
  cacheGit?: boolean;
  /** With cacheGit: read the git facts again now. */
  refresh?: boolean;
  /** With cacheGit: read the git facts again when they are older than this, also for a run that is not running (the board). */
  gitMaxAgeMs?: number;
} = {}): RunView {
  const want = (part: RunPart): boolean => !opts.parts || opts.parts.includes(part);
  const rec = readRecord(ctx.reg, slug);
  const worktree = runWorktree(ctx, slug);
  const inPlace = exists(path.join(ctx.root, ctx.backlogDir, slug, 'logs', 'status.json')) ? ctx.root : null;
  const dir = worktree || inPlace;
  const docsDir = dir ? path.join(dir, ctx.backlogDir, slug) : path.join(ctx.root, ctx.backlogDir, slug);
  const logs = path.join(docsDir, 'logs');
  const status = dir ? readJson(path.join(logs, 'status.json')) : null;
  const s = status && typeof status === 'object' ? status : {};
  const questions = parseQuestions(readText(path.join(docsDir, 'questions.md')) || '');
  const permState = dir ? loadState(path.join(logs, 'permissions.json')) : null;
  const stageFiles = readJson(path.join(logs, 'stage-files.json'));
  let changes: RunView['changes'] = null;
  let redCommit = '';
  let gitAgeMs: number | null = null;
  const stageNow = typeof s.stage === 'string' ? s.stage : '';
  const stateNow = viewState(rec, status);
  if (want('git') && worktree) {
    if (opts.cacheGit) {
      const key = `${stateNow}|${stageNow}|${s.attempt || ''}|${rec?.finished || ''}`;
      const g = gitFactsOf(ctx, slug, worktree, key, stateNow === 'running', opts.refresh === true, opts.gitMaxAgeMs);
      redCommit = g.facts.redCommit;
      gitAgeMs = g.ageMs;
      if (opts.changes !== false) changes = g.facts.changes;
    } else {
      if (opts.changes !== false) {
        const c = runChanges(ctx, slug);
        if (!('error' in c)) changes = { changed: c.changed, uncommitted: c.uncommitted, files: c.files };
      }
      redCommit = redCommitOf(worktree, slug);
    }
  }
  const discarded = (readText(path.join(ctx.reg, `${slug}.discarded`)) || '').trim();
  const rawStage = typeof s.stage === 'string' ? s.stage : '';
  // The state was worked out above; working it out again would ask `ps` a second time for a running run.
  const state = stateNow;
  const stage = rawStage || (state === 'running' ? (FROM_TO_STAGE[rec?.from || 'spec'] || 'Spec') : '');
  return {
    slug,
    state,
    stage,
    agent: s.agent || '',
    model: s.model || '',
    effort: s.effort || '',
    models: s.models && typeof s.models === 'object' ? s.models : {},
    attempt: s.attempt || '',
    note: s.note || '',
    agentStarted: s.agent_started || '',
    ...stepOf(s.step),
    runStarted: s.run_started || '',
    updated: s.updated || rec?.finished || rec?.started || '',
    record: rec,
    dir,
    worktree,
    branch: rec?.branch || `${ctx.branchPrefix}${slug}`,
    base: rec?.base || '',
    message: rec?.message || '',
    questions,
    permissions: permState ? permState.pending : [],
    deniedPermissions: permState ? permState.denied.map(d => ({
      stage: d.stage || '',
      tool: d.tool,
      detail: d.detail,
      rule: d.rule || ruleFor(d.tool, { command: d.detail }, dir || ctx.root, permState.allow),
      protected: typeof d.protected === 'boolean' ? d.protected : isProtected(d.tool, d.detail),
    })) : [],
    tests: dir ? testCounts(readJson(path.join(logs, 'tests.json'))) : null,
    stageFiles: stageFiles && stageFiles.stages && typeof stageFiles.stages === 'object' ? stageFiles.stages : {},
    changes,
    tail: dir && want('tail') ? tail(path.join(logs, 'run.out'), opts.tailLines ?? 40) : [],
    docs: docFiles(docsDir),
    discarded,
    redCommit,
    gitAgeMs,
    resumeFrom: resumeStage(stage, exists(path.join(docsDir, 'test-issues.md'))),
    testIssues: exists(path.join(docsDir, 'test-issues.md')) ? readText(path.join(docsDir, 'test-issues.md')) : null,
    createPr: (() => {
      const optFile = path.join(logs, 'finalise-options.json');
      if (fs.existsSync(optFile)) {
        try { return JSON.parse(fs.readFileSync(optFile, 'utf8')).createPr === true; } catch { /* ignore */ }
      }
      return false;
    })(),
    ...(() => {
      const p = getPrFromBrief(readText(path.join(docsDir, 'brief.md')) || '')
        || getPrFromBrief(readText(path.join(ctx.root, ctx.backlogDir, slug, 'brief.md')) || '');
      if (opts.checkPr === false || !want('git') || (!p && state !== 'done' && stage.toLowerCase() !== 'finalise' && stage !== 'Resolve conflicts')) {
        return {
          pr: p || null,
          prState: null,
          prCi: null,
          prFailing: [],
          prConflicts: null,
        };
      }
      const b = rec?.branch || `${ctx.branchPrefix}${slug}`;
      // Never waits for gh: the last known status, refreshed in the background (a cold cache shows it on the next load).
      const st = getPrStatusCached(ctx.root, p || b, ctx.env, prPollOptions(ctx.env)).status;
      return {
        pr: p || (st ? st.url : null),
        prState: st ? st.state : null,
        prCi: st?.ci ?? null,
        prFailing: st?.failing ?? [],
        prConflicts: st?.conflicts ?? null,
      };
    })(),
    ci: ciView(ctx.root, ctx.env, status, readText(path.join(docsDir, 'brief.md'))),
    hasPrComments: (() => { try { return !prCommentsEmpty(fs.readFileSync(path.join(docsDir, 'pr-comments.md'), 'utf8')); } catch { return false; } })(),
    undo: (() => { const c = readCheckpoint(ctx, slug); return c ? { from: c.from, at: c.at } : null; })(),
    mergeFix: stage === 'Resolve conflicts' && ['failed', 'paused'].includes(state) ? mergeFixKept(worktree, rec?.branch || `${ctx.branchPrefix}${slug}`, logs) : false,
    ciSummary: ciSummaryOf(readText(path.join(docsDir, 'ci-failure.md')) || ''),
    // A round still marked running when the run is not running it (or runs another agent) was cut short.
    attempts: readRounds(logs).map(r => (r.running && !(state === 'running' && (s.agent || '') === r.agent) ? { ...r, running: false, warnings: [...r.warnings, 'the round did not finish: the run stopped'] } : r)),
    recovery: ['paused', 'failed', 'refused', 'stopped', 'interrupted'].includes(state)
      ? stageRecoveryHint({
          slug,
          stage,
          state,
          exitCode: rec?.exit_code ? Number(rec.exit_code) : undefined,
          docsDir,
          runOut: dir ? tail(path.join(logs, 'run.out'), 40) : [],
          questions,
          permissions: permState ? permState.pending : [],
          hasTestIssues: exists(path.join(docsDir, 'test-issues.md')),
        })
      : null,
  };
}

/** One card of the board: a run in short. */
export type RunCard = Pick<RunView, 'slug' | 'state' | 'stage' | 'agent' | 'model' | 'effort' | 'attempt' | 'note' | 'updated' | 'message' | 'tests' | 'branch'> & {
  questions: number;
  permissions: number;
  deniedPermissions?: number;
  changes: { changed: number; uncommitted: number } | null;
  /** The pull request of a finished run, as last read from GitHub (once an hour, or when the user syncs it); null for a run that is not done. */
  pullRequest: PrCard | null;
};

export interface PrCard {
  url: string | null;
  /** Null until the first check answers (or when the check failed and nothing was known). */
  state: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  number?: number;
  /** When GitHub was last asked, ISO time; null before the first answer. */
  checkedAt: string | null;
  /** The last check failed. */
  failed: boolean;
  /** The CI of the PR: null before it is known; 'none' when the PR has no checks. */
  ci: CiState | null;
  /** The names of the failing checks. */
  failing: string[];
  /** Whether the branch conflicts with its base; null before it is known. */
  conflicts: 'none' | 'conflicting' | 'unknown' | null;
}

const prCard = (url: string | null, r: PrRead): PrCard => ({
  url: r.status?.url || url,
  state: r.status ? r.status.state : null,
  ...(r.status?.number ? { number: r.status.number } : {}),
  checkedAt: r.ageMs === null ? null : new Date(Date.now() - r.ageMs).toISOString(),
  failed: Boolean(r.failed),
  ci: r.status?.ci ?? null,
  failing: r.status?.failing ?? [],
  conflicts: r.status?.conflicts ?? null,
});

/** The key GitHub is asked about for a run: the PR link in its brief, else its branch. */
function prKeyOf(ctx: RunContext, slug: string, v: Pick<RunView, 'pr' | 'branch'>): string {
  return v.pr || v.branch || `${ctx.branchPrefix}${slug}`;
}

/** Asks GitHub about the pull request of <slug> now (the "Sync PR status" button) and answers it as the board card shows it. */
export async function syncRunPr(ctx: RunContext, slug: string): Promise<PrCard> {
  const v = runView(ctx, slug, { changes: false, tailLines: 0, checkPr: false });
  return prCard(v.pr || null, await syncPrStatus(ctx.root, prKeyOf(ctx, slug, v), ctx.env));
}

export interface BoardView {
  /** The backlog items, null when the project has no backlog index. */
  items: BacklogItem[] | null;
  runs: RunCard[];
  maxParallel: number;
  running: number;
}

/** How old a card's file counts and Red tests commit may be for a run that is not running (a running run: 30 s). */
export const BOARD_GIT_MAX_AGE_MS = 60_000;

/**
 * The board: the backlog and a card for every run of this checkout (see projectSlugs). A card takes its git facts from
 * the cache the run page uses, so a board read of runs that did not move runs no git command for them.
 */
export function boardView(ctx: RunContext, opts: { changes?: boolean } = {}): BoardView {
  const backlog = backlogItems({ root: ctx.root, backlogDir: ctx.backlogDir, branchPrefix: ctx.branchPrefix }, { keepBranches: true });
  const runs = projectSlugs(ctx, { keep: true }).map((slug): RunCard => {
    const v = runView(ctx, slug, { changes: opts.changes, tailLines: 0, checkPr: false, parts: ['live', 'git'], cacheGit: true, gitMaxAgeMs: BOARD_GIT_MAX_AGE_MS });
    return {
      slug, state: v.state, stage: v.stage, agent: v.agent, model: v.model, effort: v.effort, attempt: v.attempt, note: v.note, updated: v.updated,
      message: v.message, tests: v.tests, branch: v.branch, questions: v.questions.length, permissions: v.permissions.length,
      deniedPermissions: v.deniedPermissions.length,
      changes: v.changes && { changed: v.changes.changed, uncommitted: v.changes.uncommitted },
      // Never waits for gh: the last known status, asked again at most once an hour (a cold cache fills within a poll).
      pullRequest: v.state === 'done' ? prCard(v.pr || null, getPrStatusCached(ctx.root, prKeyOf(ctx, slug, v), ctx.env, prPollOptions(ctx.env))) : null,
    };
  });
  return { items: backlog ? backlog.items : null, runs, maxParallel: ctx.maxParallel, running: runs.filter(r => r.state === 'running').length };
}
