// Process identity: a pid alone is reused by the system, so a run's process is named by its pid and its start time.
// (docs/plans/web-performance.md P2; the same primitive as step A2 of docs/plans/detached-jobs.md.)
import { spawnSync } from '../trace.js';

/** A process, named so that a later process with the same pid is not taken for it. */
export interface ProcIdentity {
  pid: number;
  /** `LC_ALL=C ps -o lstart=` of the process, with single spaces; '' when it could not be read (Windows, no ps). */
  start: string;
  bootId?: string;
}

// Read at each call: the caller's PATH decides which ps runs.
const cLocale = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C' });
const oneSpace = (s: string): string => s.trim().replace(/\s+/g, ' ');

/** When process <pid> started, as ps prints it in the C locale; '' when it is gone, on Windows, or when ps cannot say. */
export function procStart(pid: unknown): string {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0 || process.platform === 'win32') return '';
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(n)], { encoding: 'utf8', env: cLocale() });
  return r.status === 0 ? oneSpace(r.stdout || '') : '';
}

/** The identity of process <pid> as it is now. */
export const identity = (pid: number): ProcIdentity => ({ pid, start: procStart(pid) });

/**
 * Whether process <pid> is running. kill(pid, 0) also succeeds on a zombie (exited, not yet collected by its parent),
 * which is not alive; `ps` tells them apart (on Windows there is no ps, and kill(pid, 0) is all there is).
 * With <start> (see procStart), a process that has this pid but started at another time is not it: the same `ps` call
 * also prints the start time, so the check costs no extra process. Without <start> the pid alone decides, as before.
 */
export function alive(pid: unknown, start?: string): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  if (process.platform === 'win32') return true;
  const r = start
    ? spawnSync('ps', ['-o', 'stat=,lstart=', '-p', String(n)], { encoding: 'utf8', env: cLocale() })
    : spawnSync('ps', ['-o', 'stat=', '-p', String(n)], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  if (r.status !== 0 && !out) return false;
  if (out.startsWith('Z')) return false;
  if (!start) return true;
  const got = oneSpace(out.replace(/^\S+/, ''));
  // ps that printed no start time cannot contradict the record: the pid decides, as it does without one.
  return !got || got === oneSpace(start);
}

/** Whether the process named by <id> is still that process (its pid alone when no start time was recorded). */
export const sameProcess = (id?: ProcIdentity | null): boolean => Boolean(id) && alive(id!.pid, id!.start || undefined);
