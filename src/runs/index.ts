// Run controls (scripts/sdlc-mod.sh in TypeScript): each backlog item's pipeline runs in its own git worktree on its own
// branch, so several can run at once. start, stop, restart, discard, status, watch and changes work on the run registry
// (records.ts); the pipeline itself is `ai-sdlc-helper pipeline <slug>`, run by a detached supervisor (supervisor.ts).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, exists, readSettings } from '../util.js';
import { shellArgv } from '../shell.js';
import { resolve, worktreeBase } from '../config/settings.js';
import { findContaining, readRegistry, type ProjectOverrides } from '../registry/projects.js';
import { worktreeChanges } from '../changes/index.js';
import {
  alive, isRunning, killTree, mainTree, projectRoot, now, readRecord, recordFile, recordedSlugs, registryDir, runState, writeRecord, type RunRecord,
} from './records.js';
import { startSupervisor, type SetupStep } from './supervisor.js';

/** The controls' own environment variables: read here, never passed to the pipeline. */
export const CONTROL_ENV = ['SDLC_BASE', 'SDLC_WT_BASE', 'SDLC_MAX_PARALLEL', 'SDLC_ALLOW_MERGED', 'FROM', 'AI_SDLC_HELPER_PIPELINE_CMD'];
export const DEFAULT_MAX_PARALLEL = 2;

/** Everything the controls need to know about one repository. */
export interface RunContext {
  /** The main working tree: settings, links and the saved permission rules come from here, whichever checkout runs us. */
  root: string;
  /** <git common dir>/sdlc-runs. */
  reg: string;
  backlogDir: string;
  branchPrefix: string;
  /** git.base from the settings, overridden by SDLC_BASE. */
  base: string | null;
  wtBase: string;
  links: string[];
  setup: { name: string; dir: string; cmd: string }[];
  maxParallel: number;
  env: NodeJS.ProcessEnv;
}

/** A command's outcome: the exit code and the lines for stdout and stderr. */
export interface Outcome { code: number; out: string[]; err: string[] }
const ok = (...out: string[]): Outcome => ({ code: 0, out, err: [] });
const fail = (code: number, ...err: string[]): Outcome => ({ code, out: [], err });

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
const gitOk = (cwd: string, args: string[], env: NodeJS.ProcessEnv) => git(cwd, args, env).status === 0;

const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const positiveInt = (v: string) => /^[1-9]\d*$/.test(v);

/**
 * The context for the repository holding <dir>: its settings (sdlc.config.json, else detection; when they do not
 * resolve, the plain defaults, and the pipeline reports the errors), the registry overrides of the project, then the
 * controls' environment (SDLC_WT_BASE, SDLC_BASE, SDLC_MAX_PARALLEL). Throws on a bad SDLC_MAX_PARALLEL.
 */
export function runContext(dir: string, env: NodeJS.ProcessEnv = process.env): RunContext {
  const root = projectRoot(dir, env);
  const { config } = resolve(root, { env });
  const file = readSettings(root);
  let overrides: ProjectOverrides = {};
  try { overrides = findContaining(readRegistry(env), root)?.overrides || {}; } catch { /* a corrupt registry is reported by the commands that read it */ }
  const fromFile = (k: string) => (file.git && typeof file.git[k] === 'string' && file.git[k]) || null;
  const backlogDir = config ? config.backlogDir : String(file.backlogDir || 'Docs/backlog').replace(/\/+$/, '');
  const repoBase = (b: string) => path.resolve(root, b.replace(/\{repo\}/g, path.basename(root)));
  const wtBase = env.SDLC_WT_BASE ? path.resolve(root, env.SDLC_WT_BASE)
    : overrides.worktreeBase ? repoBase(overrides.worktreeBase)
      : config ? worktreeBase(config) : repoBase((file.worktree && file.worktree.base) || '../{repo}-sdlc');
  const capEnv = env.SDLC_MAX_PARALLEL;
  if (capEnv !== undefined && capEnv !== '' && !positiveInt(capEnv)) throw new Error(`SDLC_MAX_PARALLEL must be a whole number of 1 or more, not '${capEnv}'`);
  const maxParallel = capEnv ? Number(capEnv) : (Number.isInteger(overrides.maxParallel) && overrides.maxParallel! > 0 ? overrides.maxParallel! : DEFAULT_MAX_PARALLEL);
  return {
    root, reg: registryDir(root), backlogDir,
    branchPrefix: config ? config.git.branchPrefix : (fromFile('branchPrefix') || 'sdlc/'),
    base: env.SDLC_BASE || (config ? config.git.base : fromFile('base')),
    wtBase,
    links: config ? config.worktree.link : (file.worktree && Array.isArray(file.worktree.link) ? file.worktree.link : ['node_modules']),
    setup: config ? config.suites.filter(s => s.setup).map(s => ({ name: s.name, dir: s.dir, cmd: s.setup! })) : [],
    maxParallel, env,
  };
}

