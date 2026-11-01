import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { exists, readSettings } from '../util.js';
import { codeSearchErrors, codeSearchFor } from '../config/codeSearch.js';
import { nodeRun } from '../config/node.js';
import { agentFor, resolve, type Config } from '../config/settings.js';
import { AGENT_STAGES } from '../pipeline/context.js';
import { shellArgv, which } from '../shell.js';

/** Runs a program and waits for it; status is null when it could not be started. */
export type Spawn = (cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean }) =>
  { status: number | null; stdout: string; stderr: string };

export const defaultSpawn: Spawn = (cmd, args, { cwd, env, windowsVerbatimArguments }) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', windowsVerbatimArguments });
  return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
};

export interface Check {
  name: string;
  ok: boolean;
  /** A failed required check makes doctor fail; the others are recommendations. */
  required: boolean;
  detail: string;
  /** How to fix it, when it failed. */
  fix?: string;
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
  /** Finds a program on PATH (default: shell.ts which, with PATHEXT on Windows). */
  which?: (name: string, env: NodeJS.ProcessEnv) => string | null;
  /** The Node running the tool (process.versions.node). */
  nodeVersion?: string;
  /** Run each suite's test command once. */
  runTests?: boolean;
}

export const MIN_NODE = 18;

/** The backlog folder: from the resolved settings, else a usable backlogDir in sdlc.config.json, else Docs/backlog. */
export function backlogDirOf(config: Config | null, root: string): string {
  if (config) return config.backlogDir;
  const own = readSettings(root).backlogDir;
  return (typeof own === 'string' && own.replace(/\/+$/, '')) || 'Docs/backlog';
}
const tail = (s: string, n = 5) => s.trim().split('\n').slice(-n).join('\n');

/** Everything the pipeline needs to run on the project at <dir>, checked one by one. */
export function doctor(dir: string, opts: DoctorOptions = {}): Check[] {
  const env = opts.env || process.env;
  const spawn = opts.spawn || defaultSpawn;
  const node = opts.nodeVersion || process.versions.node;
  const checks: Check[] = [];
  const add = (c: Check) => { checks.push(c); };

  const major = Number(node.split('.')[0]);
  add({ name: 'tool Node', ok: major >= MIN_NODE, required: true, detail: `the tool runs on Node ${node} (needs ${MIN_NODE} or newer)`,
    fix: `install Node ${MIN_NODE} or newer for the tool (the project may keep its own version)` });

  const gitV = spawn('git', ['--version'], { env });
  add({ name: 'git', ok: gitV.status === 0, required: true, detail: gitV.status === 0 ? gitV.stdout.trim() : 'git is not on PATH', fix: 'install git' });
  const top = gitV.status === 0 ? spawn('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env }) : null;
  const isRepo = Boolean(top && top.status === 0);
  const root = isRepo ? path.resolve(top!.stdout.trim()) : dir;
  add({ name: 'git repository', ok: isRepo, required: true, detail: isRepo ? root : `${dir} is not in a git repository`,
    fix: `run git init in ${dir}, or point doctor at a git repository` });

  const { config, errors, warnings } = resolve(root, { env });
  const whichFn = (opts.which || ((name, e) => which(name, { env: e })));
  const used = new Set<string>(config ? [config.agent.harness, ...AGENT_STAGES.map(st => agentFor(config, st).harness)] : env.SDLC_AGENT ? [env.SDLC_AGENT] : []);
  const cli = (bin: string, label: string, fix: string) => {
    const found = whichFn(bin, env);
    add({ name: `${label} CLI`, ok: found !== null, required: true, detail: found !== null ? found : `the ${bin} command is not on PATH`, fix });
  };

  if (used.size === 0 || (used.size === 1 && used.has('claude'))) {
    const claude = whichFn('claude', env);
    const codex = whichFn('codex', env);
    const agy = whichFn('agy', env);
    if (used.size === 0 && !claude && codex) {
      add({ name: 'codex CLI', ok: true, required: true, detail: codex, fix: '' });
    } else if (used.size === 0 && !claude && agy) {
      add({ name: 'agy CLI', ok: true, required: true, detail: agy, fix: '' });
    } else {
      add({ name: 'claude CLI', ok: claude !== null, required: true,
        detail: claude !== null ? claude : 'the claude command is not on PATH',
        fix: 'install Claude Code (npm install -g @anthropic-ai/claude-code) and make sure claude is on PATH' });
    }
  } else {
    // Every harness the project uses (its default and any agent.stages entry) must be installed.
    if (used.has('claude')) cli('claude', 'claude', 'install Claude Code (npm install -g @anthropic-ai/claude-code) and make sure claude is on PATH');
    if (used.has('codex')) cli('codex', 'codex', 'install OpenAI Codex CLI and make sure codex is on PATH');
    if (used.has('agy')) cli('agy', 'agy', 'install Google Antigravity CLI and make sure agy is on PATH');
  }

  add({ name: 'settings', ok: !errors.length && config !== null, required: true,
    detail: errors.length ? errors.join('; ') : `settings resolve${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`,
    fix: `fix sdlc.config.json (see: ai-sdlc-helper show ${root}); without tests, see: ai-sdlc-helper suggest ${root}` });

  const file = readSettings(root);
  const n = config ? config.node : nodeRun(root, file.node || {}, env);
  add({ name: 'project Node', ok: !n.warning, required: false,
    detail: n.warning || (n.switchTo ? `commands run with Node ${n.switchTo} through ${n.manager}` : `commands run with Node ${n.current}`),
    fix: 'install fnm, Volta or nvm, or set "node": { "version": "current" } in sdlc.config.json' });

  const search = codeSearchFor(root, codeSearchErrors(file).length ? {} : file, env);
  add({ name: 'code indexer', ok: !search.warning, required: false,
    detail: search.codeSearch === 'none' ? (search.warning || 'code search uses Grep and Glob (agent.codeSearch is "none")') : `code search uses ${search.codeSearch}`,
    fix: `see the indexers with: ai-sdlc-helper code-search ${root} --list` });

  const backlogDir = backlogDirOf(config, root);
  const index = path.join(root, backlogDir, 'index.md');
  add({ name: 'backlog index', ok: exists(index), required: true, detail: exists(index) ? `${backlogDir}/index.md` : `${backlogDir}/index.md is missing`,
    fix: `run ai-sdlc-helper add ${root}, or create ${backlogDir}/index.md` });

  if (opts.runTests && config) {
    for (const s of config.suites) {
      const a = shellArgv(s.runCmd, { env });
      const r = spawn(a.file, a.args, { cwd: root, env, windowsVerbatimArguments: a.windowsVerbatimArguments });
      add({ name: `tests: ${s.name}`, ok: r.status === 0, required: true,
        detail: r.status === 0 ? `${s.runCmd} passed` : `${s.runCmd} exited ${r.status ?? 'without starting'}${tail(r.stderr || r.stdout) ? `:\n${tail(r.stderr || r.stdout)}` : ''}`,
        fix: `make the suite pass (run it yourself: ${s.runCmd})` });
    }
  }
  return checks;
}

/** Whether every required check passed. */
export const doctorOk = (checks: Check[]): boolean => checks.every(c => c.ok || !c.required);
