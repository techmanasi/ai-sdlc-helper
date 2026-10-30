import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_FILE, exists, readJson, readSettings, rel } from '../util.js';
import { detect } from '../config/detect.js';
import { SEARCH_SETTINGS, codeIndexers, codeSearchErrors, codeSearchFor, unavailable } from '../config/codeSearch.js';
import { allowedTools, layout, resolve, testDir, testRunDefaults } from '../config/settings.js';
import { renderSkill, skillNames } from '../config/skills.js';
import {
  LANGUAGES, locateTestDir, provision, setupPlan, suggest, type Project, type SetupPlan, type Suggest,
} from '../config/suggest.js';
import { nodeRun } from '../config/node.js';
import type { Language } from '../config/detect.js';
import { argsProblem, parseArgs } from './args.js';
import { fetchHosts, fetchProblem, fetchUrl } from '../fetch.js';
import { TOOL_COMMANDS, TOOL_FLAGS, TOOL_USAGE, TOOL_VALUED, projectTool } from './project-tools.js';
import { PROJECT_COMMANDS, PROJECT_FLAGS, PROJECT_USAGE, PROJECT_VALUED, projects } from './projects.js';
import { RUNNER_COMMANDS, RUNNER_FLAGS, RUNNER_USAGE, RUNNER_VALUED, runners } from './runners.js';
import { RUNS_COMMANDS, RUNS_FLAGS, RUNS_USAGE, RUNS_VALUED, runs } from './runs.js';
import { PIPELINE_COMMANDS, PIPELINE_FLAGS, PIPELINE_USAGE, PIPELINE_VALUED, pipeline } from './pipeline.js';
import { TRIAGE_COMMANDS, TRIAGE_FLAGS, TRIAGE_USAGE, TRIAGE_VALUED, triageCommand } from './triage.js';
import type { RunClaude } from '../triage.js';
import { UI_COMMANDS, UI_FLAGS, UI_USAGE, UI_VALUED, ui } from './ui.js';
import { ARCHIVE_COMMANDS, ARCHIVE_FLAGS, ARCHIVE_USAGE, ARCHIVE_VALUED, archiveCommand } from './archive.js';

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Asks a question at the terminal; absent when there is none. */
  ask?: (question: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Replaces the claude process of `triage` (tests). */
  runClaude?: RunClaude;
}

const COMMANDS = ['detect', 'show', 'layout', 'node', 'suggest', 'init-tests', 'code-search', 'skill', 'fetch', 'help', ...PROJECT_COMMANDS, ...RUNNER_COMMANDS, ...TOOL_COMMANDS, ...RUNS_COMMANDS, ...PIPELINE_COMMANDS, ...TRIAGE_COMMANDS, ...UI_COMMANDS, ...ARCHIVE_COMMANDS];
const VALUED = ['--runner', '--language', '--test-dir', '--use', ...PROJECT_VALUED, ...RUNNER_VALUED, ...TOOL_VALUED, ...RUNS_VALUED, ...PIPELINE_VALUED, ...TRIAGE_VALUED, ...UI_VALUED, ...ARCHIVE_VALUED];
const FLAGS = ['--json', '--yes', '--dry-run', '--no-install', '--list', '--help', '--version', ...PROJECT_FLAGS, ...RUNNER_FLAGS, ...TOOL_FLAGS, ...RUNS_FLAGS, ...PIPELINE_FLAGS, ...TRIAGE_FLAGS, ...UI_FLAGS, ...ARCHIVE_FLAGS];

export const USAGE = `Usage: ai-sdlc-helper <command> [dir] [options]

  detect [dir] [--json]            the test suites detection finds; writes nothing
  show [dir]                       the resolved settings (${CONFIG_FILE}, then detection, then defaults) as JSON, with
                                   testRuns: the retry and worker limit the pipeline and run use
  layout [dir]                     test, source and backlog folders, test patterns and test command, as JSON
  node [dir]                       the Node the project's commands run with, and how
  suggest [dir] [--test-dir <folder>] [--language javascript|typescript] [--json]
                                   for a project without tests: the supported test frameworks, best first
  init-tests [dir] [--test-dir <folder>] [--language javascript|typescript] [--runner <name>] [--yes] [--dry-run] [--no-install]
                                   set up a test framework: confirm the language, pick a framework, apply the changes
  code-search [dir] [--list | --use <name|auto|none>]
                                   the code indexer the agents search with (graft, graphify, your own) or none
  skill <name> [dir]               a skill's text for this project
  fetch <https-url>                one GET request, the body on stdout: the web read stage agents may run (hosts:
                                   the npm registry, unpkg, jsDelivr, GitHub; AI_SDLC_HELPER_FETCH_HOSTS overrides)
${PROJECT_USAGE}
${RUNNER_USAGE}${TOOL_USAGE}${RUNS_USAGE}
${PIPELINE_USAGE}
${TRIAGE_USAGE}
${ARCHIVE_USAGE}${UI_USAGE}
  help, --help, --version`;

