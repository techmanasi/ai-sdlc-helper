// The run registry: one record per pipeline run in <git common dir>/sdlc-runs/<slug>.json, outside every worktree, so
// every checkout (and the control pane) sees the same runs. The fields are the ones scripts/sdlc-mod.sh wrote.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const STAGES = ['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'review', 'ship'] as const;

export interface RunRecord {
  slug: string;
  /** Absolute path of the run's worktree ("" for a start that was refused). */
  worktree: string;
  /** The supervisor process (0 when none was started). */
  pid: number;
  started: string;
  state: 'running' | 'exited';
  /** The pipeline's exit code as text, "" while running: 0 done, 1 failed, 2 paused for answers. */
  exit_code: string;
  interrupted: boolean;
  finished: string;
  /** Why a start was refused or a run could not begin. */
  message: string;
  branch?: string;
  /** The ref the branch was started from (the changes are counted against it). */
  base?: string;
  from?: string;
  /** The checkout the run was started from: its settings, run controls and saved rules belong to it. */
  root?: string;
}

/** Local time as the records and status.json write it: 2026-10-17T09:30:00. */
export function now(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** <git common dir>/sdlc-runs for the repository holding <root>. */
export function registryDir(root: string): string {
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  const common = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : '.git';
  return path.join(path.resolve(root, common), 'sdlc-runs');
}

export const recordFile = (reg: string, slug: string): string => path.join(reg, `${slug}.json`);

/** The run record of <slug>, or null; a file that is not JSON reads as {} (it exists, its fields are unknown). */
export function readRecord(reg: string, slug: string): Partial<RunRecord> | null {
  const f = recordFile(reg, slug);
  let text: string;
  try { text = fs.readFileSync(f, 'utf8'); } catch { return null; }
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** Writes a record atomically (a temporary file, then a rename), so a reader never sees half of one. */
export function writeRecord(reg: string, rec: RunRecord): void {
  fs.mkdirSync(reg, { recursive: true });
  const f = recordFile(reg, rec.slug);
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(rec)}\n`);
  fs.renameSync(`${f}.tmp`, f);
}

/** The slugs that have a record, sorted. */
export function recordedSlugs(reg: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(reg); } catch { return []; }
  return names.filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).filter(s => SLUG.test(s)).sort();
}

/**
 * Whether process <pid> is running. kill(pid, 0) also succeeds on a zombie (exited, not yet collected by its parent),
 * which is not alive; `ps` tells them apart (on Windows there is no ps, and kill(pid, 0) is all there is).
 */
export function alive(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  if (process.platform === 'win32') return true;
  const r = spawnSync('ps', ['-o', 'stat=', '-p', String(n)], { encoding: 'utf8' });
  if (r.status !== 0 && !r.stdout.trim()) return false;
  return !r.stdout.trim().startsWith('Z');
}

/** A record's run is going on: state running and its supervisor alive. */
export const isRunning = (rec: Partial<RunRecord> | null): boolean => Boolean(rec && rec.state === 'running' && alive(rec.pid));

/** <pid> and every process below it, children after their parent (from one `ps` listing; none on Windows). */
export function processTree(pid: number): number[] {
  const tree = [pid];
  if (process.platform === 'win32') return tree;
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map<number, number[]>();
  for (const line of (r.stdout || '').split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p || !pp) continue;
    children.set(pp, [...(children.get(pp) || []), p]);
  }
  for (let i = 0; i < tree.length; i++) for (const c of children.get(tree[i]) || []) if (!tree.includes(c)) tree.push(c);
  return tree;
}

/** How killTree reaches the system; injectable for tests. */
export interface KillHost {
  platform?: NodeJS.Platform;
  run?: (cmd: string, args: string[]) => void;
}

/**
 * Sends <signal> to <pid> and everything it started. On Windows, where there is no ps and no signals, it runs
 * `taskkill /PID <pid> /T /F`, which ends the tree at once whatever the signal.
 */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM', host: KillHost = {}): void {
  if (!Number.isInteger(pid) || pid <= 1) return; // 0 and negative numbers would signal whole process groups
  if ((host.platform || process.platform) === 'win32') {
    const run = host.run || ((cmd, args) => { spawnSync(cmd, args, { windowsHide: true }); });
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  for (const p of processTree(pid)) { try { process.kill(p, signal); } catch { /* already gone */ } }
}

/** What a record says about its run, in one word: running, stopped (gone without finishing), interrupted, exited. */
export function runState(rec: Partial<RunRecord>): string {
  if (rec.interrupted === true) return 'interrupted';
  if (rec.state === 'running') return alive(rec.pid) ? 'running' : 'stopped';
  return rec.state || 'unknown';
}

const realOr = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** The main working tree of the repository holding <dir> (the first in `git worktree list`), else <dir>. */
export function mainTree(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync('git', ['-C', dir, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', env });
  const line = r.status === 0 ? r.stdout.split('\n').find(l => l.startsWith('worktree ')) : undefined;
  return line ? line.slice('worktree '.length) : dir;
}

/**
 * The project a command run in <dir> works on: the checkout holding <dir> (its git top level), so a project that is
 * itself one worktree of a repository uses its own settings; or, when that checkout is a pipeline run's worktree, the
 * checkout the run was started from (its record's root; a record without one: the main working tree).
 */
export function projectRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
  const top = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : dir;
  const reg = registryDir(top);
  const here = realOr(top);
  for (const slug of recordedSlugs(reg)) {
    const rec = readRecord(reg, slug);
    if (rec && typeof rec.worktree === 'string' && rec.worktree && realOr(rec.worktree) === here) {
      return typeof rec.root === 'string' && rec.root ? rec.root : mainTree(top, env);
    }
  }
  return top;
}
