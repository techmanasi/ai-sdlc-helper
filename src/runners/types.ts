import fs from 'node:fs';
import path from 'node:path';
import type { spawnSync } from 'node:child_process';
import { shellQuote } from '../util.js';

export type TestStatus = 'passed' | 'failed' | 'skipped';

/** One test: its file from the project root, describe titles and test title joined by spaces, status and failure message. */
export interface TestCase {
  file: string | null;
  name: string;
  status: TestStatus;
  message: string | null;
}

/** A test file that failed to load (file is null when the runner does not say which). */
export interface SuiteError {
  file: string | null;
  message: string;
}

/** What a parser reads from a runner's own report. */
export interface RunParts {
  tests: TestCase[];
  suiteErrors: SuiteError[];
}

/** The outcome of a run in one shape, whatever the runner. */
export interface RunResult extends RunParts {
  runner: string;
  suite: string;
  /** Exit code 0, no test failed and no file failed to load. */
  ok: boolean;
  exitCode: number;
  command: string;
  /** The runner wrote no report: suiteErrors holds its output. */
  noReport?: boolean;
  /** With `retry`: the files run a second time, and the tests that failed first and passed then. */
  retried?: { files: string[]; flaky: { file: string | null; name: string }[] };
}

export type Spawn = typeof spawnSync;

export const posix = (p: string): string => p.split(path.sep).join('/');
export const realpath = (p: string): string => { try { return fs.realpathSync(p); } catch { return p; } };

/** <file> relative to <root>; runners may report the resolved path of a root reached through a symlink (macOS /var). */
export function relTo(root: string, file: string | null | undefined): string | null {
  if (!file) return null;
  const abs = path.resolve(root, file);
  let r = path.relative(root, abs);
  if (r.startsWith('..')) { const alt = path.relative(realpath(root), realpath(abs)); if (!alt.startsWith('..')) r = alt; }
  return posix(r);
}

/** A test name with Jest's "›", Vitest's ">", or "->" hierarchy separators and runs of whitespace collapsed to single spaces. */
export const norm = (s: unknown): string => String(s || '').replace(/\s*›\s*|\s+(?:>|->)\s+/g, ' ').replace(/\s+/g, ' ').trim();

/** A suite as the adapters need it (a resolved Suite has all of it; runCmd falls back to testCmd). */
export interface RunSuite {
  name: string;
  dir: string;
  runner: string;
  packageManager: string;
  testGlobs: string[];
  testCmd: string;
  runCmd?: string;
  report?: string | null;
}

export interface ShResult { status: number; stdout: string; stderr: string }

/** What an adapter gets for one run. */
export interface RunContext {
  suite: RunSuite;
  /** The project root (resolved), which may be another checkout of the project. */
  root: string;
  /** The suite's folder. */
  cwd: string;
  /** The files to run, from the root; empty for the whole suite. */
  files: string[];
  /** The same files from the suite folder, quoted for sh. */
  inSuite: string[];
  /** Full test names to run; empty for every test in the files. */
  names: string[];
  /** Where the runner writes its report. */
  out: string;
  /** A temporary folder, removed after the run. */
  tmp: string;
  /** How the package manager runs a package's binary (npx, pnpm exec, yarn, bunx). */
  exec: string;
  /** The environment the commands run with. */
  env: NodeJS.ProcessEnv;
  /** The most test workers, when limited. */
  maxWorkers?: number;
  /** <cmd> run with the project's Node (unchanged when it is the current one). */
  wrap(cmd: string): string;
  /** Runs a command with sh, in the suite folder unless <where> says otherwise. */
  sh(command: string, where?: string, extraEnv?: NodeJS.ProcessEnv): ShResult;
  read(file: string): string | null;
}

/** What an adapter reports; the caller narrows it to the files asked for and works out `ok`. */
export interface AdapterResult {
  command: string;
  exitCode: number;
  parts: RunParts;
  noReport?: boolean;
}

export type Adapter = (ctx: RunContext) => AdapterResult;

/** A word quoted for sh, always. */
export const q = shellQuote;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A regular expression matching exactly the given full test names. */
export const namePattern = (names: string[]): string => `^(?:${names.map(escapeRe).join('|')})$`;

/** A run that wrote no report: its output becomes the one suite error. */
export const noReport = (command: string, r: ShResult): AdapterResult => ({
  command, exitCode: r.status, noReport: true,
  parts: { tests: [], suiteErrors: [{ file: null, message: `${r.stdout}${r.stderr}`.trim().slice(-4000) || 'no report' }] },
});
