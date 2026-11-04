// The trace: one JSON line per action that can repeat (a spawn, a timer tick, a request, an SSE event), with a
// microsecond time, so the repeats are visible and each can be judged "needed", "a guard" or "a finding"
// (docs/plans/run-view-performance.md, section 4a). Always on; the file rotates by size and age.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync as nodeSpawnSync, execFileSync as nodeExecFileSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';

export interface TraceSettings { enabled: boolean; maxSizeKb: number; keepFiles: number; maxAgeHours: number }
export const TRACE_DEFAULTS: TraceSettings = { enabled: true, maxSizeKb: 5120, keepFiles: 4, maxAgeHours: 24 };
export const TRACE_FILE = 'ui-trace.jsonl';

/** One event. `t` (epoch microseconds) is added by the writer. */
export interface TraceEvent {
  side?: 'server' | 'client';
  action: string;
  why?: string;
  run?: string;
  ms?: number;
  changed?: boolean;
  n?: number;
  /** An exit code (-1: killed or not started). */
  code?: number;
}
export interface TraceLine extends TraceEvent { t: number }

const num = (v: unknown, min: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : null);

/**
 * The settings of the `trace` block of sdlc.config.json with the environment on top (SDLC_TRACE=0, SDLC_TRACE_MAX_KB,
 * SDLC_TRACE_KEEP, SDLC_TRACE_MAX_AGE_HOURS). A bad value keeps its default and is reported in <errors>.
 */
export function traceSettings(block: unknown, env: NodeJS.ProcessEnv = process.env): { settings: TraceSettings; errors: string[] } {
  const settings = { ...TRACE_DEFAULTS };
  const errors: string[] = [];
  const b = block && typeof block === 'object' ? (block as Record<string, unknown>) : {};
  if (block !== undefined && block !== null && (typeof block !== 'object' || Array.isArray(block))) errors.push('trace: must be an object');
  if (b.enabled !== undefined) { if (typeof b.enabled === 'boolean') settings.enabled = b.enabled; else errors.push('trace.enabled: must be true or false'); }
  const pick = (key: 'maxSizeKb' | 'keepFiles' | 'maxAgeHours', min: number, envName: string, integer: boolean) => {
    const raw = env[envName];
    const fromEnv = raw !== undefined && raw !== '' ? Number(raw) : undefined;
    if (fromEnv !== undefined) {
      const v = num(fromEnv, min);
      if (v !== null && (!integer || Number.isInteger(v))) { settings[key] = v; return; }
      errors.push(`${envName}: must be ${integer ? 'a whole number' : 'a number'} of at least ${min}`);
    }
    if (b[key] === undefined) return;
    const v = num(b[key], min);
    if (v !== null && (!integer || Number.isInteger(v))) settings[key] = v;
    else errors.push(`trace.${key}: must be ${integer ? 'a whole number' : 'a number'} of at least ${min}`);
  };
  pick('maxSizeKb', 1, 'SDLC_TRACE_MAX_KB', false);
  pick('keepFiles', 0, 'SDLC_TRACE_KEEP', true);
  pick('maxAgeHours', 0.01, 'SDLC_TRACE_MAX_AGE_HOURS', false);
  if (env.SDLC_TRACE === '0') settings.enabled = false;
  return { settings, errors };
}

/** The current time in epoch microseconds, from performance.timeOrigin + performance.now() (never goes backwards). */
let lastT = 0;
export function microNow(): number {
  const t = Math.round((performance.timeOrigin + performance.now()) * 1000);
  lastT = t > lastT ? t : lastT + 1;
  return lastT;
}

const rotated = (file: string, i: number): string => file.replace(/\.jsonl$/, `.${i}.jsonl`);

/**
 * Appends whole lines (open in append mode, write, close) so several processes can share the file. Rotation: the file
 * moves to .1 when it reaches maxSizeKb or is older than maxAgeHours (the older ones shift up); the files past keepFiles,
 * and rotated files older than twice maxAgeHours, are deleted. Only the process that owns the file should rotate.
 */
export function rotateIfNeeded(file: string, s: TraceSettings, nowMs: number = Date.now()): boolean {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return false; }
  const old = nowMs - st.mtimeMs > s.maxAgeHours * 3600_000 || nowMs - st.birthtimeMs > s.maxAgeHours * 3600_000;
  if (st.size < s.maxSizeKb * 1024 && !old) return false;
  if (s.keepFiles === 0) { try { fs.unlinkSync(file); } catch { /* gone */ } return true; }
  try { fs.unlinkSync(rotated(file, s.keepFiles)); } catch { /* none */ }
  for (let i = s.keepFiles - 1; i >= 1; i--) { try { fs.renameSync(rotated(file, i), rotated(file, i + 1)); } catch { /* none */ } }
  try { fs.renameSync(file, rotated(file, 1)); } catch { /* raced */ }
  return true;
}

/** Deletes rotated files older than twice maxAgeHours. */
export function dropOld(file: string, s: TraceSettings, nowMs: number = Date.now()): void {
  for (let i = 1; i <= s.keepFiles + 4; i++) {
    const f = rotated(file, i);
    try { if (nowMs - fs.statSync(f).mtimeMs > 2 * s.maxAgeHours * 3600_000) fs.unlinkSync(f); } catch { /* none */ }
  }
}

