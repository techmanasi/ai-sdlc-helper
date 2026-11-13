// How the board learns that something it shows has changed.
//
// Two tools. A WATCHER (fs.watch on the folders the board reads) says "something changed here" within milliseconds
// and costs nothing while nothing happens. A FINGERPRINT (the modification time and size of every file the board
// reads, as one text) says whether anything changed since it was last taken; taking one costs a file stat per file.
// The watcher is used first and alone. The fingerprint is only its auditor, and its stand-in when it does not work.
//
// States and what moves between them:
//
//   watching   Watchers attached. An event rebuilds the board (after `debounceMs`). No fingerprint is compared
//              while events keep coming. After `silenceMs` without an event, one AUDIT is made.
//   audit      The fingerprint is compared with the one taken at the last rebuild.
//                same      -> the watcher missed nothing: failures = 0, back to watching. The host is told it
//                             is quiet, and uses that to check that a run said to be going still is.
//                differs   -> the watcher MISSED a change: a failure.
//   waiting    Not a state of its own: a folder that does not exist yet is waited for on the nearest folder above
//              it that does, by name. When it appears the watchers are attached again. Not a failure.
//   failure    Counted when an audit finds a missed change, when a watcher raises an error, or when a watcher
//              cannot be attached. The board is rebuilt, every watcher is closed and attached again, back to
//              watching. Silence alone is never a failure: a quiet project is silent for hours.
//   fallback   Entered at `failureLimit` failures in a row. No watcher is attached. The fingerprint is compared
//              every `fallbackMs` and a difference rebuilds the board. It lasts until the process restarts;
//              every start begins in watching again.
//
// Longest time a change can go unseen: watching, the watcher works: `debounceMs`. Watching, the watcher is deaf:
// `silenceMs` after the last event. Fallback: `fallbackMs`.
//
// Where the numbers come from (scripts/watch-probe.mjs, macOS, APFS, 400 changes on two volumes): no event was
// missed, the first event came 12 ms after a change at the median and 20 ms at worst. Real runs go 2 to 33 minutes
// (90th percentile) without changing a file the board reads, so silence says nothing about health. `silenceMs` is
// therefore not a failure detector but the bound on how long a deaf watcher can hide a change; it is set to 30 s,
// the same safety tick the run page's stream uses. One audit of this repository's board (169 files, 29 folders) took 1.1 ms at
// the median and 2.1 ms at worst, so two a minute cost about 2 ms a minute.
import fs from 'node:fs';
import path from 'node:path';

export interface BoardWatchTimings {
  /** Wait this long after an event before rebuilding, so a burst of writes makes one rebuild (ms). */
  debounceMs: number;
  /** After this long without an event, compare the fingerprint once (ms). Measured: see the file header. */
  silenceMs: number;
  /** This many failures in a row end the watching for this process (a count; required: 10). */
  failureLimit: number;
  /** In fallback, compare the fingerprint this often (ms; required: 5 s). */
  fallbackMs: number;
}
export const BOARD_WATCH_TIMINGS: BoardWatchTimings = { debounceMs: 150, silenceMs: 30_000, failureLimit: 10, fallbackMs: 5_000 };

export type BoardWatchState = 'watching' | 'fallback';
/** A watcher on one folder, as fs.watch gives it: it calls back on any change, and may report an error. */
export type WatchFn = (dir: string, onEvent: (file?: string) => void, onError: () => void) => { close(): void };

export interface BoardWatchHost {
  /** The folders to watch now, whether they exist yet or not (asked again at every attach and after every rebuild: a new run adds folders). */
  folders(): string[];
  /** The fingerprint of everything the board reads, now. */
  fingerprint(): string;
  /** Whether a change to <file> in <dir> can be left alone (a run's output, an agent's log): no rebuild, no fingerprint. */
  ignore?(dir: string, file: string): boolean;
  /** Rebuild the board; <why> is 'watch', 'audit', 'error' or 'fallback'. */
  rebuild(why: string): void;
  /**
   * Called when a comparison found nothing changed (a clean audit, or a fallback check). The one thing no file tells
   * is a run whose process died without a word, so the host uses this moment, and no timer of its own, to look.
   */
  quiet?(): void;
  /** One line per state change and per audit, for the trace. */
  trace?(event: { action: string; why?: string; changed?: boolean; n?: number }): void;
  /** fs.watch by default; tests pass a watcher they control. */
  watch?: WatchFn;
}

export interface BoardWatch {
  state(): BoardWatchState;
  /** Counters for tests and the trace: fingerprints compared, failures in a row, watchers attached now. */
  stats(): { audits: number; failures: number; attached: number; attaches: number };
  /** The board is about to be rebuilt for another reason (a page joined, a liveness tick): take the fingerprint as the new baseline first. */
  baseline(): void;
  close(): void;
}

const nodeWatch: WatchFn = (dir, onEvent, onError) => {
  const w = fs.watch(dir, (_event, file) => onEvent(file ? String(file) : undefined));
  w.on('error', () => onError());
  return w;
};

