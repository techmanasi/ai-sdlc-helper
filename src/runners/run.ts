import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { wrapCommand, type NodeRun } from '../config/node.js';
import { shellArgv } from '../shell.js';
import { jestAdapter } from './jest.js';
import { junitAdapter } from './junit.js';
import { mochaAdapter } from './mocha.js';
import { nodeTestAdapter } from './nodeTest.js';
import { vitestAdapter } from './vitest.js';
import { posix, q, realpath, relTo, type Adapter, type RunContext, type RunResult, type RunSuite, type Spawn } from './types.js';

/** One adapter per runner. */
export const ADAPTERS: Record<string, Adapter> = {
  jest: jestAdapter, vitest: vitestAdapter, mocha: mochaAdapter, 'node-test': nodeTestAdapter, 'generic-junit': junitAdapter,
};

const EXEC: Record<string, string> = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' };

export interface RunOptions {
  /** The project root; may be another checkout of the project (a worktree at an older commit). */
  root: string;
  /** Test files from the root: only they run (the adapter's file filter), e.g. one file for a stage agent. */
  files?: string[];
  /** Full test names (describe titles and test title joined by spaces): only they run, where the runner can pick them. */
  names?: string[];
  /**
   * Flaky-suite guard, off by default: when the run fails, run the failed files once more (the whole run when a failure
   * names no file) and report the second outcome for them. Tests that failed first and passed then are listed in
   * `retried.flaky`.
   */
  retry?: boolean;
  /** Limits the test workers, off by default: jest and vitest `--maxWorkers`; mocha and node:test have no such limit. */
  maxWorkers?: number;
  /** How the project's commands run (Config.node): built runner commands switch Node the way the suite's runCmd does. */
  node?: Pick<NodeRun, 'switchTo' | 'manager'> | null;
  spawn?: Spawn;
  env?: NodeJS.ProcessEnv;
}