/** The trace files in time order (oldest first): the highest rotation number first, the current file last. */
export function traceFiles(file: string): string[] {
  const out: string[] = [];
  for (let i = 12; i >= 1; i--) if (fs.existsSync(rotated(file, i))) out.push(rotated(file, i));
  if (fs.existsSync(file)) out.push(file);
  return out;
}

export interface Tracer {
  /** Adds one event to the buffer (written at the next flush). */
  add(e: TraceEvent): void;
  /** Writes the buffer now. */
  flush(): void;
  /** Stops the timer and writes what is left. */
  close(): void;
}

export interface TracerOptions {
  file: string;
  settings: TraceSettings;
  /** Whether this process rotates (the UI server does). */
  rotate?: boolean;
  /** How often the buffer is written, in ms (default 1000). */
  flushMs?: number;
  clock?: () => number;
}

export function createTracer(o: TracerOptions): Tracer {
  const buffer: string[] = [];
  const clock = o.clock || Date.now;
  let timer: NodeJS.Timeout | null = null;
  const flush = (): void => {
    if (!buffer.length) return;
    const text = buffer.splice(0).join('');
    try {
      fs.mkdirSync(path.dirname(o.file), { recursive: true });
      if (o.rotate) { rotateIfNeeded(o.file, o.settings, clock()); dropOld(o.file, o.settings, clock()); }
      fs.appendFileSync(o.file, text);
    } catch { /* a trace must never break the program */ }
  };
  return {
    add(e) {
      if (!o.settings.enabled) return;
      buffer.push(`${JSON.stringify({ t: microNow(), side: 'server', ...e })}\n`);
      if (buffer.length > 5000) flush();
      if (!timer) { timer = setTimeout(() => { timer = null; flush(); }, o.flushMs ?? 1000); timer.unref(); }
    },
    flush,
    close() { if (timer) { clearTimeout(timer); timer = null; } flush(); },
  };
}

let current: Tracer | null = null;
const early: TraceEvent[] = [];

/** Starts the process-wide trace (the UI server calls this); events added before it are written first. */
export function startTrace(o: TracerOptions): Tracer {
  if (current) current.close();
  current = createTracer(o);
  for (const e of early.splice(0)) current.add(e);
  process.once('exit', () => current && current.flush());
  return current;
}

export function stopTrace(): void { if (current) current.close(); current = null; early.length = 0; }

/** Adds one event to the process-wide trace; before startTrace a few are kept, and none when the trace is off. */
export function trace(e: TraceEvent): void {
  if (current) current.add(e);
  else if (early.length < 500 && process.env.SDLC_TRACE !== '0') early.push(e);
}

/** Runs <fn> and traces it as <action>, with its duration and (when <changed> is given) whether the result differs. */
export function traced<T>(action: string, why: string | undefined, fn: () => T, changed?: (r: T) => boolean | undefined): T {
  const t0 = performance.now();
  const r = fn();
  trace({ action, why, ms: Math.round((performance.now() - t0) * 1000) / 1000, ...(changed ? { changed: changed(r) } : {}) });
  return r;
}

/** The word after the program that says what it does: `git -C <dir> merge-base` gives merge-base, `ps -A` gives nothing. */
function firstWord(command: string, args: readonly string[]): string | undefined {
  const rest = path.basename(command) === 'git' && args[0] === '-C' ? args.slice(2) : args;
  const w = rest[0];
  return w && !w.startsWith('-') && !w.includes('/') && !w.includes('=') && w.length <= 24 ? w : undefined;
}

/** child_process.spawnSync with a trace line per call: the program, its first argument and the exit code, never the rest. */
export const spawnSync = ((command: string, args?: readonly string[] | SpawnSyncOptions, options?: SpawnSyncOptions) => {
  const list = Array.isArray(args) ? (args as readonly string[]) : [];
  const t0 = performance.now();
  const r = (nodeSpawnSync as (c: string, a?: unknown, o?: unknown) => SpawnSyncReturns<string | Buffer>)(command, args, options);
  trace({ action: `spawn:${path.basename(command)}`, why: firstWord(command, list), ms: Math.round((performance.now() - t0) * 1000) / 1000, code: r.status === null ? -1 : r.status });
  return r;
}) as typeof nodeSpawnSync;

/** child_process.execFileSync with a trace line per call (same fields as spawnSync; the code is 0, or the failing status). */
export const execFileSync = ((command: string, args?: readonly string[] | object, options?: object) => {
  const list = Array.isArray(args) ? (args as readonly string[]) : [];
  const t0 = performance.now();
  let code = 0;
  try { return (nodeExecFileSync as (c: string, a?: unknown, o?: unknown) => string | Buffer)(command, args, options); } catch (e) {
    code = typeof (e as { status?: number }).status === 'number' ? (e as { status: number }).status : -1;
    throw e;
  } finally {
    trace({ action: `spawn:${path.basename(command)}`, why: firstWord(command, list), ms: Math.round((performance.now() - t0) * 1000) / 1000, code });
  }
}) as typeof nodeExecFileSync;
