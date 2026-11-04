// The connection logic of a live stream, with no Preact or browser imports so tests can drive it with a fake clock
// (docs/plans/run-view-performance.md, Step 5 and section 4). The page feeds it what happens (an event, an error, the tab
// showing); it calls the host to reconnect, to poll as a backup and to show the "connection lost" banner.

export interface StreamHost {
  now(): number;
  after(ms: number, fn: () => void): unknown;
  cancel(handle: unknown): void;
  /** Closes the old connection (if any) and opens a new one. */
  connect(): void;
  disconnect(): void;
  /** One backup GET. */
  poll(): void;
  banner(on: boolean): void;
  visible(): boolean;
}

export interface StreamRules {
  /** No event for this long means the connection is dead. */
  silenceMs: number;
  /** After a reconnect or an error, this long without an event starts the backup polling. */
  reopenWaitMs: number;
  pollFirstMs: number;
  pollMaxMs: number;
  /** Consecutive failures before the banner shows. */
  bannerAfter: number;
}
export const STREAM_RULES: StreamRules = { silenceMs: 60_000, reopenWaitMs: 10_000, pollFirstMs: 10_000, pollMaxMs: 30_000, bannerAfter: 2 };

export interface StreamMachine {
  start(): void;
  stop(): void;
  /** Any event arrived, a change or a ping. */
  event(): void;
  /** The browser reported an error (it reconnects on its own). */
  error(): void;
  /** The tab became visible or hidden. */
  visibility(): void;
  state(): { polling: boolean; banner: boolean; failures: number };
}

export function createStreamMachine(host: StreamHost, rules: Partial<StreamRules> = {}): StreamMachine {
  const r = { ...STREAM_RULES, ...rules };
  let running = false;
  let lastEvent = 0;
  let failures = 0;
  let polling = false;
  let bannerOn = false;
  let pollDelay = r.pollFirstMs;
  let watchdog: unknown = null;
  let reopenWait: unknown = null;
  let pollTimer: unknown = null;

  const clear = (h: unknown) => { if (h !== null) host.cancel(h); };
  const setBanner = (on: boolean) => { if (on !== bannerOn) { bannerOn = on; host.banner(on); } };

  const arm = (wait = Math.max(1, r.silenceMs - (host.now() - lastEvent))) => {
    clear(watchdog);
    watchdog = host.after(wait, onWatchdog);
  };
  const onWatchdog = () => {
    watchdog = null;
    if (!running) return;
    // A hidden tab's timers run late and wrongly; it checks again when it is shown (visibility()).
    if (!host.visible()) { arm(r.silenceMs); return; }
    if (host.now() - lastEvent >= r.silenceMs) lost(); else arm();
  };
  const startPolling = () => {
    reopenWait = null;
    if (!running || polling) return;
    polling = true;
    pollDelay = r.pollFirstMs;
    pollOnce();
  };
  const pollOnce = () => {
    if (!running || !polling) return;
    if (host.visible()) host.poll(); // a hidden tab needs no polling; it polls when shown
    pollTimer = host.after(pollDelay, pollOnce);
    pollDelay = Math.min(pollDelay * 2, r.pollMaxMs);
  };
  const stopPolling = () => { polling = false; clear(pollTimer); pollTimer = null; };
  /** The connection is dead: count it, show the banner after a couple, open a new one, and poll if that stays silent too. */
  const lost = () => {
    failures++;
    if (failures >= r.bannerAfter) setBanner(true);
    lastEvent = host.now();
    host.connect();
    waitForReopen();
    arm();
  };
  const waitForReopen = () => {
    if (reopenWait !== null || polling) return;
    reopenWait = host.after(r.reopenWaitMs, startPolling);
  };

  return {
    start() {
      running = true; failures = 0; polling = false; bannerOn = false;
      lastEvent = host.now();
      host.connect();
      arm();
    },
    stop() {
      running = false;
      clear(watchdog); clear(reopenWait); clear(pollTimer);
      watchdog = reopenWait = pollTimer = null;
      polling = false;
      host.disconnect();
      setBanner(false);
    },
    event() {
      if (!running) return;
      lastEvent = host.now();
      failures = 0;
      clear(reopenWait); reopenWait = null;
      stopPolling();
      setBanner(false);
      arm();
    },
    error() {
      if (!running) return;
      failures++;
      if (failures >= r.bannerAfter) setBanner(true);
      waitForReopen();
    },
    visibility() {
      if (!running || !host.visible()) return;
      if (host.now() - lastEvent >= r.silenceMs) lost();
      // Polling paused while the tab was hidden: look now, then go on at the first delay.
      if (polling) { clear(pollTimer); pollDelay = r.pollFirstMs; pollOnce(); }
    },
    state: () => ({ polling, banner: bannerOn, failures }),
  };
}

/** The page's run after a stream event: a snapshot replaces it, a run event replaces everything but the tail, a tail event only the tail. */
export function applyRunEvent<T extends { tail: string[] }>(prev: T | null, event: string, data: unknown): T | null {
  if (event === 'snapshot') return data as T;
  if (!prev) return prev;
  if (event === 'run') return { ...prev, ...(data as T), tail: prev.tail };
  if (event === 'tail') return { ...prev, tail: (data as { tail: string[] }).tail };
  return prev;
}
