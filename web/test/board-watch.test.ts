import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eventually } from '../../test/wait.js';
import { BOARD_WATCH_TIMINGS, createBoardWatch, type BoardWatch, type WatchFn } from '../server/board-watch.js';

const T = BOARD_WATCH_TIMINGS;

/** A board whose files are a number, and a watcher the test fires, breaks or silences by hand. */
function rig(opts: { deaf?: boolean; refuse?: () => boolean } = {}) {
  let version = 1;
  let folders = ['/reg', '/logs'];
  const rebuilds: string[] = [];
  const trace: string[] = [];
  let quiets = 0;
  let fingerprints = 0;
  let building: (() => void) | null = null;
  const live: { dir: string; onEvent: (file?: string) => void; onError: () => void }[] = [];
  const watch: WatchFn = (dir, onEvent, onError) => {
    if (opts.refuse?.()) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    const h = { dir, onEvent, onError };
    live.push(h);
    return { close: () => { const i = live.indexOf(h); if (i >= 0) live.splice(i, 1); } };
  };
  const w: BoardWatch = createBoardWatch({
    folders: () => folders,
    fingerprint: () => { fingerprints++; return String(version); },
    ignore: (_dir, file) => file === 'run.out',
    rebuild: why => { rebuilds.push(why); const f = building; building = null; f?.(); },
    quiet: () => { quiets++; },
    trace: e => { trace.push(`${e.action}${e.why ? `:${e.why}` : ''}`); },
    watch,
  });
  return {
    w, rebuilds, trace, live,
    fingerprints: () => fingerprints,
    quiets: () => quiets,
    /** A file changes; the watcher reports it unless it is deaf. */
    change: (file = 'status.json') => { version++; if (!opts.deaf) live[0]?.onEvent(file); },
    /** A file changes and the watcher says nothing. */
    missed: () => { version++; },
    event: (file?: string) => live[0]?.onEvent(file),
    error: () => live[0]?.onError(),
    setFolders: (f: string[]) => { folders = f; },
    /** Something that happens while the board is next built. */
    duringBuild: (f: (() => void) | null) => { building = f; },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('the board watcher, while the watcher works', () => {
  test('starts watching every folder, and a change rebuilds the board once after the debounce', () => {
    const r = rig();
    expect(r.w.state()).toBe('watching');
    expect(r.live.map(h => h.dir)).toEqual(['/logs', '/reg']);
    r.change();
    r.change();
    r.change();
    vi.advanceTimersByTime(T.debounceMs - 1);
    expect(r.rebuilds).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.rebuilds).toEqual(['watch']);
  });

  test('compares no fingerprint while events keep coming: none is an audit', () => {
    const r = rig();
    for (let i = 0; i < 20; i++) { r.change(); vi.advanceTimersByTime(T.silenceMs - 1000); }
    expect(r.w.stats().audits).toBe(0);
    expect(r.rebuilds.every(why => why === 'watch')).toBe(true);
    expect(r.trace.filter(l => l.startsWith('board-watch:audit'))).toEqual([]);
  });

  test('a change to a file the board does not read rebuilds nothing and does not put off the audit', () => {
    const r = rig();
    vi.advanceTimersByTime(T.silenceMs - 10);
    r.event('run.out');
    vi.advanceTimersByTime(T.debounceMs);
    expect(r.rebuilds).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(r.w.stats().audits).toBe(1);
  });

  test('after the silence it audits exactly once, finds nothing, and waits a full silence again', () => {
    const r = rig();
    vi.advanceTimersByTime(T.silenceMs - 1);
    expect(r.w.stats().audits).toBe(0);
    vi.advanceTimersByTime(1);
    expect(r.w.stats()).toMatchObject({ audits: 1, failures: 0, attaches: 1 });
    expect(r.rebuilds).toEqual([]);
    expect(r.trace).toContain('board-watch:audit:clean');
    vi.advanceTimersByTime(T.silenceMs);
    expect(r.w.stats().audits).toBe(2);
  });

  test('the host is told when all is quiet, once per clean audit and never between: that is when it looks for a run that died silently', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) { r.change(); vi.advanceTimersByTime(T.silenceMs - 1000); }
    expect(r.quiets()).toBe(0);
    vi.advanceTimersByTime(T.silenceMs);
    expect(r.quiets()).toBe(1);
    vi.advanceTimersByTime(T.silenceMs * 2);
    expect(r.quiets()).toBe(3);
    // An audit that finds a missed change rebuilds the board anyway: no second look.
    r.missed();
    vi.advanceTimersByTime(T.silenceMs);
    expect(r.quiets()).toBe(3);
    expect(r.rebuilds.at(-1)).toBe('audit');
  });

  test('a new run adds a folder: the watchers are attached again after the rebuild, and that is not a failure', () => {
    const r = rig();
    r.setFolders(['/reg', '/logs', '/new-run/logs']);
    r.change();
    vi.advanceTimersByTime(T.debounceMs);
    expect(r.live.map(h => h.dir)).toEqual(['/logs', '/new-run/logs', '/reg']);
    expect(r.w.stats()).toMatchObject({ failures: 0, attaches: 2 });
  });
});

