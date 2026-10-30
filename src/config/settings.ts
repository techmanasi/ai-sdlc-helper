import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILE, exists, readJson, type Json } from '../util.js';
import {
  DEFAULT_GLOBS, RUNNERS, detect, detectPackage, isTypeScript, packageGlobs, packageManager, runnerCommand,
  type Language, type PackageManager, type Runner,
} from './detect.js';
import { INDEXER_SCHEMA, codeSearchErrors, codeSearchFor, type CodeIndexer } from './codeSearch.js';
import { expandGlob, globToRegex } from './globs.js';
import { NODE_MANAGERS, nodeRun, wrapCommand, type NodeRun } from './node.js';

export interface Suite {
  name: string;
  dir: string;
  runner: Runner;
  language: Language;
  packageManager: PackageManager;
  /** The test command as the project writes it, run from the project root. */
  testCmd: string;
  /** The test command as the pipeline and the agents run it (with the project's Node when it differs). */
  runCmd: string;
  testGlobs: string[];
  sourceGlobs: string[];
  setup: string | null;
  report: string | null;
}

export interface Config {
  root: string;
  backlogDir: string;
  suites: Suite[];
  integration: { cmd: string | null; ci: 'run' | 'skip' } | null;
  tests: TestRuns;
  lint: string | null;
  worktree: { base: string; link: string[] };
  git: { branchPrefix: string; base: string | null; conflictSuffixStart: number };
  agent: { allowCommands: string[]; codeSearch: string; codeIndexer: CodeIndexer | null };
  finalise: { envExample: boolean; maxFileBytes: number };
  ship: { envExample: boolean; maxFileBytes: number };
  ui: { timezone: string };
  node: NodeRun;
}

/**
 * How the suites run, for the whole project rather than per suite: retrying and the worker limit are about the machine
 * and the pipeline's load (several runs at once), not about one suite, and the limit only applies to jest and vitest
 * anyway (mocha and node:test have none), so one block keeps the settings short.
 */
export interface TestRuns {
  /**
   * Run failed files once more before a failure counts (flaky tests are reported). null (not set): the pipeline gates
   * retry, `ai-sdlc-helper run` does not, so an agent checking one file sees the first outcome at once. true or false
   * applies to both; `run --retry` / `--no-retry` override it.
   */
  retry: boolean | null;
  /** The jest/vitest worker limit: a number, "auto" (half the CPUs, at least 1), or null (the runner's own default). */
  maxWorkers: number | 'auto' | null;
}

/** The worker count for a maxWorkers setting: undefined for no limit, "auto" as half the CPUs (at least 1). */
export function workerLimit(setting: TestRuns['maxWorkers'] | undefined, cpus: number = os.availableParallelism()): number | undefined {
  if (setting === null || setting === undefined) return undefined;
  return setting === 'auto' ? Math.max(1, Math.floor(cpus / 2)) : setting;
}

/** What tests.retry and tests.maxWorkers come to: for the pipeline gates and for `ai-sdlc-helper run` without flags. */
export function testRunDefaults(tests: TestRuns | undefined, cpus?: number): Record<'pipeline' | 'run', { retry: boolean; maxWorkers: number | null }> {
  const maxWorkers = workerLimit(tests?.maxWorkers, cpus) ?? null;
  return {
    pipeline: { retry: tests?.retry ?? true, maxWorkers },
    run: { retry: tests?.retry ?? false, maxWorkers },
  };
}

export interface Resolved {
  config: Config | null;
  errors: string[];
  warnings: string[];
  file: string | null;
}

const SUITE_SCHEMA = {
  name: 'string', dir: 'string', runner: [...RUNNERS, 'auto'], testCmd: 'string',
  testGlobs: 'string[]', sourceGlobs: 'string[]', setup: 'string', report: 'string',
};
export const SCHEMA: Json = {
  $schema: 'string',
  backlogDir: 'string',
  suites: [SUITE_SCHEMA],
  integration: { cmd: 'string', ci: ['run', 'skip'] },
  tests: { retry: 'boolean', maxWorkers: 'workers' },
  lint: 'string',
  worktree: { base: 'string', link: 'string[]' },
  git: { branchPrefix: 'string', base: 'string', conflictSuffixStart: 'integer' },
  agent: { allowCommands: 'string[]', codeSearch: 'string', codeSearchOrder: 'string[]', codeIndexers: { '*': INDEXER_SCHEMA } },
  finalise: { envExample: 'boolean', maxFileBytes: 'integer' },
  ship: { envExample: 'boolean', maxFileBytes: 'integer' },
  ui: { timezone: 'string' },
  node: { version: 'string', manager: ['auto', ...NODE_MANAGERS, 'none'] },
};