/** The ref a new branch starts from: SDLC_BASE or git.base, else a valid branch with the settings, else main/master/origin/HEAD. */
export function pickBase(ctx: RunContext): string {
  if (ctx.base) return ctx.base;
  const current = git(ctx.root, ['branch', '--show-current'], ctx.env).stdout.trim();
  const candidates = [
    ...(current ? [current] : []),
    'main',
    'master',
    'origin/main',
    'origin/master',
    'HEAD',
  ];
  const valid = [...new Set(candidates)].filter(r => gitOk(ctx.root, ['rev-parse', '--verify', '-q', r], ctx.env));
  if (!valid.length) return '';
  // When sdlc.config.json exists, prefer a base candidate that actually has it committed
  if (exists(path.join(ctx.root, CONFIG_FILE))) {
    const withConfig = valid.find(r => committed(ctx, r, CONFIG_FILE));
    if (withConfig) return withConfig;
  }
  return valid[0];
}

/** True when the item's red-tests commit is already in <base>: it was merged. */
export const isMerged = (ctx: RunContext, slug: string, base: string): boolean =>
  git(ctx.root, ['log', base, '-1', '--format=%h', `--grep=^test(${slug}): add failing tests`], ctx.env).stdout.trim() !== '';

const branchOf = (ctx: RunContext, slug: string, rec?: Partial<RunRecord> | null) => rec?.branch || `${ctx.branchPrefix}${slug}`;
const committed = (ctx: RunContext, ref: string, file: string) => gitOk(ctx.root, ['cat-file', '-e', `${ref}:${file}`], ctx.env);
const branchExists = (ctx: RunContext, branch: string) => gitOk(ctx.root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], ctx.env);
const regFile = (ctx: RunContext, slug: string, ext: string) => path.join(ctx.reg, `${slug}.${ext}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The worktree of <slug>'s run: the one its record names (even when the settings have changed since), else
 * <worktree base>/<slug>; null when neither is there.
 */
export function runWorktree(ctx: RunContext, slug: string): string | null {
  const rec = readRecord(ctx.reg, slug);
  if (rec?.worktree && isDir(rec.worktree)) return rec.worktree;
  const wt = path.join(ctx.wtBase, slug);
  return isDir(wt) ? wt : null;
}

/** Holds <reg>/.start.lock while <fn> runs, so two starts cannot both pass the parallel cap. */
function withStartLock<T>(reg: string, fn: () => T): T {
  fs.mkdirSync(reg, { recursive: true });
  const lock = path.join(reg, '.start.lock');
  const end = Date.now() + 15000;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.rmSync(lock, { force: true }); } catch { /* gone */ }
      if (Date.now() > end) throw new Error(`another start holds ${lock}; delete it if no start is running`);
      sleepSync(50);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}

/**
 * The pipeline command for a run: AI_SDLC_HELPER_PIPELINE_CMD (a command line, run by sh with the arguments as "$@"; on
 * Windows by the shell of shellArgv, the arguments appended: a slug and a stage name need no quoting) or this tool's
 * `pipeline`.
 */
export function pipelineArgv(slug: string, from: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const args = [slug, ...(from ? ['--from', from] : [])];
  const custom = env.AI_SDLC_HELPER_PIPELINE_CMD;
  if (custom && platform === 'win32') { const a = shellArgv(`${custom} ${args.join(' ')}`, { env, platform }); return [a.file, ...a.args]; }
  if (custom) return ['sh', '-c', `${custom} "$@"`, 'sh', ...args];
  return [process.execPath, fileURLToPath(new URL('../bin.js', import.meta.url)), 'pipeline', ...args];
}

/** The pipeline's environment: the caller's, without the controls' own variables, with SDLC_SLUG and the plugin folders. */
export function pipelineEnv(ctx: RunContext, slug: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ctx.env };
  for (const k of CONTROL_ENV) delete env[k];
  const guard = path.join(ctx.root, '.claude/plugins/sdlc-guard');
  const plugins = ctx.env.SDLC_PLUGIN_DIRS ?? (isDir(guard) ? guard : '');
  if (plugins) env.CLAUDE_CODE_PLUGIN_DIRS = plugins;
  env.SDLC_SLUG = slug;
  return env;
}

/** Shares the git-ignored things a pipeline needs with the main working tree, and keeps the links out of every commit. */
function linkShared(ctx: RunContext, wt: string): void {
  // A .gitignore pattern ending in "/" (node_modules/) does not match a symlink, so each link also goes into the
  // repository's local exclude file (shared by every worktree).
  const exclude = path.join(path.dirname(ctx.reg), 'info', 'exclude');
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  for (const p of ctx.links) {
    const from = path.join(ctx.root, p);
    const to = path.join(wt, p);
    let isLink = false;
    try { isLink = fs.lstatSync(to).isSymbolicLink(); } catch { /* none */ }
    if (exists(from) && !isLink && !exists(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // Windows needs a junction for a folder link without developer mode.
      fs.symlinkSync(from, to, process.platform === 'win32' && isDir(from) ? 'junction' : undefined);
      isLink = true;
    }
    const lines = exists(exclude) ? fs.readFileSync(exclude, 'utf8').split(/\r?\n/) : [];
    if (isLink && !lines.includes(`/${p}`)) {
      const text = exists(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      fs.appendFileSync(exclude, `${text && !text.endsWith('\n') ? '\n' : ''}/${p}\n`);
    }
  }
}

export interface StartOptions { from?: string }

/**
 * Starts the pipeline of <slug> in its worktree (made on the first start: branch <prefix><slug> from the base) and
 * returns at once; the run goes on in a detached supervisor. Exit codes: 0 started, 1 cannot start (no brief, settings
 * not on the base, git failed), 3 the parallel cap is reached, 4 already running, 5 already merged. A refused start is
 * recorded with its reason, so the control pane can show it.
 */
export function start(ctx: RunContext, slug: string, opts: StartOptions = {}): Outcome {
  const log = regFile(ctx, slug, 'wrapper.log');
  return withStartLock(ctx.reg, () => {
    fs.appendFileSync(log, `== ${now()} start ${slug}${opts.from ? ` --from ${opts.from}` : ''}\n`);
    const refuse = (code: number, message: string): Outcome => {
      fs.appendFileSync(log, `${message}\n`);
      if (!isRunning(readRecord(ctx.reg, slug))) {
        writeRecord(ctx.reg, { slug, worktree: '', pid: 0, started: now(), state: 'exited', exit_code: String(code), interrupted: false, finished: now(), message });
      }
      return fail(code, message);
    };
    const rec = readRecord(ctx.reg, slug);
    if (isRunning(rec)) return fail(4, `${slug} is already running (pid ${rec!.pid})`);
    const running = recordedSlugs(ctx.reg).filter(s => s !== slug && isRunning(readRecord(ctx.reg, s))).length;
    if (running >= ctx.maxParallel) {
      return refuse(3, `at most ${ctx.maxParallel} pipelines may run at once (SDLC_MAX_PARALLEL, or the project's maxParallel)`);
    }

    const docs = `${ctx.backlogDir}/${slug}`;
    const wt = rec?.worktree && exists(path.join(rec.worktree, '.git')) ? rec.worktree : path.join(ctx.wtBase, slug);
    const branch = branchOf(ctx, slug, rec?.worktree === wt ? rec : null);
    const base = pickBase(ctx);
    let created = false;
    if (!exists(path.join(wt, '.git'))) {
      if (!base) return refuse(1, 'the repository has no commit to start the branch from; commit first, or set SDLC_BASE');
      // Fail before creating anything. An item whose red-tests commit is already in the base was merged: its branch is
      // stale, and running it again would redo finished work on old code.
      if (!ctx.env.SDLC_ALLOW_MERGED && isMerged(ctx, slug, base)) {
        return refuse(5, `${slug} is already merged into ${base}. Delete branch ${branch} and its backlog entry, or set SDLC_ALLOW_MERGED=1 to run it again.`);
      }
      // If a specific base was requested (via SDLC_BASE or git.base) that lacks the settings, refuse it.
      // Otherwise, uncommitted settings in the main working tree will be mirrored into the worktree.
      if (ctx.base && exists(path.join(ctx.root, CONFIG_FILE)) && !committed(ctx, branch, CONFIG_FILE) && !committed(ctx, base, CONFIG_FILE)) {
        return refuse(1, `${CONFIG_FILE} is not committed on ${base}, which the worktree starts from. Commit it to ${base}, `
          + `or start from a branch that has it: SDLC_BASE=<branch> (or git.base in ${CONFIG_FILE}).`);
      }
      // The brief must be in the main working tree (it is copied) or committed on the branch or the base.
      if (!exists(path.join(ctx.root, docs, 'brief.md')) && !committed(ctx, branch, `${docs}/brief.md`) && !committed(ctx, base, `${docs}/brief.md`)) {
        return refuse(1, `Missing ${docs}/brief.md`);
      }
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      const add = branchExists(ctx, branch) ? git(ctx.root, ['worktree', 'add', wt, branch], ctx.env)
        : git(ctx.root, ['worktree', 'add', wt, '-b', branch, base], ctx.env);
      fs.appendFileSync(log, add.stdout + add.stderr);
      if (add.status !== 0) return refuse(1, `git worktree add ${wt} failed: ${add.stderr.trim().split('\n').pop()}`);
      created = true;
    }
    // Settings and brief not committed on the base yet are copied from the main working tree.
    const configPath = path.join(wt, CONFIG_FILE);
    if (!exists(configPath) && exists(path.join(ctx.root, CONFIG_FILE))) {
      fs.copyFileSync(path.join(ctx.root, CONFIG_FILE), configPath);
    }
    const brief = path.join(wt, docs, 'brief.md');
    if (!exists(brief)) {
      if (!exists(path.join(ctx.root, docs, 'brief.md'))) return refuse(1, `Missing ${docs}/brief.md`);
      fs.mkdirSync(path.dirname(brief), { recursive: true });
      fs.copyFileSync(path.join(ctx.root, docs, 'brief.md'), brief);
    }
    linkShared(ctx, wt);
    const logs = path.join(wt, docs, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.rmSync(regFile(ctx, slug, 'interrupt'), { force: true });
    const marker = regFile(ctx, slug, 'setup-pending');
    if (created && ctx.setup.length) fs.writeFileSync(marker, `${wt}\n`);
    const setup: SetupStep[] = exists(marker)
      ? ctx.setup.map(s => { const a = shellArgv(s.cmd, { env: ctx.env }); return { ...s, dir: path.join(wt, s.dir), argv: [a.file, ...a.args] }; })
      : [];

    const record: RunRecord = {
      slug, worktree: wt, pid: 0, started: now(), state: 'running', exit_code: '', interrupted: false, finished: '', message: '',
      branch, base, root: ctx.root, ...(opts.from ? { from: opts.from } : {}),
    };
    let pid: number;
    try {
      pid = startSupervisor({
        slug, recordFile: recordFile(ctx.reg, slug), interruptFile: regFile(ctx, slug, 'interrupt'), logFile: log,
        outFile: path.join(logs, 'run.out'), cwd: wt, argv: pipelineArgv(slug, opts.from, ctx.env), setup, setupMarker: marker,
        record: { ...record, pid: 0 },
      }, pipelineEnv(ctx, slug));
    } catch (e) {
      return refuse(1, `could not start the pipeline: ${(e as Error).message}`);
    }
    // The supervisor waits for this record before it writes the final one.
    writeRecord(ctx.reg, { ...record, pid });
    const line = `started ${slug} (pid ${pid}) in ${wt} on ${branch}${opts.from ? `, from ${opts.from}` : ''}`;
    fs.appendFileSync(log, `${line}\n`);
    return ok(line);
  });
}

