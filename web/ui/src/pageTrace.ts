// The page's own trace of repeating actions (docs/plans/run-view-performance.md, section 4a): kept in memory, never sent to
// the server. Open the app with ?trace=1 and run `sdlcTrace.report()` in the console for the same table as
// scripts/trace-report.mjs prints for the server.
export interface PageEvent { t: number; side: 'client'; action: string; why?: string; ms?: number; changed?: boolean; code?: number }

const MAX = 5000;
const events: PageEvent[] = [];
const micros = (): number => Math.round((performance.timeOrigin + performance.now()) * 1000);

/** Adds one event (the oldest go when the page has kept 5000). */
export function pageTrace(action: string, rest: { why?: string; ms?: number; changed?: boolean; code?: number } = {}): void {
  events.push({ t: micros(), side: 'client', action, ...rest });
  if (events.length > MAX) events.splice(0, events.length - MAX);
}

export interface Row { action: string; count: number; perMin: number; unchangedPct: number | null; totalMsPerMin: number }

/** One row per action + why: events a minute, the share that changed nothing, total ms a minute; sorted by total time. */
export function summarise(list: readonly PageEvent[]): Row[] {
  if (!list.length) return [];
  const minutes = Math.max((list[list.length - 1].t - list[0].t) / 60e6, 1 / 60);
  const groups = new Map<string, { n: number; known: number; same: number; ms: number }>();
  for (const e of list) {
    const key = e.why ? `${e.action} ${e.why}` : e.action;
    const g = groups.get(key) || { n: 0, known: 0, same: 0, ms: 0 };
    g.n++;
    if (typeof e.changed === 'boolean') { g.known++; if (!e.changed) g.same++; }
    g.ms += e.ms || 0;
    groups.set(key, g);
  }
  return [...groups].map(([action, g]) => ({
    action, count: g.n, perMin: +(g.n / minutes).toFixed(2),
    unchangedPct: g.known ? Math.round((100 * g.same) / g.known) : null,
    totalMsPerMin: +(g.ms / minutes).toFixed(2),
  })).sort((a, b) => b.totalMsPerMin - a.totalMsPerMin || b.perMin - a.perMin || a.action.localeCompare(b.action));
}

/** Makes `sdlcTrace` available in the console when the page was opened with ?trace=1. */
export function exposeTrace(search: string = (globalThis as { location?: { search: string } }).location?.search ?? ''): void {
  if (!new URLSearchParams(search).has('trace')) return;
  (globalThis as unknown as { sdlcTrace: unknown }).sdlcTrace = {
    events: () => events.slice(),
    rows: () => summarise(events),
    report: () => { console.table(summarise(events)); },
  };
}
