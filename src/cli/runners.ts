// The run, parse-report and testcheck commands: run test suites through the runner adapters, convert a runner's report,
// and the mechanical checks of the Test repair stage.
import fs from 'node:fs';
import path from 'node:path';
import { resolve, testRunDefaults, workerLimit } from '../config/settings.js';
import { parseJestLike } from '../runners/jest.js';
import { parseJUnit } from '../runners/junit.js';
import { mochaCrashFile, parseMocha } from '../runners/mocha.js';
import { parseNodeTest } from '../runners/nodeTest.js';
import { runSuites, summary } from '../runners/run.js';
import type { RunParts, RunResult } from '../runners/types.js';
import {
  diffcheck, mergeRetry, namecheck, precheck, redcheck, resumecheck, retryArgs, retryPlan, unclaimed,
} from '../testcheck/checks.js';
import { Keys, layoutFromEnv, testLayout } from '../testcheck/keys.js';
import { rel } from '../util.js';
import type { Io } from './main.js';

export const RUNNER_COMMANDS = ['run', 'parse-report', 'testcheck'];
export const RUNNER_VALUED = ['--out', '--suite', '--cwd', '--file', '--test', '--root', '--stderr', '--max-workers'];
export const RUNNER_FLAGS = ['--retry', '--no-retry', '--json'];

export const RUNNER_USAGE = `  run [dir] [--file <f>]... [--test <full name>]... [--suite <name>] [--out <result.json>] [--json]
      [--retry | --no-retry] [--max-workers <n|auto>] [--cwd <checkout>]
                                   run the tests (all suites, or those holding the files) and report one RunResult;
                                   --retry runs failed files once more, --max-workers limits jest/vitest workers
                                   (defaults: tests.retry and tests.maxWorkers in the settings);
                                   exit 0 passed, 1 failed, 3 no report
  parse-report jest|vitest|mocha|node-test|junit <report> [--root <dir>] [--stderr <file>]
                                   a runner's own report as RunResult tests and suiteErrors (JSON)
  testcheck <check> ...            Test repair checks (exit 1 with REJECT lines): precheck <now.json> <test-issues.md> <max>,
                                   diffcheck <red_sha> <test-issues.md>, namecheck <red.json> <now.json>,
                                   redcheck <red.json> <repaired.json> [<test-issues.md>], claimed <test-issues.md>,
                                   unclaimed <now.json> <test-issues.md>, retry-plan [key]..., retry-args [key]...,
                                   merge-retry <now.json> <test-issues.md> <flaky.md> <retry.json>...,
                                   resumecheck <red_sha> <test-issues.md> <slug> [<lock_sha>]
                                   (keys come from stdin when none are given; the test layout from SDLC_TEST_DIRS,
                                   SDLC_KEY_DIR and SDLC_TEST_PATHSPECS, else from the settings)`;

/** The command line's option values (every occurrence) and the words that are not options. */
function parse(argv: string[]) {
  const valueAt = new Set(argv.flatMap((a, i) => (RUNNER_VALUED.includes(a) ? [i + 1] : [])));
  return {
    positional: argv.filter((a, i) => !a.startsWith('--') && !valueAt.has(i)),
    many: (name: string) => argv.flatMap((a, i) => (a === name && i + 1 < argv.length ? [argv[i + 1]] : [])),
    one: (name: string): string | undefined => argv.flatMap((a, i) => (a === name ? [argv[i + 1] ?? ''] : []))[0],
    flag: (name: string) => argv.includes(name),
  };
}

const firstLines = (s: string | null, n = 6) => String(s || '').trim().split('\n').slice(0, n).map(l => `      ${l}`).join('\n');