/** Stops <pid> and everything it started, and waits until it has gone (SIGKILL after 10 s). */
async function stopProcess(pid: number): Promise<boolean> {
  killTree(pid, 'SIGTERM');
  for (let i = 0; i < 100 && alive(pid); i++) {
    if (i === 50) killTree(pid, 'SIGKILL');
    await sleep(200);
  }
  return !alive(pid);
}

/** Interrupts <slug>'s running pipeline and waits until it has gone, so it cannot write its record afterwards. */
async function stopRun(ctx: RunContext, slug: string, rec: Partial<RunRecord>): Promise<boolean> {
  fs.writeFileSync(regFile(ctx, slug, 'interrupt'), '');
  if (!await stopProcess(Number(rec.pid))) return false;
  // A supervisor killed hard leaves its record running: close it.
  const after = readRecord(ctx.reg, slug);
  if (after && after.state === 'running' && after.pid === rec.pid) {
    writeRecord(ctx.reg, { ...(after as RunRecord), state: 'exited', interrupted: true, finished: now() });
  }
  return true;
}

/** Stops the run of <slug>: 0 stopped or not running, 1 no run recorded or it would not stop. */
export async function stop(ctx: RunContext, slug: string): Promise<Outcome> {
  const rec = readRecord(ctx.reg, slug);
  if (!rec) return fail(1, `No run recorded for ${slug}`);
  if (!alive(rec.pid)) return ok(`${slug} is not running`);
  if (!await stopRun(ctx, slug, rec)) return fail(1, `could not stop ${slug} (pid ${rec.pid})`);
  return ok(`stopped ${slug}`);
}