/** Runs <suite> once; files and names narrow the run. */
function runOnce(suite: RunSuite, opts: RunOptions): RunResult {
  const adapter = ADAPTERS[suite.runner];
  if (!adapter) throw new Error(`no adapter for runner ${suite.runner}`);
  const { files = [], names = [], spawn = spawnSync, env = process.env, node } = opts;
  const root = realpath(path.resolve(opts.root));
  const cwd = path.join(root, suite.dir);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-run-'));
  const ctx: RunContext = {
    suite, root, cwd, files, names, env, tmp,
    out: path.join(tmp, 'report'),
    inSuite: files.map(f => q(posix(path.relative(cwd, path.resolve(root, f))))),
    exec: EXEC[suite.packageManager] || 'npx',
    maxWorkers: opts.maxWorkers,
    wrap: cmd => (node && node.switchTo && node.manager ? wrapCommand(cmd, node.switchTo, node.manager) : cmd),
    sh: (command, where = cwd, extraEnv = {}) => {
      const a = shellArgv(command, { env });
      const runnerEnv = { ...env, ...extraEnv };
      delete runnerEnv.WATCH_REPORT_DEPENDENCIES;
      const r = spawn(a.file, a.args, {
        cwd: where, encoding: 'utf8', env: runnerEnv, maxBuffer: 256 * 1024 * 1024, windowsVerbatimArguments: a.windowsVerbatimArguments,
      });
      return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    },
    read: f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
  };
  try {
    const { command, exitCode, parts, noReport } = adapter(ctx);
    const narrowed = files.length ? new Set(files.map(f => relTo(root, f))) : null;
    const tests = parts.tests.filter(t => !narrowed || narrowed.has(t.file));
    const suiteErrors = parts.suiteErrors.filter(e => !narrowed || !e.file || narrowed.has(e.file));
    const ok = exitCode === 0 && !suiteErrors.length && !tests.some(t => t.status === 'failed');
    return { runner: suite.runner, suite: suite.name, ok, exitCode, command, tests, suiteErrors, ...(noReport ? { noReport } : {}) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs <suite> at opts.root and reports a RunResult; with `retry`, failed files run once more first. */
export function runSuite(suite: RunSuite, opts: RunOptions): RunResult {
  const first = runOnce(suite, opts);
  if (!opts.retry || first.ok || first.noReport) return first;
  const failing = [...first.tests.filter(t => t.status === 'failed').map(t => t.file), ...first.suiteErrors.map(e => e.file)];
  const whole = !failing.length || failing.includes(null);
  const files = whole ? (opts.files || []) : [...new Set(failing as string[])];
  const again = runOnce(suite, { ...opts, files });
  if (again.noReport) return { ...first, retried: { files, flaky: [] } };
  const redone = new Set(files);
  const kept = (f: string | null) => !whole && !redone.has(f as string);
  const passedAgain = new Set(again.tests.filter(t => t.status === 'passed').map(t => `${t.file}\0${t.name}`));
  const flaky = first.tests.filter(t => t.status === 'failed' && passedAgain.has(`${t.file}\0${t.name}`)).map(t => ({ file: t.file, name: t.name }));
  const tests = [...first.tests.filter(t => kept(t.file)), ...again.tests];
  const suiteErrors = [...first.suiteErrors.filter(e => kept(e.file)), ...again.suiteErrors];
  const ok = again.exitCode === 0 && !suiteErrors.length && !tests.some(t => t.status === 'failed');
  return {
    ...first, ok, exitCode: again.exitCode, command: `${first.command} ; retry: ${again.command}`, tests, suiteErrors,
    retried: { files: whole ? ['(all)'] : files, flaky },
  };
}

/** Whether <file> (from the root) is in <suite>'s folder. */
export const holds = (suite: Pick<RunSuite, 'dir'>, file: string): boolean =>
  suite.dir === '.' || file === suite.dir || file.startsWith(`${suite.dir}/`);

export interface RunAll {
  results: RunResult[];
  /** The results as one: the only one, or all of them merged. */
  merged: RunResult;
}

/**
 * Runs the suites of <config>: the one named <suite>, else every suite (with files, only those holding the files), and
 * merges their results. Returns an error when no suite matches.
 */
export function runSuites(
  config: { suites: RunSuite[]; node?: RunOptions['node'] },
  opts: RunOptions & { suite?: string },
): RunAll | { error: string } {
  const files = opts.files || [];
  const suites = opts.suite ? config.suites.filter(s => s.name === opts.suite) : config.suites.filter(s => !files.length || files.some(f => holds(s, f)));
  if (!suites.length) {
    return { error: `no suite ${opts.suite ? `"${opts.suite}"` : `holds ${files.join(', ')}`} (suites: ${config.suites.map(s => `${s.name} in ${s.dir}`).join(', ')})` };
  }
  const results = suites.map(s => runSuite(s, { node: config.node, ...opts, files: files.filter(f => holds(s, f)) }));
  return { results, merged: mergeResults(results) };
}

/** Several suites' results as one RunResult. */
export function mergeResults(results: RunResult[]): RunResult {
  if (results.length === 1) return results[0];
  const failed = results.find(x => x.exitCode);
  const retried = results.filter(x => x.retried);
  return {
    runner: results.map(x => x.runner).join('+'), suite: results.map(x => x.suite).join('+'), ok: results.every(x => x.ok),
    exitCode: failed ? failed.exitCode : 0, command: results.map(x => x.command).join(' ; '),
    tests: results.flatMap(x => x.tests), suiteErrors: results.flatMap(x => x.suiteErrors),
    ...(results.some(x => x.noReport) ? { noReport: true } : {}),
    ...(retried.length ? { retried: { files: retried.flatMap(x => x.retried!.files), flaky: retried.flatMap(x => x.retried!.flaky) } } : {}),
  };
}

/** One line per result: "<suite> (<runner>): n passed, n failed, n skipped, n file errors". */
export function summary(r: RunResult): string {
  const count = (st: string) => r.tests.filter(t => t.status === st).length;
  const flaky = r.retried && r.retried.flaky.length ? `; ${r.retried.flaky.length} flaky (failed, then passed on retry)` : '';
  return `${r.suite} (${r.runner}): ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped, ${r.suiteErrors.length} file errors${flaky}`;
}
