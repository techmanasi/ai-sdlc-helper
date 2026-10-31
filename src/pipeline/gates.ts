// The checks between stages: the unit tests (through the runner adapters, a failure retried once), the integration
// suite, and test results at another commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSuites, summary, holds, type RunAll } from '../runners/run.js';
import { suiteFiles } from '../runners/files.js';
import { testRunDefaults } from '../config/settings.js';
import { spawnShell } from '../shell.js';
import type { RunResult } from '../runners/types.js';
import { at, tick, type Ctx } from './context.js';

const firstLines = (s: string | null, n = 20) => String(s || '').trim().split('\n').slice(0, n).map(l => `      ${l}`).join('\n');

/** A run's result as the agents read it in tests.log: a summary per suite, then each failure with its message. */
export function resultText(results: RunResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(summary(r), `  command: ${r.command}`);
    for (const e of r.suiteErrors) lines.push(`  ERROR ${e.file || '(unknown file)'}: failed to run`, firstLines(e.message, 40));
    for (const t of r.tests.filter(x => x.status === 'failed')) lines.push(`  FAIL  ${t.file} :: ${t.name}`, firstLines(t.message));
    for (const f of r.retried?.flaky || []) lines.push(`  FLAKY ${f.file} :: ${f.name} (failed, then passed on retry)`);
  }
  return `${lines.join('\n')}\n`;
}

/** How the gates run the suites: tests.retry (default true) and tests.maxWorkers (default: the runner's own). */
const testRuns = (ctx: Ctx) => {
  const d = testRunDefaults(ctx.config.tests).pipeline;
  return { retry: d.retry, maxWorkers: d.maxWorkers ?? undefined };
};

/** Writes test output to tests.log and tests.json, reporting any flaky tests. */
function recordResults(ctx: Ctx, r: RunAll, logFile: string): void {
  fs.writeFileSync(logFile, resultText(r.results));
  fs.writeFileSync(at(ctx, `${ctx.log}/tests.json`), `${JSON.stringify(r.merged)}\n`);
  const flaky = r.merged.retried?.flaky || [];
  for (const f of flaky) ctx.out(`WARNING: flaky test failed, then passed on retry; not counted as a failure: ${f.file} :: ${f.name}`);
  if (flaky.length) {
    fs.appendFileSync(at(ctx, `${ctx.log}/flaky-tests.md`), flaky.map(f => `${f.file} :: ${f.name} :: first run: failed :: re-run: passed\n`).join(''));
  }
}

/**
 * Test files that are known to fail or were introduced/modified for this feature:
 * 1. Failing tests or suite errors recorded in <log>/red.json.
 * 2. Failing tests or suite errors recorded in the previous attempt's <log>/tests.json.
 * 3. Test files modified or added in ctx.redSha.
 */
export function targetTestFiles(ctx: Ctx): string[] {
  const files = new Set<string>();

  const redPath = at(ctx, `${ctx.log}/red.json`);
  if (fs.existsSync(redPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(redPath, 'utf8'));
      for (const t of data.tests || []) {
        if (t.status === 'failed' && t.file) files.add(t.file);
      }
      for (const e of data.suiteErrors || []) {
        if (e.file) files.add(e.file);
      }
    } catch { /* ignore corrupted */ }
  }

  const testsJsonPath = at(ctx, `${ctx.log}/tests.json`);
  if (fs.existsSync(testsJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(testsJsonPath, 'utf8'));
      for (const t of data.tests || []) {
        if (t.status === 'failed' && t.file) files.add(t.file);
      }
      for (const e of data.suiteErrors || []) {
        if (e.file) files.add(e.file);
      }
    } catch { /* ignore corrupted */ }
  }

  if (ctx.redSha && ctx.git) {
    try {
      const changed = ctx.git.lines('diff', '--name-only', `${ctx.redSha}^`, ctx.redSha, '--', ...(ctx.layout?.testPathspecs || []));
      for (const f of changed) {
        if (f.trim()) files.add(f.trim());
      }
    } catch { /* if redSha has no parent or git error, ignore */ }
  }

  return [...files].filter(f => fs.existsSync(at(ctx, f)) && ctx.config.suites.some(s => holds(s, f)));
}

/**
 * The unit tests of every suite, in the working tree, with tests.maxWorkers. Unless tests.retry is false, a failure is
 * run once more (the failed files) before it counts;
 * tests that failed and then passed are reported as flaky (WARNING, and a line in <log>/flaky-tests.md). Writes
 * <log>/tests.log (what the agents read) and <log>/tests.json (the RunResult).
 *
 * When opts.targetFiles is provided and non-empty:
 * Executes target files first (fail-fast gate). If any target test fails, records results and returns false
 * immediately without running the full test suite. Only when target tests pass (or if all suites were covered)
 * does it proceed to run the full suite for zero-trust verification.
 */