export function createBoardWatch(host: BoardWatchHost, timings: BoardWatchTimings = BOARD_WATCH_TIMINGS): BoardWatch {
  const watch = host.watch || nodeWatch;
  const say = (action: string, why?: string, extra: { changed?: boolean; n?: number } = {}): void => { host.trace?.({ action, why, ...extra }); };
  let state: BoardWatchState = 'watching';
  let closed = false;
  let handles: { close(): void }[] = [];
  let watched = '';
  let reattach = false;
  let built = '';
  let failures = 0;
  let audits = 0;
  let attaches = 0;
  let debounce: NodeJS.Timeout | null = null;
  let silence: NodeJS.Timeout | null = null;
  let fallback: NodeJS.Timeout | null = null;

  const detach = (): void => { for (const h of handles) { try { h.close(); } catch { /* already closed */ } } handles = []; watched = ''; };
  const armSilence = (): void => {
    if (silence) clearTimeout(silence);
    silence = setTimeout(audit, timings.silenceMs);
    silence.unref?.();
  };

  /** The fingerprint is taken BEFORE the board is built: a change made during the build then shows at the next audit. */
  const rebuild = (why: string): void => { built = host.fingerprint(); host.rebuild(why); };

  /**
   * Attaches a watcher to every folder; false when one could not be attached. A folder that does not exist yet (the
   * register before the first run, a new run's logs) is WAITED FOR instead: the nearest folder above it that does
   * exist is watched for that one name, and when the name appears the watchers are attached again.
   */
  function attach(): boolean {
    detach();
    attaches++;
    reattach = false;
    const dirs = [...new Set(host.folders())].sort();
    const seen = new Map<string, { all: boolean; awaited: Set<string> }>();
    /** Watches <dir>: every change when <all>, otherwise only the names awaited in it. False: it does not exist. */
    const open = (dir: string, all: boolean, name?: string): boolean => {
      let entry = seen.get(dir);
      if (!entry) {
        const made = { all: false, awaited: new Set<string>() };
        try {
          handles.push(watch(dir, file => {
            if (!file || made.awaited.has(file)) { reattach = true; return onEvent(dir, undefined); }
            if (made.all) onEvent(dir, file);
          }, onError));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw e;
        }
        seen.set(dir, entry = made);
      }
      if (all) entry.all = true;
      if (name) entry.awaited.add(name);
      return true;
    };
    try {
      for (const d of dirs) {
        if (open(d, true)) continue;
        for (let child = d, parent = path.dirname(d); parent !== child; child = parent, parent = path.dirname(parent)) {
          if (open(parent, false, path.basename(child))) break;
        }
      }
    } catch { detach(); return false; }
    watched = dirs.join('\n');
    return true;
  }

  function fail(why: string): void {
    if (closed || state !== 'watching') return;
    failures++;
    say('board-watch:failure', why, { n: failures });
    if (failures >= timings.failureLimit) return enterFallback();
    if (!attach()) return fail('attach');
    armSilence();
  }

  function enterFallback(): void {
    state = 'fallback';
    detach();
    if (debounce) { clearTimeout(debounce); debounce = null; }
    if (silence) { clearTimeout(silence); silence = null; }
    say('board-watch:fallback', `after ${failures} failures`, { n: failures });
    fallback = setInterval(() => {
      audits++;
      const changed = host.fingerprint() !== built;
      say('board-watch:check', 'fallback', { changed });
      if (changed) rebuild('fallback'); else host.quiet?.();
    }, timings.fallbackMs);
    fallback.unref?.();
  }

  function onEvent(dir: string, file?: string): void {
    if (closed || state !== 'watching') return;
    if (file && host.ignore?.(dir, file)) return;
    armSilence();
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      if (closed || state !== 'watching') return;
      rebuild('watch');
      // A new run or a removed one changes which folders matter.
      if ((reattach || [...new Set(host.folders())].sort().join('\n') !== watched) && !attach()) fail('attach');
    }, timings.debounceMs);
    debounce.unref?.();
  }

  function onError(): void {
    if (closed || state !== 'watching') return;
    // The watcher may have been deaf for a while: show whatever it did not report, then count the failure.
    if (host.fingerprint() !== built) rebuild('error');
    fail('error');
  }

  function audit(): void {
    silence = null;
    if (closed || state !== 'watching') return;
    audits++;
    const missed = host.fingerprint() !== built;
    say('board-watch:audit', missed ? 'missed' : 'clean', { changed: missed });
    if (missed) { rebuild('audit'); return fail('missed'); }
    failures = 0;
    armSilence();
    host.quiet?.();
  }

  built = host.fingerprint();
  if (attach()) { say('board-watch:watching', 'start'); armSilence(); } else fail('attach');

  return {
    state: () => state,
    stats: () => ({ audits, failures, attached: handles.length, attaches }),
    baseline: () => { built = host.fingerprint(); },
    close: () => {
      closed = true;
      detach();
      for (const t of [debounce, silence]) if (t) clearTimeout(t);
      if (fallback) clearInterval(fallback);
    },
  };
}
