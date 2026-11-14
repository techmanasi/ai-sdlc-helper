// How the Completed page loads its list: the rows first (what git and the cache know, at once), then, only when some
// row's pull request is still being asked for, the settled list (what the page shows once GitHub has answered).
// At most two requests per load. Kept free of Preact and of the API module so it can be tested on its own.

/** What the load needs of a row (the page's CompletedTask) and of a failed check (its PrCheckErrors item). */
export interface LoadRow { slug: string; prPending?: true }
export interface CompletedAnswer<T extends LoadRow = LoadRow, E = unknown> { completed: T[]; prErrors?: E[] }

export interface CompletedSource<T extends LoadRow = LoadRow, E = unknown> {
  /** The rows at once; a row whose PR is not known yet has prPending. */
  rows(project: string): Promise<CompletedAnswer<T, E>>;
  /** The settled list: every PR asked for, rows whose PR is not merged left out. */
  settled(project: string): Promise<CompletedAnswer<T, E>>;
}

export interface CompletedLoadEvents<T extends LoadRow = LoadRow, E = unknown> {
  rows(tasks: T[], prErrors: E[]): void;
  /** <removed>: the rows shown first that the settled list left out (their PR is not merged). */
  settled(tasks: T[], prErrors: E[], removed: string[]): void;
  /** A request that failed: 'rows' (nothing shown) or 'settle' (the rows stay, their state unknown). */
  error(message: string, phase: 'rows' | 'settle'): void;
}

/** Loads <project>'s list; <isCurrent> false (another load or project since) drops what comes back. */
export async function loadCompleted<T extends LoadRow, E>(source: CompletedSource<T, E>, project: string, on: CompletedLoadEvents<T, E>, isCurrent: () => boolean = () => true): Promise<void> {
  let first: CompletedAnswer<T, E>;
  try { first = await source.rows(project); } catch (e) { if (isCurrent()) on.error((e as Error).message, 'rows'); return; }
  if (!isCurrent()) return;
  on.rows(first.completed, first.prErrors || []);
  if (!first.completed.some(t => t.prPending)) { on.settled(first.completed, first.prErrors || [], []); return; }
  let second: CompletedAnswer<T, E>;
  try { second = await source.settled(project); } catch (e) { if (isCurrent()) on.error((e as Error).message, 'settle'); return; }
  if (!isCurrent()) return;
  const kept = new Set(second.completed.map(t => t.slug));
  on.settled(second.completed, second.prErrors || [], first.completed.filter(t => !kept.has(t.slug)).map(t => t.slug));
}
