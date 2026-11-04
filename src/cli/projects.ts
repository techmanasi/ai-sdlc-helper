import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, exists } from '../util.js';
import { resolve, type Config } from '../config/settings.js';
import {
  RegistryError, defaultName, findByName, findByPath, freeName, gitRoot, projectDir, readRegistry, registryFile,
  withProject, withoutProject, writeRegistry, type ProjectOverrides,
} from '../registry/projects.js';
import { backlogDirOf, doctor, doctorOk } from '../registry/doctor.js';
import { SETUP_BRANCH, commitOnSetupBranch, ghReady, openPullRequest, pushBranch, setupBase } from '../registry/setupBranch.js';
import type { ParsedArgs } from './args.js';
import type { Io } from './main.js';

export const PROJECT_COMMANDS = ['add', 'list', 'remove', 'doctor'];
export const PROJECT_VALUED = ['--name', '--project', '--worktree-base', '--max-parallel'];
export const PROJECT_FLAGS = ['--run-tests', '--commit', '--push', '--pr'];

export const PROJECT_USAGE = `  add [dir] [--name <name>] [--worktree-base <dir>] [--max-parallel <n>] [--yes] [--commit] [--push] [--pr]
                                   register a project (its git root): shows the settings, offers ${CONFIG_FILE} and a backlog index,
                                   then to commit them on ${SETUP_BRANCH} from main, push it and open a PR (--yes does not answer these)
  list [--json]                    the registered projects
  remove <name>                    forget a registered project (its files are kept)
  doctor [dir | --project <name>] [--run-tests]
                                   check what the pipeline needs: Node, git, claude, settings, code indexer, backlog`;

const yes = (answer: string) => /^y(es)?$/i.test(answer.trim());

/** The settings sdlc.config.json would hold to keep what detection found. */
export const detectedSettings = (config: Config) => ({
  backlogDir: config.backlogDir,
  suites: config.suites.map(s => ({ name: s.name, dir: s.dir, runner: s.runner, testCmd: s.testCmd, testGlobs: s.testGlobs })),
});

export const backlogIndexText = (backlogDir: string): string => `# Backlog

Pending items are picked top-down. Format: \`- [ ] \\\`slug\\\` - title\`; each item needs \`${backlogDir}/<slug>/brief.md\`.
Markers: [ ] pending, [x] completed, [!] blocked, [~] parked (skipped).
`;

interface AddOptions { name?: string; yes: boolean; commit: boolean; push: boolean; pr: boolean; overrides: ProjectOverrides }

/**
 * Offers to commit <files> on a setup branch from main, push it, and open a pull request, one question each. A flag answers
 * its question (and those before it); --yes does not. Each step needs the one before it; a failure stops the rest.
 */
async function setupBranch(io: Io, env: NodeJS.ProcessEnv, root: string, files: string[], opts: AddOptions): Promise<void> {
  const ask = async (flag: boolean, question: string) => flag || (!!io.ask && yes(await io.ask(question)));
  const base = setupBase(root, env);
  if (!base) { io.out(`WARNING: no main or master branch to start the setup branch from; ${files.join(', ')} not committed`); return; }
  const doPush = opts.push || opts.pr;
  if (!await ask(opts.commit || doPush, `\nCommit ${files.join(', ')} on a new branch ${SETUP_BRANCH} from ${base}? [y/N]: `)) {
    io.out(`Not committed. To do it by hand: git switch -c ${SETUP_BRANCH} ${base}, then git add ${files.join(' ')} and git commit.`);
    return;
  }
  let commit;
  try { commit = commitOnSetupBranch(root, files, env); } catch (e) { io.err(`ERROR: ${(e as Error).message}`); return; }
  if (!commit) return;
  io.out(`Committed ${files.join(', ')} on ${commit.branch} from ${commit.base} (${commit.sha}); the checked out branch is unchanged.`);
  io.out(`The local ${files.join(', ')} stay untracked here; remove them before merging ${commit.branch}, or git will refuse to overwrite them.`);
  if (!await ask(doPush, `\nPush ${commit.branch} to origin? [y/N]: `)) { io.out(`Not pushed. To push: git push -u origin ${commit.branch}`); return; }
  try { pushBranch(root, commit.branch, env); } catch (e) { io.err(`ERROR: ${(e as Error).message}`); return; }
  io.out(`Pushed ${commit.branch} to origin.`);
  if (!ghReady(root, env)) { io.out(`No authenticated gh CLI; open a pull request for ${commit.branch} yourself.`); return; }
  if (!await ask(opts.pr, `\nOpen a pull request into ${commit.base}? [y/N]: `)) {
    io.out(`No pull request. To open one: gh pr create --base ${commit.base} --head ${commit.branch}`);
    return;
  }
  try { io.out(`Pull request: ${openPullRequest(root, commit.branch, commit.base, files, env)}`); } catch (e) { io.err(`ERROR: ${(e as Error).message}`); }
}