describe('the board watcher, when the watcher fails', () => {
  test('a change the watcher did not report is found at the audit: the board is rebuilt, a failure is counted, the watchers are attached again', () => {
    const r = rig();
    r.missed();
    vi.advanceTimersByTime(T.silenceMs - 1);
    expect(r.rebuilds).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.rebuilds).toEqual(['audit']);
    expect(r.w.stats()).toMatchObject({ audits: 1, failures: 1, attaches: 2, attached: 2 });
    expect(r.w.state()).toBe('watching');
    expect(r.trace).toContain('board-watch:failure:missed');
  });

  test('a watcher error is a failure at once: what it hid is shown and the watchers are attached again', () => {
    const r = rig();
    r.missed();
    r.error();
    expect(r.rebuilds).toEqual(['error']);
    expect(r.w.stats()).toMatchObject({ failures: 1, attaches: 2, attached: 2 });
    expect(r.trace).toContain('board-watch:failure:error');
  });

  test('a clean audit between failures starts the count again', () => {
    const r = rig();
    for (let i = 0; i < 4; i++) { r.missed(); vi.advanceTimersByTime(T.silenceMs); }
    expect(r.w.stats().failures).toBe(4);
    vi.advanceTimersByTime(T.silenceMs);
    expect(r.w.stats().failures).toBe(0);
    for (let i = 0; i < T.failureLimit - 1; i++) { r.missed(); vi.advanceTimersByTime(T.silenceMs); }
    expect(r.w.state()).toBe('watching');
  });

  test('the tenth failure in a row ends the watching: no watcher is left, and the fingerprint is compared every 5 seconds', () => {
    const r = rig({ deaf: true });
    expect(T.failureLimit).toBe(10);
    expect(T.fallbackMs).toBe(5000);
    for (let i = 0; i < T.failureLimit - 1; i++) { r.change(); vi.advanceTimersByTime(T.silenceMs); }
    expect(r.w.state()).toBe('watching');
    expect(r.w.stats().failures).toBe(9);
    r.change();
    vi.advanceTimersByTime(T.silenceMs);
    expect(r.w.state()).toBe('fallback');
    expect(r.w.stats().attached).toBe(0);
    expect(r.live).toEqual([]);
    expect(r.trace.filter(l => l.startsWith('board-watch:fallback'))).toHaveLength(1);

    const before = r.fingerprints();
    const rebuilds = r.rebuilds.length;
    const quietBefore = r.quiets();
    vi.advanceTimersByTime(T.fallbackMs * 3);
    expect(r.fingerprints() - before).toBe(3);
    expect(r.quiets() - quietBefore).toBe(3);
    expect(r.rebuilds).toHaveLength(rebuilds);
    r.change();
    vi.advanceTimersByTime(T.fallbackMs - 1);
    expect(r.rebuilds).toHaveLength(rebuilds);
    vi.advanceTimersByTime(1);
    expect(r.rebuilds.slice(rebuilds)).toEqual(['fallback']);
    // It stays there: no watcher is tried again in this process.
    vi.advanceTimersByTime(T.silenceMs * 5);
    expect(r.live).toEqual([]);
    expect(r.w.state()).toBe('fallback');
  });

  test('a watcher that cannot be attached counts as failures, down to the fallback', () => {
    const r = rig({ refuse: () => true });
    // Not all at once: one try now, then one every fallbackMs, so a fault that lasts a moment does not end the watching.
    expect(r.w.state()).toBe('watching');
    expect(r.w.stats()).toMatchObject({ failures: 1, attached: 0 });
    // Meanwhile a change is not hidden: each try compares the fingerprint first.
    r.missed();
    vi.advanceTimersByTime(T.fallbackMs);
    expect(r.rebuilds).toEqual(['retry']);
    expect(r.w.stats().failures).toBe(2);
    vi.advanceTimersByTime(T.fallbackMs * (T.failureLimit - 3));
    expect(r.w.state()).toBe('watching');
    vi.advanceTimersByTime(T.fallbackMs);
    expect(r.w.state()).toBe('fallback');
    r.missed();
    vi.advanceTimersByTime(T.fallbackMs);
    expect(r.rebuilds).toEqual(['retry', 'fallback']);
  });

  test('a watcher that cannot be attached for a moment is attached at the next try, and watching goes on', () => {
    let broken = true;
    const r = rig({ refuse: () => broken });
    expect(r.w.stats().attached).toBe(0);
    broken = false;
    vi.advanceTimersByTime(T.fallbackMs);
    expect(r.w.state()).toBe('watching');
    expect(r.w.stats().attached).toBe(2);
    r.change();
    vi.advanceTimersByTime(T.debounceMs);
    expect(r.rebuilds).toEqual(['watch']);
    vi.advanceTimersByTime(T.silenceMs);
    expect(r.w.stats().failures).toBe(0);
  });

  test('a change made while the board is being built is not lost: the fingerprint is the one from before the build', () => {
    const r = rig();
    r.duringBuild(() => r.missed());
    r.change();
    vi.advanceTimersByTime(T.debounceMs);
    expect(r.rebuilds).toEqual(['watch']);
    vi.advanceTimersByTime(T.silenceMs);
    expect(r.rebuilds).toEqual(['watch', 'audit']);
  });

  test('a board built for another reason is the new baseline: the next audit finds nothing', () => {
    const r = rig();
    r.missed();
    r.w.baseline();
    vi.advanceTimersByTime(T.silenceMs);
    expect(r.rebuilds).toEqual([]);
    expect(r.w.stats()).toMatchObject({ audits: 1, failures: 0 });
  });

  test('a host that throws does not end the process or the watching: the next audit still comes', () => {
    const r = rig();
    r.duringBuild(() => { throw new Error('settings unreadable'); });
    r.change();
    expect(() => vi.advanceTimersByTime(T.debounceMs)).not.toThrow();
    expect(r.trace).toContain('board-watch:error:settings unreadable');
    r.duringBuild(null);
    vi.advanceTimersByTime(T.silenceMs);
    expect(r.w.stats().audits).toBe(1);
    expect(r.w.state()).toBe('watching');
  });

  test('every start begins with the watcher, whatever the last one ended in', () => {
    const first = rig({ deaf: true });
    for (let i = 0; i < T.failureLimit; i++) { first.change(); vi.advanceTimersByTime(T.silenceMs); }
    expect(first.w.state()).toBe('fallback');
    first.w.close();
    const second = rig();
    expect(second.w.state()).toBe('watching');
    expect(second.w.stats()).toMatchObject({ failures: 0, attached: 2 });
  });

  test('closing stops everything: no audit, no check, no rebuild afterwards', () => {
    const r = rig();
    r.change();
    r.w.close();
    vi.advanceTimersByTime(T.silenceMs * 3);
    expect(r.rebuilds).toEqual([]);
    expect(r.w.stats().audits).toBe(0);
    expect(r.live).toEqual([]);
  });
});

