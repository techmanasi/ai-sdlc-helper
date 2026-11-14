import path from 'node:path';

/** One line the server has for the person looking at a project's board or Completed page (what a cleanup did or could not do). */
export interface Notice {
  /** Stable for this server run: a dismissed notice is told apart by it. */
  id: string;
  /** ISO time. */
  at: string;
  slug: string;
  text: string;
  level: 'info' | 'warning';
}

const MAX_NOTICES = 20;
const byProject = new Map<string, Notice[]>();
let seq = 0;

/** Remembers <text> for the project at <root> (the last few only). A line that starts with WARNING is a warning. */
export function addNotice(root: string, slug: string, text: string, level?: Notice['level']): void {
  const key = path.resolve(root);
  const list = byProject.get(key) || [];
  const now = new Date();
  list.push({ id: `${now.getTime().toString(36)}-${++seq}`, at: now.toISOString(), slug, text, level: level ?? (/^WARNING\b/.test(text) ? 'warning' : 'info') });
  while (list.length > MAX_NOTICES) list.shift();
  byProject.set(key, list);
}

/** The notices kept for the project at <root>, oldest first. */
export function recentNotices(root: string): Notice[] {
  return [...(byProject.get(path.resolve(root)) || [])];
}

/** Forgets every notice (tests). */
export function clearNotices(): void { byProject.clear(); }