const where = (d: string) => (d === '.' ? 'the project root' : d);
const LANGUAGE_NAMES: Record<Language, string> = { javascript: 'JavaScript', typescript: 'TypeScript' };
const languageLine = (p: Project) => (p.languageSource === 'confirmed'
  ? `Language: ${LANGUAGE_NAMES[p.language]} (confirmed)`
  : `Detected language: ${LANGUAGE_NAMES[p.language]} (${p.languageEvidence.join(', ')})`);

/** The project root for <dir>: the top of its git work tree, else <dir> itself. */
function findRoot(dir: string): string {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : dir;
}

const packageVersion = (): string => {
  try { return readJson(new URL('../../package.json', import.meta.url).pathname).version; } catch { return 'unknown'; }
};

function printSuggestions(io: Io, s: Extract<Suggest, { status: 'suggestions' }>): void {
  const p = s.project;
  const uses = [p.vite && 'Vite', p.next && 'Next.js', p.nest && 'NestJS', ...p.frontend, ...p.backend].filter(Boolean);
  io.out(`Project (${where(p.dir)}): ${p.module === 'esm' ? 'ES modules' : 'CommonJS'}, Node ${p.node}, ${p.packageManager}${uses.length ? `; uses ${uses.join(', ')}` : ''}.`);
  io.out(`Supported test frameworks for ${LANGUAGE_NAMES[p.language]}, best first:`);
  s.suggestions.forEach((x, i) => {
    io.out(`\n${i + 1}. ${x.runner}${x.recommended ? ' (recommended)' : ''}`);
    for (const w of x.why) io.out(`   + ${w}`);
    for (const c of x.caveats) io.out(`   - ${c}`);
    io.out(`   install: ${x.install || 'nothing'}`);
    io.out(`   adds:    scripts.test ${JSON.stringify(x.adds!.script)}, ${x.adds!.files.join(', ')}`);
  });
  for (const n of s.notSuggested) io.out(`\nNot suggested: ${n.runner}: ${n.reason}`);
}

function printPlan(io: Io, plan: SetupPlan, dir: string): void {
  io.out(`\nSetting up ${plan.runner} in ${dir}:`);
  io.out(`  package.json  scripts.test = ${JSON.stringify(plan.script)}`);
  for (const f of plan.files) io.out(`  ${f.path}${exists(path.join(dir, f.path)) ? '  (exists, kept as it is)' : ''}`);
  io.out(`  install       ${plan.install || 'nothing'}`);
  for (const n of plan.notes) io.out(`  note: ${n}`);
}

interface InitOptions { runner?: string; language?: Language; testDir?: string; yes: boolean; dryRun: boolean; install: boolean }

