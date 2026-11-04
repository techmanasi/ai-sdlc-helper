// The per-run stream (docs/plans/run-view-performance.md, Step 4): one watcher per run, shared by every page that has it
// open. A change in a file the pipeline writes rebuilds the run's live part and pushes it; output growth is pushed as a
// tail, at most once a second; a ping goes out every 15 s; a 30 s tick re-reads everything and pushes what a dropped
// watch event would have missed. The last page to leave stops the watcher and the timers.
import fs from 'node:fs';
import path from 'node:path';
import { trace } from 'ai-sdlc-helper';

export interface StreamClient { send(event: string, data: unknown): void }

/** What the stream needs to know about one run. */
export interface RunSource {
  /** Called at each tick before anything is read, to pick up new settings. */
  refresh?(): void;
  /** The live and git parts (git facts from the cache), without the tail. */
  live(): Record<string, unknown>;
  /** The end of run.out. */
  tail(): string[];
  /** The folders to watch now (the list can grow: a worktree appears when a run starts). */
  dirs(): string[];
  /** The run.out file, null when the run has no folder. */
  outFile(): string | null;
}

export interface StreamTimings { debounceMs: number; tickMs: number; pingMs: number; tailMs: number }
export const STREAM_TIMINGS: StreamTimings = { debounceMs: 150, tickMs: 30_000, pingMs: 15_000, tailMs: 1000 };

/** File names the pipeline writes; any other name is traced as 'other' (a name can be a document title). */
const KNOWN = new Set(['status.json', 'permissions.json', 'stage-files.json', 'tests.json', 'finalise-options.json', 'run.out', 'questions.md', 'brief.md', 'test-issues.md', 'index.md']);
const label = (name: string): string => (KNOWN.has(name) ? name : name.endsWith('.json') && !name.includes('/') && name.length < 40 ? 'record.json' : 'other');

const withoutAge = (v: Record<string, unknown>): string => JSON.stringify({ ...v, gitAgeMs: null });

class RunStream {
  private clients = new Set<StreamClient>();
  private watchers = new Map<string, fs.FSWatcher>();
  private lastLive = '';
  private lastTail = '';
  private lastSize = -1;
  private lastTailAt = 0;
  private debounce: NodeJS.Timeout | null = null;
  private tailTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout;
  private pingTimer: NodeJS.Timeout;
  private pings = 0;
  private ticks = 0;
  private closed = false;

  constructor(private name: string, private src: RunSource, private t: StreamTimings, private onEmpty: () => void) {
    this.attach();
    this.tickTimer = setInterval(() => this.tick(), t.tickMs);
    this.pingTimer = setInterval(() => this.ping(), t.pingMs);
    this.tickTimer.unref();
    this.pingTimer.unref();
  }

  get size(): number { return this.clients.size; }
  get watched(): string[] { return [...this.watchers.keys()]; }

  join(c: StreamClient): () => void {
    this.clients.add(c);
    // A page that connects gets the whole picture at once; later events are changes against it.
    try {
      const live = this.src.live();
      const tail = this.src.tail();
      this.lastLive = withoutAge(live);
      this.lastTail = JSON.stringify(tail);
      c.send('snapshot', { ...live, tail });
      trace({ action: 'sse:snapshot', run: this.name, changed: true });
    } catch (e) { c.send('problem', { message: (e as Error).message }); trace({ action: 'sse:problem', run: this.name }); }
    return () => {
      this.clients.delete(c);
      if (!this.clients.size) this.close();
    };
  }

  private broadcast(event: string, data: unknown): void {
    for (const c of this.clients) { try { c.send(event, data); } catch { /* a closed socket leaves on its own */ } }
  }

  /** Watches every folder of the run that exists and is not watched yet; drops the ones that went away. */
  private attach(): void {
    const dirs = new Set(this.src.dirs());
    for (const [d, w] of this.watchers) if (!dirs.has(d)) { w.close(); this.watchers.delete(d); }
    for (const d of dirs) {
      if (this.watchers.has(d)) continue;
      try {
        const w = fs.watch(d, (_ev, file) => this.onFile(file ? path.basename(String(file)) : ''));
        w.on('error', () => { w.close(); this.watchers.delete(d); });
        this.watchers.set(d, w);
      } catch { /* the folder vanished; the next tick tries again */ }
    }
  }