describe('the board watcher on real folders', () => {
  const quick = { debounceMs: 20, silenceMs: 150, failureLimit: 10, fallbackMs: 100 };
  let dir: string;
  let w: BoardWatch | null = null;
  beforeEach(() => { vi.useRealTimers(); dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-watch-'))); });
  afterEach(() => { w?.close(); w = null; });

  const stamp = (files: string[]) => files.map(f => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } }).join('|');

  test('a record replaced by a rename is seen', async () => {
    const reg = path.join(dir, 'reg');
    fs.mkdirSync(reg);
    const file = path.join(reg, 'tok.json');
    fs.writeFileSync(file, '{"state":"running"}\n');
    const rebuilds: string[] = [];
    // A silence too long to help: only the watcher can report it in time.
    w = createBoardWatch({ folders: () => [reg], fingerprint: () => stamp([file]), rebuild: why => { rebuilds.push(why); } }, { ...quick, silenceMs: 60_000 });
    fs.writeFileSync(`${file}.1.tmp`, '{"state":"exited","exit_code":"0"}\n');
    fs.renameSync(`${file}.1.tmp`, file);
    await eventually(() => rebuilds.length >= 1);
    expect(rebuilds[0]).toBe('watch');
  });

  test('a watched folder that is removed and made again: a later write is still seen', async () => {
    const logs = path.join(dir, 'logs');
    fs.mkdirSync(logs);
    const file = path.join(logs, 'status.json');
    fs.writeFileSync(file, '{"stage":"Spec"}\n');
    const rebuilds: string[] = [];
    w = createBoardWatch({ folders: () => (fs.existsSync(logs) ? [logs] : []), fingerprint: () => stamp([file]), rebuild: why => { rebuilds.push(why); } }, quick);
    fs.rmSync(logs, { recursive: true });
    await eventually(() => rebuilds.length >= 1);
    fs.mkdirSync(logs);
    // Seen by an event where the old watcher still works, by the audit where it died with the folder.
    const seen = rebuilds.length;
    fs.writeFileSync(file, '{"stage":"Plan","more":true}\n');
    await eventually(() => rebuilds.length > seen);
    expect(w.state()).toBe('watching');
  });

  test('a folder that does not exist yet is waited for: its first file is seen by the watcher, with no audit and no failure', async () => {
    // The register before a project's first run, two levels down from anything that exists.
    const reg = path.join(dir, 'git', 'sdlc-runs');
    const file = path.join(reg, 'tok.json');
    const rebuilds: string[] = [];
    // A silence too long to help: only an event can rebuild in time.
    w = createBoardWatch({ folders: () => [reg], fingerprint: () => stamp([reg, file]), rebuild: why => { rebuilds.push(why); } }, { ...quick, silenceMs: 60_000 });
    fs.mkdirSync(reg, { recursive: true });
    await eventually(() => rebuilds.length >= 1);
    const seen = rebuilds.length;
    await eventually(() => w!.stats().attaches >= 2);
    await new Promise(r => setTimeout(r, quick.debounceMs * 3));
    fs.writeFileSync(file, '{"state":"running"}\n');
    await eventually(() => rebuilds.length > seen);
    expect(rebuilds.every(why => why === 'watch')).toBe(true);
    expect(w.stats()).toMatchObject({ audits: 0, failures: 0 });
  });

  test('a folder above a waited-for one is not listened to for anything else', async () => {
    const reg = path.join(dir, 'sdlc-runs');
    const rebuilds: string[] = [];
    w = createBoardWatch({ folders: () => [reg], fingerprint: () => '', rebuild: why => { rebuilds.push(why); } }, { ...quick, silenceMs: 60_000 });
    fs.writeFileSync(path.join(dir, 'index.lock'), 'x');
    fs.mkdirSync(path.join(dir, 'objects'));
    await new Promise(r => setTimeout(r, quick.debounceMs * 6));
    expect(rebuilds).toEqual([]);
  });
});