/** Every way <value> breaks <schema>, as "path: problem" lines. `{ '*': schema }` is a map: any key, each value checked. */
export function validate(value: unknown, schema: any, where: string, errors: string[]): string[] {
  const at = where || '(top level)';
  if (Array.isArray(schema) && typeof schema[0] === 'object') {
    if (!Array.isArray(value)) { errors.push(`${at}: must be a list`); return errors; }
    value.forEach((v, i) => validate(v, schema[0], `${where}[${i}]`, errors));
  } else if (Array.isArray(schema)) {
    if (!schema.includes(value)) errors.push(`${at}: must be one of ${schema.join(', ')} (got ${JSON.stringify(value)})`);
  } else if (schema === 'string[]') {
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v)) errors.push(`${at}: must be a list of non-empty strings`);
  } else if (schema === 'workers') {
    if (value !== null && value !== 'auto' && !(Number.isInteger(value) && (value as number) > 0)) {
      errors.push(`${at}: must be a whole number above 0, "auto" or null (got ${JSON.stringify(value)})`);
    }
  } else if (schema === 'integer') {
    if (!Number.isInteger(value) || (value as number) < 0) errors.push(`${at}: must be a whole number`);
  } else if (schema === 'string') {
    if (typeof value !== 'string' || !value) errors.push(`${at}: must be a non-empty string`);
  } else if (schema === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${at}: must be true or false`);
  } else {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${at}: must be an object`); return errors; }
    for (const k of Object.keys(value)) {
      const p = where ? `${where}.${k}` : k;
      if (!schema['*'] && !Object.prototype.hasOwnProperty.call(schema, k)) errors.push(`${p}: unknown setting`);
      else validate((value as Json)[k], schema['*'] || schema[k], p, errors);
    }
  }
  return errors;
}

const systemTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const validTimezone = (tz: string) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

/** A suite from the file, completed from detection in its folder and the runner's defaults. */
function completeSuite(s: Json, i: number, root: string, errors: string[]): Omit<Suite, 'runCmd'> | null {
  const where = `suites[${i}]`;
  const dir = String(s.dir || '.').replace(/\/+$/, '') || '.';
  const abs = path.resolve(root, dir);
  if (!exists(abs) || !fs.statSync(abs).isDirectory()) { errors.push(`${where}.dir: folder ${dir} does not exist`); return null; }
  const found = detectPackage(abs, root);
  let runner: string = s.runner || 'auto';
  if (runner === 'auto') {
    if (!found) { errors.push(`${where}: no test runner found in ${dir}; set "runner"`); return null; }
    if (found.unknown) { errors.push(`${where}: the test script in ${dir} uses a runner that is not recognised; set "runner"`); return null; }
    if (!found.runner) { errors.push(`${where}: ${dir} matches ${found.candidates.join(' and ')} equally; set "runner"`); return null; }
    runner = found.runner;
  }
  if (runner === 'generic-junit' && (!s.testCmd || !s.report)) {
    errors.push(`${where}: runner generic-junit needs "testCmd" and "report" (the JUnit XML file it writes)`);
    return null;
  }
  const r = runner as Runner;
  const pm = found?.packageManager ?? packageManager(abs, root);
  const sameRunner = found && found.runner === r;
  let pkg: Json = {};
  try { pkg = readJson(path.join(abs, 'package.json')); } catch { /* none */ }
  return {
    name: s.name || (dir === '.' ? path.basename(root) : dir),
    dir, runner: r,
    language: found?.language ?? (isTypeScript(abs, root, {}) ? 'typescript' : 'javascript'),
    packageManager: pm,
    testCmd: s.testCmd || (sameRunner && found?.testCmd ? found.testCmd : runnerCommand(r, pm, dir)),
    testGlobs: s.testGlobs || (sameRunner && found?.testGlobs ? found.testGlobs : (packageGlobs(r, pkg, abs) || DEFAULT_GLOBS[r])),
    sourceGlobs: s.sourceGlobs || ['**'],
    setup: s.setup || null,
    report: s.report || null,
  };
}