export interface DiscardOptions { yes?: boolean; stop?: boolean }

/**
 * Deletes what a run left behind: its worktree (the path in its record, even when the settings changed since), its
 * local branch and its record. The branch tip is saved first in <reg>/<slug>.discarded. Without --yes it only says what
 * would go (exit 6). A running pipeline is refused (exit 4) unless --stop stops it first; nothing there: exit 1.
 */
export async function discard(ctx: RunContext, slug: string, opts: DiscardOptions = {}): Promise<Outcome> {
  const rec = readRecord(ctx.reg, slug);
  const wt = rec?.worktree || path.join(ctx.wtBase, slug);
  const branch = branchOf(ctx, slug, rec);
  if (!opts.stop && isRunning(rec)) return fail(4, `${slug} is running: stop it first, or pass --stop`);
  const tip = branchExists(ctx, branch) ? git(ctx.root, ['rev-parse', branch], ctx.env).stdout.trim() : '';
  const hasWt = exists(path.join(wt, '.git'));
  if (!hasWt && !tip && !rec && !exists(wt)) return fail(1, `Nothing to discard for ${slug}`);
  const base = rec?.base || pickBase(ctx);
  const ahead = tip && base ? Number(git(ctx.root, ['rev-list', '--count', `${base}..${branch}`], ctx.env).stdout.trim() || 0) : 0;
  // --no-optional-locks: a status read must not take index.lock while the pipeline may be committing in this worktree.
  const dirty = hasWt ? git(wt, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], ctx.env).stdout.split('\n').filter(Boolean).length : 0;
  const out = [`Discard ${slug}: worktree ${wt}, branch ${branch} (${ahead} commit(s) not in ${base || 'the base'}, ${dirty} uncommitted file(s)), run record`];
  if (!opts.yes) return { code: 6, out: [...out, 'Nothing deleted. Run again with --yes to discard it.'], err: [] };
  if (opts.stop && isRunning(rec) && !await stopRun(ctx, slug, rec!)) return fail(1, `could not stop ${slug} (pid ${rec!.pid})`);
  if (exists(wt) && !gitOk(ctx.root, ['worktree', 'remove', '--force', wt], ctx.env)) fs.rmSync(wt, { recursive: true, force: true });
  git(ctx.root, ['worktree', 'prune'], ctx.env);
  if (tip) git(ctx.root, ['branch', '-D', branch], ctx.env);
  for (const ext of ['json', 'interrupt', 'wrapper.log', 'setup-pending']) fs.rmSync(regFile(ctx, slug, ext), { force: true });
  if (!tip) return { code: 0, out: [...out, `Discarded ${slug}.`], err: [] };
  fs.mkdirSync(ctx.reg, { recursive: true });
  fs.writeFileSync(regFile(ctx, slug, 'discarded'), `git branch ${branch} ${tip}\n`);
  return { code: 0, out: [...out, `Discarded ${slug}. To get the branch back: git branch ${branch} ${tip}`], err: [] };
}