async function add(io: Io, env: NodeJS.ProcessEnv, start: string, opts: AddOptions): Promise<number> {
  const root = gitRoot(start, env);
  if (!root) { io.err(`ERROR: ${start} is not in a git repository; run git init there first`); return 1; }
  const entries = readRegistry(env);
  const old = findByPath(entries, root);
  const name = opts.name ?? old?.name ?? freeName(entries, defaultName(root), root);
  const next = withProject(entries, { name, path: root, overrides: opts.overrides });

  const { config, errors, warnings, file } = resolve(root, { env });
  const backlogDir = backlogDirOf(config, root);
  const index = path.join(root, backlogDir, 'index.md');
  const offerConfig = !file && config !== null;
  const offerIndex = !exists(index);

  io.out(`Project ${name}: ${root}${old ? ` (already registered${old.name !== name ? ` as ${old.name}` : ''}; the entry is updated)` : ''}`);
  io.out(`Settings: ${file ? `from ${CONFIG_FILE}` : `detected (no ${CONFIG_FILE})`}`);
  if (config) {
    io.out('Suites:');
    for (const s of config.suites) io.out(`  ${s.name} (${s.dir}): ${s.runner}, ${s.language}, ${s.packageManager}\n    test command: ${s.runCmd}`);
    io.out(`Code search: ${config.agent.codeSearch === 'none' ? 'none (Grep and Glob)' : config.agent.codeSearch}`);
    io.out(`Node: ${config.node.switchTo ? `commands run with Node ${config.node.switchTo} through ${config.node.manager}` : `commands run with Node ${config.node.current}`}`);
  }
  io.out(`Backlog folder: ${backlogDir}${offerIndex ? ' (no index.md yet)' : ''}`);
  if (Object.keys(next.entry.overrides || {}).length) io.out(`Overrides: ${JSON.stringify(next.entry.overrides)}`);
  for (const w of warnings) io.out(`WARNING: ${w}`);
  for (const e of errors) io.out(`ERROR: ${e}`);
  if (errors.length) io.out(`The settings do not resolve yet; the project can be registered, then checked with: ai-sdlc-helper doctor --project ${name}`);
  if (offerConfig) io.out(`\n${CONFIG_FILE} to write:\n${JSON.stringify(detectedSettings(config!), null, 2)}`);

  if (!opts.yes && !io.ask) { io.err('\nERROR: confirm with --yes'); return 2; }
  const confirm = async (question: string) => opts.yes || yes(await io.ask!(question));
  if (!await confirm(`\nRegister ${name} (${root})? [y/N]: `)) { io.out('Nothing was changed.'); return 0; }
  const done: string[] = [];
  if (offerConfig && await confirm(`Write ${CONFIG_FILE} with these settings? [y/N]: `)) {
    fs.writeFileSync(path.join(root, CONFIG_FILE), `${JSON.stringify(detectedSettings(config!), null, 2)}\n`);
    done.push(CONFIG_FILE);
  }
  if (offerIndex && await confirm(`Create ${backlogDir}/index.md? [y/N]: `)) {
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(index, backlogIndexText(backlogDir));
    done.push(`${backlogDir}/index.md`);
  }
  // Read again: another command may have changed the registry while we asked.
  const latest = withProject(readRegistry(env), { name, path: root, overrides: opts.overrides });
  writeRegistry(latest.entries, env);
  io.out(`${latest.updated ? 'Updated' : 'Registered'} ${name} in ${registryFile(env)}${done.length ? `; wrote ${done.join(', ')}` : ''}.`);
  if (done.length) await setupBranch(io, env, root, done, opts);
  return 0;
}