async function initTests(io: Io, start: string, opts: InitOptions): Promise<number> {
  let dir = start;
  let testDirRel: string | undefined;
  const projectRoot = findRoot(dir);
  if (opts.testDir) {
    const loc = locateTestDir(dir, opts.testDir);
    if ('error' in loc) { io.err(`ERROR: ${loc.error}`); return 1; }
    dir = loc.pkgDir; testDirRel = loc.testDir;
  }
  const root = findRoot(dir) === dir ? projectRoot : findRoot(dir);
  let s = suggest(dir, root, { language: opts.language, testDir: testDirRel });
  if (s.status !== 'suggestions') {
    io.err(`ERROR: ${s.status === 'unsupported' ? s.reason : `tests are already set up (${s.existing.map(e => `${e.dir}: ${e.runner}`).join(', ')})`}`);
    return 1;
  }
  // 1. The language: confirmed with --language, at the prompt, or (with --yes) taken as detected.
  io.out(`No tests found in ${where(s.project.dir)}.\n${languageLine(s.project)}`);
  let language = opts.language;
  if (!language) {
    if (opts.yes) language = s.project.language;
    else if (!io.ask) { io.err('\nERROR: confirm the language with --language javascript|typescript'); return 2; }
    else {
      const a = (await io.ask('Is this right? [Enter = yes, or type javascript / typescript]: ')).toLowerCase();
      language = a === '' || /^y(es)?$/.test(a) ? s.project.language : LANGUAGES.find(l => l === a || (l.slice(0, 2) === a.slice(0, 2) && a.length <= 2));
      if (!language) { io.err(`ERROR: unknown language "${a}"`); return 2; }
    }
    s = suggest(dir, root, { language, testDir: testDirRel });
    if (s.status !== 'suggestions') { io.err(`ERROR: ${s.status === 'unsupported' ? s.reason : 'tests are already set up'}`); return 1; }
  }
  io.out('');
  // 2. The framework, from the suggestions for that language.
  let runner = opts.runner;
  if (!runner) {
    printSuggestions(io, s);
    if (!io.ask) { io.err('\nERROR: pick one with --runner <name>'); return 2; }
    const a = await io.ask(`\nPick a framework [1-${s.suggestions.length}, Enter = 1]: `);
    const pick = s.suggestions[(a === '' ? 1 : Number(a)) - 1] || s.suggestions.find(x => x.runner === a);
    if (!pick) { io.err(`ERROR: no framework "${a}"`); return 2; }
    runner = pick.runner;
  }
  // 3. The test folder: --test-dir, else asked (Enter keeps the default) when there is a terminal and no --yes.
  if (!testDirRel && !opts.yes && io.ask && s.suggestions.some(x => x.runner === runner)) {
    const fallback = path.posix.dirname(setupPlan(s.project, runner as never).files.slice(-1)[0].path);
    const a = await io.ask(`Test folder inside ${where(s.project.dir)} [Enter = ${fallback}]: `);
    if (a) {
      const loc = locateTestDir(dir, a);
      if ('error' in loc) { io.err(`ERROR: ${loc.error}`); return 2; }
      if (loc.pkgDir !== dir) { io.err(`ERROR: ${a} belongs to the package in ${rel(dir, loc.pkgDir)}; run init-tests there`); return 2; }
      testDirRel = loc.testDir;
    }
  }
  const pre = provision(dir, runner, { root, language, testDir: testDirRel, dryRun: true });
  if (!pre.ok || !pre.plan) { io.err(`ERROR: ${pre.error}`); return 1; }
  printPlan(io, pre.plan, dir);
  if (opts.dryRun) { io.out('\nDry run: nothing was changed.'); return 0; }
  if (!opts.yes) {
    if (!io.ask) { io.err('\nERROR: confirm with --yes'); return 2; }
    if (!/^y(es)?$/i.test(await io.ask('\nApply these changes? [y/N]: '))) { io.out('Nothing was changed.'); return 0; }
  }
  const r = provision(dir, runner, { root, language, testDir: testDirRel, install: opts.install });
  for (const st of r.steps || []) io.out(`\n$ ${st.cmd}  (exit ${st.status})${st.status ? `\n${st.output}` : ''}`);
  if (r.written && r.written.length) io.out(`\nWritten: ${r.written.join(', ')}`);
  if (r.skipped && r.skipped.length) io.out(`Kept (already there): ${r.skipped.join(', ')}`);
  if (!r.ok) { io.err(`ERROR: ${r.error}`); return 1; }
  io.out(opts.install ? `\n${runner} is set up and the example test passes.` : `\n${runner} is set up. Install the packages with: ${r.plan?.install || 'nothing to install'}`);
  return 0;
}