/**
 * Starts <slug> again from scratch: stops it, discards its worktree and branch (the tip is saved), and starts it.
 * Without --yes it shows what would be discarded (exit 6); an item already merged is refused (exit 5).
 */
export async function restart(ctx: RunContext, slug: string, opts: StartOptions & { yes?: boolean } = {}): Promise<Outcome> {
  const base = pickBase(ctx);
  if (!ctx.env.SDLC_ALLOW_MERGED && base && isMerged(ctx, slug, base)) {
    return fail(5, `${slug} is already merged into ${base}: a restart would be refused (SDLC_ALLOW_MERGED=1 overrides)`);
  }
  const d = await discard(ctx, slug, { yes: opts.yes, stop: true });
  if (d.code !== 0 && d.code !== 1) return d; // 1: nothing to discard, which is fine
  const s = start(ctx, slug, { from: opts.from });
  return { code: s.code, out: [...(d.code === 0 ? d.out : []), ...s.out], err: s.err };
}

/** One line per recorded run: its state and slug, then the exit code or pid. */
/**
 * The slugs of this project's runs. The run registry is shared by every checkout of the repository: a record names the
 * checkout that started it (root); one without (from the shell pipeline) belongs to the main working tree.
 */
export function projectSlugs(ctx: RunContext): string[] {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const here = real(ctx.root);
  const main = real(mainTree(ctx.root, ctx.env));
  return recordedSlugs(ctx.reg).filter(slug => {
    const rec = readRecord(ctx.reg, slug) || {};
    return real(typeof rec.root === 'string' && rec.root ? rec.root : main) === here;
  });
}

