// The server's notices (what a brief cleanup did or could not do) and which of them this browser has dismissed.
export interface NoticeItem { id: string; at: string; slug: string; text: string; level: 'info' | 'warning' }

const KEY = (project: string) => `sdlc:dismissed-notices:${project}`;
/** Only the newest ids are kept, so the stored list stays small. */
const KEEP = 100;

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
const defaultStore = (): Store | null => { try { return (globalThis as { localStorage?: Store }).localStorage ?? null; } catch { return null; } };

/** The ids dismissed for <project>; empty when storage is not there. */
export function loadDismissed(project: string, store: Store | null = defaultStore()): string[] {
  try {
    const v = JSON.parse(store?.getItem(KEY(project)) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/** Remembers <ids> as dismissed for <project> (and answers the whole list). */
export function saveDismissed(project: string, ids: string[], store: Store | null = defaultStore()): string[] {
  const all = [...new Set([...loadDismissed(project, store), ...ids])].slice(-KEEP);
  try { store?.setItem(KEY(project), JSON.stringify(all)); } catch { /* private window: dismissed for this page only */ }
  return all;
}

/** The notices not dismissed yet. */
export const visibleNotices = (notices: NoticeItem[] | undefined, dismissed: string[]): NoticeItem[] =>
  (notices || []).filter(n => !dismissed.includes(n.id));