function codeSearch(io: Io, dir: string, use: string | undefined, list: boolean, env: NodeJS.ProcessEnv): number {
  const file = readSettings(dir);
  const problems = codeSearchErrors(file);
  for (const e of problems) io.err(`NOTE: ${e}; using "auto"`);
  const settings = problems.length ? {} : file;
  if (use !== undefined) {
    const all = codeIndexers(settings);
    if (!SEARCH_SETTINGS.includes(use) && !all[use]) { io.err(`ERROR: "${use}" is not a code indexer (use auto, none, ${Object.keys(all).join(', ')})`); return 2; }
    const target = path.join(dir, CONFIG_FILE);
    let raw: string | null = null;
    try { raw = fs.readFileSync(target, 'utf8'); } catch { /* new file */ }
    let next: Record<string, any>;
    try { next = raw === null ? {} : JSON.parse(raw); } catch { io.err(`ERROR: ${CONFIG_FILE} is not valid JSON; fix it first`); return 1; }
    next.agent = { ...(next.agent || {}), codeSearch: use };
    fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
    const r = codeSearchFor(dir, next, env);
    io.out(`agent.codeSearch = "${use}" in ${CONFIG_FILE}; code search now uses ${r.codeSearch === 'none' ? 'Grep and Glob' : r.codeSearch}`);
    if (r.warning) io.out(`NOTE: ${r.warning}`);
    return 0;
  }
  const r = codeSearchFor(dir, settings, env);
  if (list) {
    const setting = (settings.agent && settings.agent.codeSearch) || 'auto';
    io.out(`agent.codeSearch: ${setting}; in use: ${r.codeSearch === 'none' ? 'none (Grep and Glob)' : r.codeSearch}`);
    const all = Object.values(codeIndexers(settings));
    const width = Math.max(...all.map(ix => ix.name.length)) + 2;
    for (const ix of all) {
      const why = unavailable(ix, dir, env);
      io.out(`  ${ix.name === r.codeSearch ? '*' : ' '} ${ix.name.padEnd(width)}${why ? `not available: ${why}` : 'available'}`
        + `${!why || !ix.setup ? '' : `\n    ${' '.repeat(width)}set up: ${ix.setup}`}`);
    }
    io.out(`Choose with: ai-sdlc-helper code-search --use <${[...Object.keys(codeIndexers(settings)), ...SEARCH_SETTINGS].join('|')}>`);
    return 0;
  }
  if (r.warning) io.err(`NOTE: ${r.warning}`);
  io.out(r.codeSearch);
  return 0;
}