export function statusLines(ctx: RunContext): string[] {
  return projectSlugs(ctx).map(slug => {
    const rec = readRecord(ctx.reg, slug) || {};
    const state = runState(rec);
    const extra = state === 'running' ? `pid ${rec.pid}` : rec.exit_code !== undefined && rec.exit_code !== '' ? `exit ${rec.exit_code}` : '';
    return `${state.padEnd(12)} ${slug}${extra ? `  ${extra}` : ''}${rec.message ? `  ${rec.message}` : ''}`;
  });
}

/** Every record with the state worked out (running, stopped, interrupted, exited), for --json. */
export const statusRecords = (ctx: RunContext): (Partial<RunRecord> & { run: string })[] =>
  projectSlugs(ctx).map(slug => { const rec = readRecord(ctx.reg, slug) || {}; return { ...rec, slug, run: runState(rec) }; });

/** The folder `watch` reads: the run's worktree, else the main working tree for a run started in place; null: none. */
export function watchDir(ctx: RunContext, slug: string, cwdRoot: string): string | null {
  const wt = runWorktree(ctx, slug);
  if (wt) return wt;
  for (const d of [cwdRoot, ctx.root]) if (exists(path.join(d, ctx.backlogDir, slug, 'logs', 'status.json'))) return d;
  return null;
}