export function testsPass(ctx: Ctx, opts: { targetFiles?: string[] } = {}): boolean {
  const logFile = at(ctx, `${ctx.log}/tests.log`);
  const targets = (opts.targetFiles || []).filter(f => ctx.config.suites.some(s => holds(s, f)));

  if (targets.length > 0) {
    const fast = runSuites(ctx.config, { root: ctx.root, ...testRuns(ctx), files: targets, env: ctx.env });
    if ('error' in fast) { fs.writeFileSync(logFile, `ERROR: ${fast.error}\n`); return false; }
    if (!fast.merged.ok) {
      recordResults(ctx, fast, logFile);
      return false;
    }
    const allFiles = ctx.config.suites.flatMap(s => suiteFiles(ctx.root, s));
    if (allFiles.length > 0 && allFiles.every(f => targets.includes(f))) {
      recordResults(ctx, fast, logFile);
      return true;
    }
  }

  const r = runSuites(ctx.config, { root: ctx.root, ...testRuns(ctx), env: ctx.env });
  if ('error' in r) { fs.writeFileSync(logFile, `ERROR: ${r.error}\n`); return false; }
  recordResults(ctx, r, logFile);
  return r.merged.ok;
}

/** Runs <cmd> with bash from the root (a POSIX shell or cmd.exe on Windows), its output in <logFile>; resolves its exit code. */
function shToFile(ctx: Ctx, cmd: string, logFile: string): Promise<number> {
  return new Promise(resolve => {
    const fd = fs.openSync(logFile, 'w');
    let done = false;
    const finish = (code: number) => { if (!done) { done = true; fs.closeSync(fd); resolve(code); } };
    const child = spawnShell(cmd, { bash: true, cwd: ctx.root, env: ctx.env, stdio: ['ignore', fd, fd], signal: ctx.signal });
    child.on('error', () => finish(127));
    child.on('close', code => finish(code === null ? 1 : code));
  });
}

/**
 * The integration suite: integration.cmd from the settings (none: nothing to run), output in <log>/integration.log. In CI
 * it is skipped with a warning unless SDLC_INTEGRATION_CI=run (or integration.ci "run" in the settings).
 */
export async function integrationPass(ctx: Ctx): Promise<boolean> {
  const integration = ctx.config.integration;
  if (!integration || !integration.cmd) return true;
  const logFile = at(ctx, `${ctx.log}/integration.log`);
  if (ctx.env.CI && (ctx.env.SDLC_INTEGRATION_CI || integration.ci || 'skip') !== 'run') {
    const warning = 'WARNING: integration tests skipped in CI; set SDLC_INTEGRATION_CI=run (or integration.ci "run") once CI can run them.';
    ctx.out(warning);
    fs.writeFileSync(logFile, `${warning}\n`);
    return true;
  }
  return (await shToFile(ctx, integration.cmd, logFile)) === 0;
}

/** The unit tests, then the integration suite; ctx.failLog names the log of the check that failed. */
export async function successCheck(ctx: Ctx, opts: { targetFiles?: string[] } = {}): Promise<boolean> {
  await tick();
  const targets = opts.targetFiles ?? targetTestFiles(ctx);
  const unit = testsPass(ctx, { targetFiles: targets });
  await tick();
  if (!unit) { ctx.failLog = `${ctx.log}/tests.log`; return false; }
  if (!(await integrationPass(ctx))) { ctx.failLog = `${ctx.log}/integration.log`; return false; }
  return true;
}

/** Writes the RunResult of the tests in <root> (every suite) to <out>; nothing when no suite runs. */
function writeResults(ctx: Ctx, root: string, out: string): void {
  try {
    const r = runSuites(ctx.config, { root, maxWorkers: testRuns(ctx).maxWorkers, env: ctx.env });
    if (!('error' in r)) fs.writeFileSync(out, `${JSON.stringify(r.merged)}\n`);
  } catch { /* the checks that read <out> report it */ }
}

/** The test results of the working tree, in <outRel>. */
export const resultsNow = (ctx: Ctx, outRel: string): void => writeResults(ctx, ctx.root, at(ctx, outRel));

/**
 * The test results on <sha>'s source, with <files> copied from the working tree, in <outRel>. The commit is checked out
 * in a temporary worktree that shares the settings' worktree links (node_modules and the like).
 */
export function resultsAt(ctx: Ctx, sha: string, outRel: string, files: string[] = []): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-at-'));
  const wt = path.join(tmp, 'wt');
  ctx.git.run('worktree', 'add', '-q', '--detach', wt, sha);
  try {
    for (const p of ctx.config.worktree.link) {
      if (fs.existsSync(at(ctx, p)) && !fs.existsSync(path.join(wt, p))) {
        fs.mkdirSync(path.dirname(path.join(wt, p)), { recursive: true });
        fs.symlinkSync(at(ctx, p), path.join(wt, p));
      }
    }
    for (const f of files.filter(x => fs.existsSync(at(ctx, x)))) {
      fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
      fs.copyFileSync(at(ctx, f), path.join(wt, f));
    }
    writeResults(ctx, wt, at(ctx, outRel));
  } finally {
    ctx.git.tryRun('worktree', 'remove', '--force', wt);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