/** Runs the command line <argv> (without the program name). Returns the exit code: 0 ok, 1 failed, 2 usage. */
export async function main(argv: string[], io: Io): Promise<number> {
  const env = io.env || process.env;
  const cwd = io.cwd || process.cwd();
  if (argv.includes('--version')) { io.out(packageVersion()); return 0; }
  if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') { io.out(USAGE); return argv.length === 0 ? 2 : 0; }
  const problem = argsProblem(argv, { commands: COMMANDS, valued: VALUED, flags: FLAGS });
  if (problem) { io.err(`ERROR: ${problem}\n\n${USAGE}`); return 2; }
  const a = parseArgs(argv, VALUED);
  if (TOOL_COMMANDS.includes(a.positional[0])) return projectTool(argv, VALUED, io);
  const [cmd, dirArg, extra] = a.positional;
  if (RUNNER_COMMANDS.includes(cmd)) return runners(argv, io);
  if (RUNS_COMMANDS.includes(cmd)) return runs(a, io);
  if (PIPELINE_COMMANDS.includes(cmd)) return pipeline(argv, VALUED, io);
  if (TRIAGE_COMMANDS.includes(cmd)) return triageCommand(a, io);
  if (UI_COMMANDS.includes(cmd)) return ui(argv, VALUED, io);
  if (ARCHIVE_COMMANDS.includes(cmd)) return archiveCommand(argv, VALUED, io);
  const languageArg = a.value('--language');
  if (languageArg !== undefined && !LANGUAGES.includes(languageArg as Language)) { io.err(`ERROR: --language must be javascript or typescript\n\n${USAGE}`); return 2; }
  for (const o of ['--runner', '--test-dir', '--use']) if (a.value(o) === '') { io.err(`ERROR: ${o} needs a value\n\n${USAGE}`); return 2; }

  if (cmd === 'fetch') {
    const url = dirArg;
    if (!url || extra) { io.err('ERROR: usage: ai-sdlc-helper fetch <https-url>'); return 2; }
    const problem = fetchProblem(url, fetchHosts(env));
    if (problem) { io.err(`ERROR: fetch: ${problem}`); return 2; }
    try { io.out((await fetchUrl(url)).replace(/\n$/, '')); return 0; } catch (e) { io.err(`ERROR: fetch: ${(e as Error).message}`); return 1; }
  }
  if (cmd === 'skill') {
    const text = dirArg ? renderSkill(dirArg, path.resolve(cwd, extra || '.'), { env }) : null;
    if (text === null) { io.err(`ERROR: no skill "${dirArg || ''}" (skills: ${skillNames().join(', ')})`); return 2; }
    io.out(text.replace(/\n$/, ''));
    return 0;
  }
  if (PROJECT_COMMANDS.includes(cmd)) return projects(a, io);
  const dir = path.resolve(cwd, dirArg || '.');
  if (!exists(dir)) { io.err(`ERROR: ${dir} does not exist`); return 2; }

  switch (cmd) {
    case 'code-search':
      return codeSearch(io, dir, a.value('--use'), a.flag('--list'), env);
    case 'init-tests':
      return initTests(io, dir, {
        runner: a.value('--runner'), language: languageArg as Language | undefined, testDir: a.value('--test-dir'),
        yes: a.flag('--yes'), dryRun: a.flag('--dry-run'), install: !a.flag('--no-install'),
      });
    case 'suggest': {
      let at = dir;
      let testDirRel: string | undefined;
      const testDirArg = a.value('--test-dir');
      if (testDirArg) {
        const loc = locateTestDir(dir, testDirArg);
        if ('error' in loc) { io.err(`ERROR: ${loc.error}`); return 1; }
        at = loc.pkgDir; testDirRel = loc.testDir;
      }
      const s = suggest(at, findRoot(at), { language: languageArg as Language | undefined, testDir: testDirRel });
      if (a.flag('--json')) io.out(JSON.stringify(s, null, 2));
      else if (s.status === 'unsupported') io.out(`${s.dir}: ${s.reason}`);
      else if (s.status === 'has-tests') io.out(`${s.dir}: tests are already set up (${s.existing.map(e => `${e.dir}: ${e.runner}`).join(', ')})`);
      else {
        io.out(`No tests found in ${where(s.project.dir)}.\n${languageLine(s.project)}${languageArg ? '' : ' (correct it with --language)'}\n`);
        printSuggestions(io, s);
        io.out(`\nSet one up with: ai-sdlc-helper init-tests ${dirArg || '.'} --runner <name>`);
      }
      return s.status === 'unsupported' ? 1 : 0;
    }
    case 'detect': {
      const found = detect(dir);
      if (a.flag('--json')) io.out(JSON.stringify(found, null, 2));
      else if (!found.length) io.out('No test suite found.');
      else {
        for (const f of found) {
          if (f.unknown) { io.out(`${f.dir}: test runner not recognised (set it in ${CONFIG_FILE})\n  evidence:     ${f.evidence[0]}`); continue; }
          io.out(`${f.dir}: ${f.runner || `ambiguous (${f.candidates.join(', ')})`} · ${f.language} · ${f.packageManager}`);
          if (f.runner) io.out(`  test command: ${f.testCmd}\n  test files:   ${f.testGlobs!.join(', ')}`);
          if (f.covers && f.covers.length) io.out(`  also runs:    ${f.covers.join(', ')}`);
          io.out(`  evidence:     ${f.evidence.join('; ')}`);
        }
      }
      return found.some(f => !f.runner && !f.unknown) ? 1 : 0;
    }
    case 'node': {
      const n = nodeRun(dir, readSettings(dir).node || {}, env);
      io.out(`The tool runs on Node ${n.current}.`);
      io.out(n.wanted ? `The project asks for Node ${n.wanted.spec} (${n.wanted.source}, ${n.wanted.kind === 'pin' ? 'a pin' : 'a range'}).` : 'The project does not say which Node it needs.');
      io.out(n.switchTo ? `Its commands run with Node ${n.switchTo} through ${n.manager}.` : `Its commands run with Node ${n.current}.`);
      if (n.warning) io.out(`NOTE: ${n.warning}`);
      return 0;
    }
    default: { // show, layout
      const { config, errors, warnings } = resolve(dir, { env });
      for (const w of warnings) io.err(`WARNING: ${w}`);
      if (errors.length || !config) { for (const e of errors) io.err(`ERROR: ${e}`); return 1; }
      if (cmd === 'layout') io.out(JSON.stringify(layout(config)));
      else {
        io.out(JSON.stringify({
          ...config, testDirs: config.suites.map(testDir), testRuns: testRunDefaults(config.tests), allowedTools: allowedTools(config),
        }, null, 2));
      }
      return 0;
    }
  }
}
