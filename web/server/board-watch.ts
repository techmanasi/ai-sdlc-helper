// How the board learns that something it shows has changed.
//
// Words used here. The BOARD is the page listing a project's backlog and runs. The HOST is the code that owns this
// watcher (the board feed in web/server/index.ts): it says which folders and files the board is made from, and
// rebuilds the board when told to. A RUN is one pipeline run; its record says whether its process is running.
//
// Two tools. A WATCHER (fs.watch on the folders the board reads) says "something changed here" within milliseconds
// and costs nothing while nothing happens. A FINGERPRINT (the modification time and size of every file the board
// reads, as one text) says whether anything changed since it was last taken; taking one costs a file stat per file.
// The watcher is used first and alone. The fingerprint is only its auditor, and its stand-in when it does not work.
//
// There are two states, `watching` and `fallback`. The other names below are steps taken while watching.
//
//   watching   Watchers attached. An event rebuilds the board (after `debounceMs`). No fingerprint is compared
//              while events keep coming. After `silenceMs` without an event, one AUDIT is made.
//     audit    The fingerprint is compared with the one taken at the last rebuild.
//                same      -> the watcher missed nothing: failures = 0. The host is told all is quiet (`quiet`),
//                             and uses that moment to check that a run recorded as running still has a process.
//                differs   -> the watcher MISSED a change: a failure.
//     waiting  A folder that does not exist yet (the folder of run records before a project's first run, a new
//              run's logs) cannot be watched. The nearest folder above it that exists is watched instead, for that
//              one name only; when the name appears, the watchers are attached again. Not a failure.
//     failure  Counted when an audit finds a missed change, when a watcher raises an error, or when a watcher
//              cannot be attached. The board is rebuilt and every watcher is closed and attached again. If they
//              cannot be attached, that is tried again after `fallbackMs` (with a fingerprint comparison, so that
//              nothing is hidden meanwhile), and each try that fails is one more failure. Silence alone is never a
//              failure: a quiet project is silent for hours.
//   fallback   Entered at `failureLimit` failures in a row. No watcher is attached. The fingerprint is compared
//              every `fallbackMs` and a difference rebuilds the board. It lasts until the process restarts;
//              every start begins in watching again.
//
// Longest time a change can go unseen: watching, the watcher works: `debounceMs`. Watching, the watcher is deaf:
// `silenceMs` after the last event. Fallback, or while the watchers cannot be attached: `fallbackMs`.
//
// Where the numbers come from.
//   Measured by `node scripts/watch-probe.mjs` (macOS, APFS; the internal disk and /private/tmp; 400 changes):
//   no event was missed; the first event came 12 ms after a change at the median, about 20 ms at worst.
//   Measured from the trace files of this repository's own runs (docs/plans/web-performance.md, section 13): runs go
//   2 to 33 minutes (90th percentile) without changing a file the board reads; one audit of its board (169 files,
//   29 folders) took 1.1 ms at the median, 2.1 ms at worst.
//   `debounceMs` 150: CHOSEN. Several times the worst event delay, so a burst of writes makes one rebuild, and
//   short enough to feel immediate.
//   `silenceMs` 30 s: CHOSEN, not measured. The measurements only say that silence cannot detect a broken watcher
//   (healthy runs are silent for minutes), so this is just the bound on how long a deaf watcher can hide a change,
//   and an audit is cheap enough (about 1 ms) for a short one. 30 s is what the run page already uses for the same
//   purpose (`tickMs` in web/server/watch.ts). It can be set with SDLC_BOARD_SILENCE_MS.
//   `failureLimit` 10 and `fallbackMs` 5 s: REQUIRED by the design this was built from.
import fs from 'node:fs';
import path from 'node:path';