const tailLines = (file: string, n: number): string[] => {
  const lines = fs.readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');
  return lines.slice(-n);
};

/** One frame of `watch`: the status.json line, the run state, the uncommitted files and the last lines of run.out. */
export function watchFrame(ctx: RunContext, slug: string, dir: string): string[] {
  const logs = path.join(dir, ctx.backlogDir, slug, 'logs');
  const out: string[] = [];
  const status = path.join(logs, 'status.json');
  out.push(exists(status) ? fs.readFileSync(status, 'utf8').trim() : `(no status.json yet in ${logs})`);
  const rec = readRecord(ctx.reg, slug);
  if (rec) {
    if (rec.interrupted === true) out.push('run: interrupted (stopped by the user)');
    else if (rec.state === 'exited') out.push(`run: finished, exit code ${rec.exit_code}${rec.message ? ` (${rec.message})` : ''}`);
    else if (rec.state === 'running' && !alive(rec.pid)) out.push('run: process has gone (stopped without finishing)');
  }
  // --no-optional-locks: a status read must not take index.lock while the pipeline may be committing in this worktree.
  const st = git(dir, ['--no-optional-locks', 'status', '--short'], ctx.env);
  out.push(...(st.stdout + st.stderr).split('\n').filter(Boolean).slice(0, 15));
  const runOut = path.join(logs, 'run.out');
  if (exists(runOut)) out.push('--- run.out (last 5 lines)', ...tailLines(runOut, 5));
  return out;
}

/** Whether `watch --follow` should keep refreshing: there is no record (a run in place), or the run is going on. */
export const stillGoing = (ctx: RunContext, slug: string): boolean => { const r = readRecord(ctx.reg, slug); return !r || isRunning(r); };

export type ChangeCount = { changed: number; uncommitted: number; files: string[] } | { error: string };

/** The files <slug>'s pipeline changed in its worktree, against the base in its record (else the base of new runs). */
export function runChanges(ctx: RunContext, slug: string, defaultBase?: () => string): ChangeCount & { worktree?: string } {
  const rec = readRecord(ctx.reg, slug);
  const wt = runWorktree(ctx, slug);
  if (!wt) return { error: rec ? `Worktree for ${slug} is gone` : `No pipeline for ${slug}` };
  const base = rec?.base || (defaultBase ? defaultBase() : pickBase(ctx));
  const c = worktreeChanges(wt, base);
  return { worktree: wt, changed: c.files.length, uncommitted: c.uncommitted, files: c.files };
}

/** The counts of every recorded run (or of <slugs>) in one answer, for a monitor watching several pipelines. */
export function allChanges(ctx: RunContext, slugs: string[] = []): Record<string, { changed: number; uncommitted: number } | { error: string }> {
  let base: string | undefined;
  const lazyBase = () => (base ??= pickBase(ctx));
  const runs: Record<string, { changed: number; uncommitted: number } | { error: string }> = {};
  for (const slug of slugs.length ? slugs : projectSlugs(ctx)) {
    const c = runChanges(ctx, slug, lazyBase);
    runs[slug] = 'error' in c ? { error: c.error } : { changed: c.changed, uncommitted: c.uncommitted };
  }
  return runs;
}