function list(io: Io, env: NodeJS.ProcessEnv, json: boolean): number {
  const entries = readRegistry(env);
  if (json) { io.out(JSON.stringify(entries, null, 2)); return 0; }
  if (!entries.length) { io.out('No projects are registered. Add one with: ai-sdlc-helper add [dir]'); return 0; }
  const width = Math.max(...entries.map(e => e.name.length)) + 2;
  for (const e of entries) {
    const extra = [!exists(e.path) && 'missing', e.overrides && Object.keys(e.overrides).length && JSON.stringify(e.overrides)].filter(Boolean);
    io.out(`${e.name.padEnd(width)}${e.path}${extra.length ? `  (${extra.join(', ')})` : ''}`);
  }
  return 0;
}

function printChecks(io: Io, target: string, env: NodeJS.ProcessEnv, runTests: boolean): number {
  const checks = doctor(target, { env, runTests });
  for (const c of checks) {
    io.out(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail.replace(/\n/g, '\n    ')}${!c.ok && !c.required ? ' (recommended)' : ''}`);
    if (!c.ok && c.fix) io.out(`    fix: ${c.fix}`);
  }
  const failed = checks.filter(c => !c.ok && c.required).length;
  io.out(failed ? `\n${failed} required check${failed > 1 ? 's' : ''} failed.` : '\nAll required checks passed.');
  return doctorOk(checks) ? 0 : 1;
}

/** Runs add, list, remove or doctor. Returns the exit code: 0 ok, 1 failed, 2 usage. */
export async function projects(a: ParsedArgs, io: Io): Promise<number> {
  const env = io.env || process.env;
  const cwd = io.cwd || process.cwd();
  const [cmd, arg] = a.positional;
  for (const o of PROJECT_VALUED) if (a.value(o) === '') { io.err(`ERROR: ${o} needs a value`); return 2; }
  try {
    switch (cmd) {
      case 'add': {
        const start = path.resolve(cwd, arg || '.');
        if (!exists(start)) { io.err(`ERROR: ${start} does not exist`); return 2; }
        const overrides: ProjectOverrides = {};
        const wb = a.value('--worktree-base');
        if (wb) overrides.worktreeBase = wb;
        const mp = a.value('--max-parallel');
        if (mp !== undefined) {
          if (!/^[1-9]\d*$/.test(mp)) { io.err('ERROR: --max-parallel must be a whole number of 1 or more'); return 2; }
          overrides.maxParallel = Number(mp);
        }
        return await add(io, env, start, { name: a.value('--name'), yes: a.flag('--yes'), commit: a.flag('--commit'), push: a.flag('--push'), pr: a.flag('--pr'), overrides });
      }
      case 'list':
        return list(io, env, a.flag('--json'));
      case 'remove': {
        if (!arg) { io.err('ERROR: remove needs a project name (see: ai-sdlc-helper list)'); return 2; }
        writeRegistry(withoutProject(readRegistry(env), arg), env);
        io.out(`Removed ${arg} from the registry; its files are kept.`);
        return 0;
      }
      default: { // doctor
        const named = a.value('--project');
        let target: string;
        if (named !== undefined) {
          const entry = findByName(readRegistry(env), named);
          if (!entry) { io.err(`ERROR: no project "${named}" (see: ai-sdlc-helper list)`); return 2; }
          target = entry.path;
        } else target = projectDir(arg, cwd, env);
        if (!exists(target)) { io.err(`ERROR: ${target} does not exist (remove it with: ai-sdlc-helper remove <name>)`); return 1; }
        return printChecks(io, target, env, a.flag('--run-tests'));
      }
    }
  } catch (e) {
    if (e instanceof RegistryError) { io.err(`ERROR: ${e.message}`); return 1; }
    throw e;
  }
}