export interface BoardWatchTimings {
  /** Wait this long after an event before rebuilding, so a burst of writes makes one rebuild (ms; chosen: see the file header). */
  debounceMs: number;
  /** After this long without an event, compare the fingerprint once (ms; chosen: see the file header). */
  silenceMs: number;
  /** This many failures in a row end the watching for this process (a count; required: 10). */
  failureLimit: number;
  /** In fallback, and while the watchers cannot be attached, compare the fingerprint this often (ms; required: 5 s). */
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
  /** Rebuild the board; <why> is 'watch', 'audit', 'error', 'retry' or 'fallback'. */
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
  let retry: NodeJS.Timeout | null = null;

  /**
   * Everything here runs from a timer or a watcher's callback, where an exception would end the process. What the
   * host does (reading settings, building the board) can throw, so each entry point is wrapped: the error is traced
   * and the next audit still comes.
   */
  const guarded = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => {
    try { fn(...a); } catch (e) {
      say('board-watch:error', e instanceof Error ? e.message : String(e));
      if (!closed && state === 'watching' && !silence && !retry) armSilence();
    }
  };

  const detach = (): void => { for (const h of handles) { try { h.close(); } catch { /* already closed */ } } handles = []; watched = ''; };
  const armSilence = (): void => {
    if (silence) clearTimeout(silence);
    silence = setTimeout(guarded(audit), timings.silenceMs);
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
          handles.push(watch(dir, guarded((file?: string) => {
            if (!file || made.awaited.has(file)) { reattach = true; return onEvent(dir, undefined); }
            if (made.all) onEvent(dir, file);
          }), guarded(onError)));
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
    if (attach()) { say('board-watch:attach', why); return armSilence(); }
    // Not at once: a fault that lasts a moment (too many open files) must not use up every try in one go.
    if (silence) { clearTimeout(silence); silence = null; }
    retry = setTimeout(guarded(() => {
      retry = null;
      if (closed || state !== 'watching') return;
      audits++;
      const changed = host.fingerprint() !== built;
      say('board-watch:check', 'retry', { changed });
      if (changed) rebuild('retry');
      fail('attach');
    }), timings.fallbackMs);
    retry.unref?.();
  }

  function enterFallback(): void {
    state = 'fallback';
    detach();
    if (debounce) { clearTimeout(debounce); debounce = null; }
    if (silence) { clearTimeout(silence); silence = null; }
    if (retry) { clearTimeout(retry); retry = null; }
    say('board-watch:fallback', `after ${failures} failures`, { n: failures });
    fallback = setInterval(guarded(() => {
      audits++;
      const changed = host.fingerprint() !== built;
      say('board-watch:check', 'fallback', { changed });
      if (changed) rebuild('fallback'); else host.quiet?.();
    }), timings.fallbackMs);
    fallback.unref?.();
  }

  function onEvent(dir: string, file?: string): void {
    if (closed || state !== 'watching') return;
    if (file && host.ignore?.(dir, file)) return;
    armSilence();
    if (debounce) return;
    debounce = setTimeout(guarded(() => {
      debounce = null;
      if (closed || state !== 'watching') return;
      // A new run or a removed one changes which folders matter. They are attached BEFORE the fingerprint is taken
      // and the board built: a write into a new folder during the build is then either in this build or reported.
      let attached = true;
      if (reattach || [...new Set(host.folders())].sort().join('\n') !== watched) {
        attached = attach();
        if (attached) say('board-watch:attach', 'folders');
      }
      rebuild('watch');
      if (!attached) fail('attach');
    }), timings.debounceMs);
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

  guarded(() => {
    built = host.fingerprint();
    if (attach()) { say('board-watch:watching', 'start'); armSilence(); } else fail('attach');
  })();

  return {
    state: () => state,
    stats: () => ({ audits, failures, attached: handles.length, attaches }),
    baseline: () => { built = host.fingerprint(); },
    close: () => {
      closed = true;
      detach();
      for (const t of [debounce, silence, retry]) if (t) clearTimeout(t);
      if (fallback) clearInterval(fallback);
    },
  };
}
