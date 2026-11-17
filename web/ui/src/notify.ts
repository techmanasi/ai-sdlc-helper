// Attention notifications: which run changes need the user, how to tell them (desktop notification, chime, tab title,
// favicon dot) and the saved preferences. Framework-free; the browser effects are safe where the API is missing.
export type NotifyMode = 'off' | 'browser' | 'sound' | 'both';
export interface NotifyPrefs { mode: NotifyMode; events: { paused: boolean; failed: boolean; done: boolean }; volume: number; onlyWhenHidden: boolean }
export const DEFAULT_PREFS: NotifyPrefs = { mode: 'off', events: { paused: true, failed: true, done: true }, volume: 0.5, onlyWhenHidden: true };

const KEY = 'sdlc-notify';
const MODES: NotifyMode[] = ['off', 'browser', 'sound', 'both'];

/** The saved preferences; anything missing or malformed falls back to the defaults. */
export function readPrefs(get: (key: string) => string | null): NotifyPrefs {
  let o: any;
  try { o = JSON.parse(get(KEY) || 'null'); } catch { o = null; }
  if (!o || typeof o !== 'object') return { ...DEFAULT_PREFS, events: { ...DEFAULT_PREFS.events } };
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const ev = o.events && typeof o.events === 'object' ? o.events : {};
  const vol = typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : DEFAULT_PREFS.volume;
  return {
    mode: MODES.includes(o.mode) ? o.mode : 'off',
    events: { paused: bool(ev.paused, true), failed: bool(ev.failed, true), done: bool(ev.done, true) },
    volume: vol,
    onlyWhenHidden: bool(o.onlyWhenHidden, true),
  };
}

export function writePrefs(set: (key: string, value: string) => void, p: NotifyPrefs): void {
  set(KEY, JSON.stringify(p));
}

export type AttentionKind = 'paused' | 'failed' | 'done';
export interface Attention { slug: string; kind: AttentionKind; title: string; body: string }

const FAILED = new Set(['failed', 'refused', 'interrupted', 'stopped']);
const stageName = (s?: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : 'the pipeline');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The runs whose state just changed into one that needs the user. A slug absent from `prev` is not a change. */
export function attentionFrom(prev: Record<string, string>,
  next: Array<{ slug: string; state: string; stage?: string; questions?: number; permissions?: number }>): Attention[] {
  const out: Attention[] = [];
  for (const r of next) {
    const was = prev[r.slug];
    if (was === undefined || was === r.state) continue;
    const at = stageName(r.stage);
    if (r.state === 'paused') {
      const q = r.questions || 0, p = r.permissions || 0;
      const what = [q ? plural(q, 'question') : '', p ? plural(p, 'permission request') : ''].filter(Boolean).join(' and ');
      out.push({ slug: r.slug, kind: 'paused', title: `${r.slug} needs ${q || p ? 'your answer' : 'you'}`,
        body: what ? `Paused at ${at}: ${what} to answer` : `Paused at ${at}` });
    } else if (FAILED.has(r.state)) {
      out.push({ slug: r.slug, kind: 'failed', title: `${r.slug} failed`, body: `${r.state === 'failed' ? 'Failed' : r.state.charAt(0).toUpperCase() + r.state.slice(1)} at ${at}` });
    } else if (r.state === 'done') {
      out.push({ slug: r.slug, kind: 'done', title: `${r.slug} is done`, body: `Finished at ${at}` });
    }
  }
  return out;
}

/** Which channels to use for one event. A visible tab gets no desktop notification when onlyWhenHidden; sound still plays. */
export function channelsFor(p: NotifyPrefs, a: Attention, hidden: boolean, permission: string): { desktop: boolean; sound: boolean } {
  if (p.mode === 'off' || !p.events[a.kind]) return { desktop: false, sound: false };
  return {
    desktop: (p.mode === 'browser' || p.mode === 'both') && permission === 'granted' && (hidden || !p.onlyWhenHidden),
    sound: (p.mode === 'sound' || p.mode === 'both') && p.volume > 0,
  };
}

export const titleFor = (waiting: number, base: string): string => (waiting > 0 ? `(${waiting}) ${base}` : base);