/** The resolved settings for the project at <root>. `errors` is empty when the settings are usable. */
export function resolve(root: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Resolved {
  root = path.resolve(root);
  const errors: string[] = [];
  const warnings: string[] = [];
  const fileName = path.join(root, CONFIG_FILE);
  let file: Json = {};
  const hasFile = exists(fileName);
  if (hasFile) {
    try { file = readJson(fileName); } catch (e) {
      return { config: null, errors: [`${CONFIG_FILE}: not valid JSON (${(e as Error).message})`], warnings, file: fileName };
    }
    validate(file, SCHEMA, '', errors);
    if (!errors.length) errors.push(...codeSearchErrors(file));
    if (errors.length) return { config: null, errors: errors.map(e => `${CONFIG_FILE}: ${e}`), warnings, file: fileName };
  }

  let suites: (Omit<Suite, 'runCmd'> | null)[];
  if (file.suites && file.suites.length) {
    suites = file.suites.map((s: Json, i: number) => completeSuite(s, i, root, errors));
  } else {
    const found = detect(root);
    const known = found.filter(f => !f.unknown);
    for (const f of found.filter(f => f.unknown)) {
      warnings.push(`${f.dir}: skipped, its test script uses a runner that is not recognised (${f.evidence[0]}); add it to "suites" with a "runner"`);
    }
    if (!known.length) errors.push(`no test suite found; add "suites" to ${CONFIG_FILE}, or see suggestions with: ai-sdlc-helper suggest`);
    for (const f of known) {
      if (!f.runner) errors.push(`${f.dir} matches ${f.candidates.join(' and ')} equally; set its "runner" in ${CONFIG_FILE}`);
    }
    suites = known.filter(f => f.runner).map((f, i) => completeSuite({ dir: f.dir, runner: f.runner, name: f.name }, i, root, errors));
  }
  const node = nodeRun(root, file.node || {}, env);
  if (node.warning) warnings.push(node.warning);
  const run = (cmd: string) => (node.switchTo && node.manager ? wrapCommand(cmd, node.switchTo, node.manager) : cmd);
  const done: Suite[] = suites.filter((s): s is Omit<Suite, 'runCmd'> => s !== null).map(s => ({ ...s, runCmd: run(s.testCmd) }));
  const names = done.map(s => s.name);
  for (const n of names.filter((n, i) => names.indexOf(n) !== i)) errors.push(`suite name "${n}" is used twice`);

  const ui = { timezone: (file.ui && file.ui.timezone) || systemTimezone() };
  if (!validTimezone(ui.timezone)) errors.push(`ui.timezone: unknown time zone "${ui.timezone}"`);
  const search = codeSearchFor(root, file, env);
  if (search.warning) warnings.push(search.warning);
  const indexLink = search.indexer && search.indexer.index ? [search.indexer.index.split('/')[0]] : [];
  const defaultLinks = [...new Set([...done.map(s => (s.dir === '.' ? 'node_modules' : `${s.dir}/node_modules`)), 'node_modules', ...indexLink])];

  const config: Config = {
    root,
    backlogDir: String(file.backlogDir || 'Docs/backlog').replace(/\/+$/, ''),
    suites: done,
    integration: file.integration ? { cmd: file.integration.cmd || null, ci: file.integration.ci || 'skip' } : null,
    tests: {
      retry: file.tests && typeof file.tests.retry === 'boolean' ? file.tests.retry : null,
      maxWorkers: file.tests && file.tests.maxWorkers !== undefined ? file.tests.maxWorkers : null,
    },
    lint: file.lint ? run(file.lint) : null,
    worktree: {
      base: (file.worktree && file.worktree.base) || '../{repo}-sdlc',
      link: (file.worktree && file.worktree.link) || defaultLinks,
    },
    git: {
      branchPrefix: (file.git && file.git.branchPrefix) || 'sdlc/',
      base: (file.git && file.git.base) || null,
      conflictSuffixStart: (file.git && file.git.conflictSuffixStart) || 10001,
    },
    agent: {
      allowCommands: (file.agent && file.agent.allowCommands) || [],
      codeSearch: search.codeSearch,
      codeIndexer: search.indexer,
    },
    finalise: {
      envExample: ((file.finalise && typeof file.finalise.envExample === 'boolean') ? file.finalise.envExample : (file.ship && typeof file.ship.envExample === 'boolean' ? file.ship.envExample : true)),
      maxFileBytes: (file.finalise && file.finalise.maxFileBytes) || (file.ship && file.ship.maxFileBytes) || 1024 * 1024,
    },
    ship: {
      envExample: ((file.finalise && typeof file.finalise.envExample === 'boolean') ? file.finalise.envExample : (file.ship && typeof file.ship.envExample === 'boolean' ? file.ship.envExample : true)),
      maxFileBytes: (file.finalise && file.finalise.maxFileBytes) || (file.ship && file.ship.maxFileBytes) || 1024 * 1024,
    },
    ui,
    node,
  };
  if (config.integration && !config.integration.cmd) errors.push('integration.cmd: must be set when "integration" is present');
  return { config: errors.length ? null : config, errors, warnings, file: hasFile ? fileName : null };
}

// --- Derived values --------------------------------------------------------------------------------------------------

/** The fixed folder in front of a suite's test globs (server/__tests__ for "__tests__/**" in server), or the suite folder. */
export function testDir(suite: Pick<Suite, 'dir' | 'testGlobs'>): string {
  const prefixes = suite.testGlobs.map(g => {
    const fixed: string[] = [];
    for (const p of g.split('/').slice(0, -1)) { if (/[*?[\]{}()!+@]/.test(p)) break; fixed.push(p); }
    return fixed;
  });
  let common = prefixes[0] || [];
  for (const p of prefixes) { let i = 0; while (i < common.length && common[i] === p[i]) i++; common = common.slice(0, i); }
  return [suite.dir === '.' ? '' : suite.dir, ...common].filter(Boolean).join('/') || '.';
}

export interface TestSpec {
  folder: string | null;
  globs: string[];
  /** For git: the folder, or ":(glob)" patterns. */
  pathspecs: string[];
  /** Regular expression sources matching test files by their path from the root. */
  patterns: string[];
}

/**
 * Where a suite's tests are: a folder when every glob takes all of one folder ("__tests__/**": server/__tests__), else the
 * globs themselves ("src/**\/*.test.ts": tests beside the source, whose folder also holds source). Paths are from the root.
 */
export function testSpec(suite: Pick<Suite, 'dir' | 'testGlobs'>): TestSpec {
  const prefix = suite.dir === '.' ? '' : `${suite.dir}/`;
  const globs = suite.testGlobs.map(g => prefix + g.replace(/^\.\//, ''));
  const whole = globs.map(g => g.match(/^([^*?[\]{}()!+@]+?)\/\*\*(?:\/\*)?$/)).filter((m): m is RegExpMatchArray => m !== null).map(m => m[1]);
  const dir = whole.length === globs.length && new Set(whole).size === 1 ? whole[0] : null;
  if (dir) return { folder: dir, globs, pathspecs: [dir], patterns: [`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`] };
  return { folder: null, globs, pathspecs: [...new Set(globs.flatMap(expandGlob))].map(g => `:(glob)${g}`), patterns: globs.map(globToRegex) };
}

/** The test files in words, for prompts and skills ({{TEST_FILES}}). */
export const testFiles = (config: Pick<Config, 'suites'>): string =>
  config.suites.map(testSpec).map(t => (t.folder ? `${t.folder}/` : `files matching ${t.globs.join(' or ')}`)).join('; ');

/** The project commands the stage agents may run: each suite's test command, lint, and agent.allowCommands. */
export const agentRules = (config: Config): string[] => [...new Set([
  ...config.suites.map(s => `Bash(${s.runCmd}:*)`),
  ...(config.lint ? [`Bash(${config.lint}:*)`] : []),
  ...config.agent.allowCommands.map(c => `Bash(${c}:*)`),
])];

/** The tools every stage agent may use: file tools, code search, the project commands, read-only git. */
/**
 * Read-only commands every stage agent may run without a prompt. No find (-exec, -delete), no interpreters, curl or
 * wget: web reads go through `ai-sdlc-helper fetch` (GET only, allowed hosts), added by the pipeline.
 */
export const READ_ONLY_COMMANDS = [
  'cd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'stat', 'file', 'diff', 'sort', 'uniq', 'cut', 'tr', 'jq', 'which',
  'command -v', 'readlink', 'realpath', 'dirname', 'basename', 'git show', 'git ls-files', 'git rev-parse', 'git blame',
  'git worktree list', 'git grep', 'git cat-file', 'tree', 'du', 'date', 'echo', 'npm ls', 'npm view',
];
/** Read-only commands allowed only exactly as written (no arguments). */
export const READ_ONLY_EXACT = ['pwd', 'git branch --show-current', 'npm --version'];

export function allowedTools(config: Config): string[] {
  const ix = config.agent.codeIndexer || { tools: [], commands: [] };
  const bash = (cmd: string) => `Bash(${cmd}:*)`;
  return [...new Set([
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    ...ix.tools,
    ...agentRules(config),
    ...ix.commands.map(bash),
    bash('ls'), bash('git status'), bash('git diff'), bash('git log'),
    ...READ_ONLY_COMMANDS.map(bash), ...READ_ONLY_EXACT.map(c => `Bash(${c})`),
  ])];
}

const FRAMEWORK_TEXT: Record<Runner, string> = {
  jest: 'Jest tests (describe/test and expect; mock with jest.fn and jest.mock)',
  vitest: "Vitest tests (import { describe, it, expect, vi } from 'vitest'; mock with vi.fn and vi.mock)",
  mocha: 'Mocha tests (describe/it, with node:assert or the assertion library the project already uses)',
  'node-test': "node:test tests (describe/it from 'node:test', assert from 'node:assert/strict')",
  'generic-junit': 'tests in the style the project already uses',
};
/** How the tests are written, for prompts and skills ({{TEST_FRAMEWORK}}): per suite, its runner and language. */
export function testFramework(config: Pick<Config, 'suites'>): string {
  const one = (s: Suite) => `${FRAMEWORK_TEXT[s.runner]}, in ${s.language === 'typescript' ? 'TypeScript' : 'JavaScript'}`;
  return config.suites.length === 1 ? one(config.suites[0]) : config.suites.map(s => `for ${s.dir}/: ${one(s)}`).join('; ');
}

/** Test-repair keys name test files relative to this folder: the suite's folder when there is one suite, else the root. */
export const keyDir = (config: Pick<Config, 'suites'>): string => (config.suites.length === 1 ? config.suites[0].dir : '.');

export interface Layout {
  root: string;
  backlogDir: string;
  testDirs: string[];
  sourceDirs: string[];
  testCmd: string;
  keyDir: string;
  testFiles: string;
  testPathspecs: string[];
  testPatterns: string[];
}

/** The folders the pipeline guards and compares: tests (read-only after Red tests) and source (the rest of each suite). */
export const layout = (config: Config): Layout => ({
  root: config.root, backlogDir: config.backlogDir, testDirs: config.suites.map(testDir), sourceDirs: config.suites.map(s => s.dir),
  testCmd: config.suites.map(s => s.runCmd).join(' && '), keyDir: keyDir(config), testFiles: testFiles(config),
  testPathspecs: config.suites.flatMap(s => testSpec(s).pathspecs), testPatterns: config.suites.flatMap(s => testSpec(s).patterns),
});

/** The folder that holds the pipeline worktrees ("../{repo}-sdlc" by default). */
export const worktreeBase = (config: Pick<Config, 'root' | 'worktree'>): string =>
  path.resolve(config.root, config.worktree.base.replace(/\{repo\}/g, path.basename(config.root)));