function printDetails(io: Io, r: RunResult): void {
  for (const e of r.suiteErrors) io.out(`  ERROR ${e.file || '(unknown file)'}: failed to run\n${firstLines(e.message)}`);
  for (const t of r.tests.filter(x => x.status === 'failed')) io.out(`  FAIL  ${t.file} :: ${t.name}\n${firstLines(t.message)}`);
  for (const f of r.retried?.flaky || []) io.out(`  FLAKY ${f.file} :: ${f.name} (failed, then passed on retry)`);
}

function runCommand(io: Io, argv: string[], cwd: string, env: NodeJS.ProcessEnv): number {
  const a = parse(argv);
  const dir = path.resolve(cwd, a.positional[1] || '.');
  if (!fs.existsSync(dir)) { io.err(`ERROR: ${dir} does not exist`); return 2; }
  const workersArg = a.one('--max-workers');
  const workersOpt = workersArg === undefined || workersArg === 'auto' ? workersArg : Number(workersArg);
  if (typeof workersOpt === 'number' && !(Number.isInteger(workersOpt) && workersOpt > 0)) { io.err('ERROR: --max-workers needs a whole number above 0 or "auto"'); return 2; }
  if (a.flag('--retry') && a.flag('--no-retry')) { io.err('ERROR: use --retry or --no-retry, not both'); return 2; }
  const { config, errors, warnings } = resolve(dir, { env });
  for (const w of warnings) io.err(`WARNING: ${w}`);
  if (errors.length || !config) { for (const e of errors) io.err(`ERROR: ${e}`); return 2; }
  const root = path.resolve(cwd, a.one('--cwd') || dir);
  const files = a.many('--file').map(f => (path.isAbsolute(f) ? rel(root, f) : f.replace(/^\.\//, '')));
  // The flags override the settings (testRunDefaults: without tests.retry, `run` does not retry).
  const defaults = testRunDefaults(config.tests).run;
  const retry = a.flag('--retry') || (!a.flag('--no-retry') && defaults.retry);
  const maxWorkers = workersOpt === undefined ? (defaults.maxWorkers ?? undefined) : workerLimit(workersOpt as number | 'auto');
  const r = runSuites(config, {
    root, files, names: a.many('--test'), suite: a.one('--suite'), retry, maxWorkers, env,
  });
  if ('error' in r) { io.err(`ERROR: ${r.error}`); return 2; }
  const out = a.one('--out');
  if (out) fs.writeFileSync(path.resolve(cwd, out), JSON.stringify(r.merged) + '\n');
  if (a.flag('--json')) io.out(JSON.stringify(r.merged, null, 2));
  else {
    for (const x of r.results) io.out(summary(x));
    if (!out) for (const x of r.results) printDetails(io, x);
  }
  return r.merged.noReport ? 3 : r.merged.ok ? 0 : 1;
}

function parseCommand(io: Io, argv: string[], cwd: string): number {
  const a = parse(argv);
  const [, runner, file] = a.positional;
  if (!runner || !file) { io.err('ERROR: parse-report needs a runner and a report file'); return 2; }
  const root = path.resolve(cwd, a.one('--root') || '.');
  const reportFile = path.resolve(cwd, file);
  const text = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, 'utf8') : '';
  let parts: RunParts;
  try {
    if (runner === 'jest' || runner === 'vitest') parts = parseJestLike(JSON.parse(text), { root });
    else if (runner === 'mocha') {
      if (text) parts = parseMocha(JSON.parse(text), { root });
      else {
        const errFile = a.one('--stderr');
        const err = errFile ? fs.readFileSync(path.resolve(cwd, errFile), 'utf8') : '';
        parts = { tests: [], suiteErrors: [{ file: mochaCrashFile(err, root), message: err.trim().slice(-4000) }] };
      }
    } else if (runner === 'node-test') parts = parseNodeTest(text, { root });
    else if (runner === 'junit' || runner === 'generic-junit') parts = parseJUnit(text, { root });
    else { io.err(`ERROR: unknown runner "${runner}" (jest, vitest, mocha, node-test, junit)`); return 2; }
  } catch (e) { io.err(`ERROR: ${file}: ${(e as Error).message}`); return 1; }
  io.out(JSON.stringify({ runner, ...parts }, null, 2));
  return 0;
}

const CHECK_ARGS: Record<string, [number, string]> = {
  claimed: [1, '<test-issues.md>'],
  unclaimed: [2, '<now.json> <test-issues.md>'],
  'retry-plan': [0, '[key]...'],
  'retry-args': [0, '[key]...'],
  'merge-retry': [3, '<now.json> <test-issues.md> <flaky-tests.md> <retry.json>...'],
  precheck: [2, '<now.json> <test-issues.md> [max]'],
  diffcheck: [2, '<red_sha> <test-issues.md>'],
  namecheck: [2, '<red.json> <now.json>'],
  redcheck: [2, '<red.json> <repaired-on-red.json> [<test-issues.md>]'],
  resumecheck: [3, '<red_sha> <test-issues.md> <slug> [<lock_sha>]'],
};

function testcheckCommand(io: Io & { stdin?: () => string }, argv: string[], cwd: string, env: NodeJS.ProcessEnv): number {
  const [, check, ...args] = parse(argv).positional;
  const spec = check === undefined ? undefined : CHECK_ARGS[check];
  if (!spec) { io.err(`usage: ai-sdlc-helper testcheck ${Object.keys(CHECK_ARGS).join('|')} ...`); return 2; }
  if (args.length < spec[0]) { io.err(`usage: ai-sdlc-helper testcheck ${check} ${spec[1]}`); return 2; }
  let layout = layoutFromEnv(env);
  if (!layout) {
    const { config, errors } = resolve(cwd, { env });
    if (!config) { for (const e of errors) io.err(`ERROR: ${e}`); io.err('ERROR: no test layout: set SDLC_TEST_DIRS or run in a project with settings'); return 2; }
    layout = testLayout(config);
  }
  const k = new Keys(layout, cwd);
  const keysIn = () => (args.length ? args : (io.stdin ? io.stdin() : fs.readFileSync(0, 'utf8')).split('\n').filter(Boolean));
  const reject = (errs: string[]) => { if (errs.length) io.err(errs.map(m => `REJECT: ${m}`).join('\n')); return errs.length ? 1 : 0; };
  const [a, b, c] = args;
  try {
    switch (check) {
      case 'claimed': for (const x of k.claims(a)) io.out(x.key); return 0;
      case 'unclaimed': for (const key of unclaimed(k, a, b)) io.out(key); return 0;
      case 'retry-plan': for (const [file, pat] of retryPlan(keysIn())) io.out(`${file}\t${pat}`); return 0;
      case 'retry-args': for (const line of retryArgs(k, keysIn())) io.out(line.join('\t')); return 0;
      case 'merge-retry':
        for (const key of mergeRetry(k, a, b, c, args.slice(3))) io.out(`WARNING: flaky test passed on re-run, not rejected: ${key}`);
        return 0;
      case 'precheck': return reject(precheck(k, a, b, Number(c || 3)));
      case 'diffcheck': return reject(diffcheck(k, a, b));
      case 'namecheck': return reject(namecheck(k, a, b));
      case 'redcheck': return reject(redcheck(k, a, b, c));
      default: return reject(resumecheck(k, a, b, c, args[3]));
    }
  } catch (e) { io.err(`ERROR: ${(e as Error).message}`); return 1; }
}

/** Runs one of RUNNER_COMMANDS (<argv> starts with it). Returns the exit code. */
export function runners(argv: string[], io: Io & { stdin?: () => string }): number {
  const env = io.env || process.env;
  const cwd = io.cwd || process.cwd();
  const cmd = parse(argv).positional[0];
  if (cmd === 'run') return runCommand(io, argv, cwd, env);
  if (cmd === 'parse-report') return parseCommand(io, argv, cwd);
  return testcheckCommand(io, argv, cwd, env);
}
