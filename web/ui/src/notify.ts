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

export function permissionState(): string {
  try { return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission; } catch { return 'unsupported'; }
}

export async function requestPermission(): Promise<string> {
  try {
    if (typeof Notification === 'undefined') return 'unsupported';
    return await Notification.requestPermission();
  } catch { return permissionState(); }
}

export function showDesktop(a: Attention, onClick: () => void): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const n = new Notification(a.title, { body: a.body, tag: `sdlc-${a.slug}` });
    n.onclick = () => { try { window.focus(); onClick(); } finally { n.close(); } };
  } catch { /* a blocked notification is not an error worth surfacing */ }
}

let ctx: AudioContext | null = null;
const NOTES: Record<AttentionKind, number[]> = { failed: [330, 247], done: [523, 784], paused: [587, 587] };

export function playChime(kind: AttentionKind, volume: number): void {
  try {
    const AC = typeof window === 'undefined' ? undefined : (window.AudioContext || (window as any).webkitAudioContext);
    if (!AC) return;
    ctx = ctx || new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    const c = ctx, v = Math.min(1, Math.max(0, volume)) * 0.3;
    NOTES[kind].forEach((hz, i) => {
      const t = c.currentTime + i * 0.16;
      const osc = c.createOscillator(), gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(Math.max(v, 0.0001), t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.connect(gain).connect(c.destination);
      osc.start(t);
      osc.stop(t + 0.15);
    });
  } catch { /* no audio is fine */ }
}

export const titleFor = (waiting: number, base: string): string => (waiting > 0 ? `(${waiting}) ${base}` : base);

/** The favicon with a dot: amber while runs wait, red when only failures, the plain /favicon.svg otherwise. */
export function setFaviconBadge(waiting: number, failed: number): void {
  try {
    if (typeof document === 'undefined') return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    const dot = waiting > 0 ? '#f5a623' : failed > 0 ? '#e5484d' : '';
    if (!dot) { link.type = 'image/svg+xml'; link.href = '/favicon.svg'; return; }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.fillStyle = '#56d4dd';
    g.beginPath();
    if (g.roundRect) g.roundRect(0, 0, 32, 32, 7); else g.rect(0, 0, 32, 32);
    g.fill();
    g.fillStyle = '#0b1a1c';
    g.beginPath(); g.moveTo(16, 6); g.lineTo(25, 16); g.lineTo(16, 26); g.lineTo(7, 16); g.closePath(); g.fill();
    g.fillStyle = dot;
    g.beginPath(); g.arc(24, 8, 7, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#0f1216'; g.lineWidth = 2; g.stroke();
    link.type = 'image/png';
    link.href = canvas.toDataURL('image/png');
  } catch { /* the favicon is decoration */ }
}