  private onFile(name: string): void {
    if (this.closed) return;
    // The supervisor's heartbeat file only says the process is alive; it never rebuilds the view.
    if (name.endsWith('.live.json')) { trace({ action: 'watch:event', why: 'live.json', run: this.name, changed: false }); return; }
    trace({ action: 'watch:event', why: label(name), run: this.name });
    if (name === 'run.out') this.scheduleTail(); else this.scheduleLive();
  }

  private scheduleLive(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => { this.debounce = null; this.rebuild('watch'); }, this.t.debounceMs);
  }

  private rebuild(why: string): void {
    if (this.closed || !this.clients.size) return;
    const t0 = performance.now();
    try {
      const live = this.src.live();
      const key = withoutAge(live);
      const changed = key !== this.lastLive;
      trace({ action: 'rebuild:run', why, run: this.name, ms: Math.round((performance.now() - t0) * 1000) / 1000, changed, n: ++this.ticks });
      if (changed) { this.lastLive = key; this.broadcast('run', live); trace({ action: 'sse:run', run: this.name, changed: true }); }
    } catch (e) {
      this.broadcast('problem', { message: (e as Error).message });
      trace({ action: 'sse:problem', run: this.name });
    }
  }

  private scheduleTail(): void {
    if (this.tailTimer) return;
    const wait = Math.max(0, this.lastTailAt + this.t.tailMs - Date.now());
    this.tailTimer = setTimeout(() => { this.tailTimer = null; this.pushTail('watch'); }, wait);
  }

  /** Sends the tail when run.out grew (or shrank) since the last look and the text differs. */
  private pushTail(why: string): void {
    if (this.closed || !this.clients.size) return;
    this.lastTailAt = Date.now();
    const file = this.src.outFile();
    let size = -1;
    try { if (file) size = fs.statSync(file).size; } catch { /* no file yet */ }
    if (size === this.lastSize) { trace({ action: 'tail:check', why, run: this.name, changed: false }); return; }
    this.lastSize = size;
    const tail = this.src.tail();
    const text = JSON.stringify(tail);
    const changed = text !== this.lastTail;
    trace({ action: 'tail:check', why, run: this.name, changed });
    if (changed) { this.lastTail = text; this.broadcast('tail', { tail }); trace({ action: 'sse:tail', run: this.name, changed: true }); }
  }

  /** The safety net: re-attach the watchers, rebuild the live part and look at the tail, pushing only what differs. */
  private tick(): void {
    if (this.closed) return;
    try { this.src.refresh?.(); } catch { /* the next tick tries again */ }
    this.attach();
    this.rebuild('tick');
    this.pushTail('tick');
  }

  private ping(): void {
    if (this.closed || !this.clients.size) return;
    this.broadcast('ping', { n: ++this.pings });
    trace({ action: 'sse:ping', run: this.name, n: this.pings });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.tickTimer);
    clearInterval(this.pingTimer);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.tailTimer) clearTimeout(this.tailTimer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    this.clients.clear();
    this.onEmpty();
  }
}

/** The streams of a server, one per run, created by the first page and closed by the last. */
export function createRunStreams(timings: Partial<StreamTimings> = {}) {
  const t = { ...STREAM_TIMINGS, ...timings };
  const streams = new Map<string, RunStream>();
  return {
    /** Adds a page to the stream of <key>; returns the function that removes it. */
    join(key: string, source: () => RunSource, client: StreamClient): () => void {
      let s = streams.get(key);
      if (!s) { s = new RunStream(key, source(), t, () => { streams.delete(key); }); streams.set(key, s); }
      return s.join(client);
    },
    /** For tests and the trace: how many streams, and how many pages and watched folders each has. */
    stats(): Record<string, { clients: number; watched: number }> {
      return Object.fromEntries([...streams].map(([k, s]) => [k, { clients: s.size, watched: s.watched.length }]));
    },
    closeAll(): void { for (const s of [...streams.values()]) s.close(); },
  };
}
