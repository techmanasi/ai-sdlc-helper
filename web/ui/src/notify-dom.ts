/// <reference lib="dom" />
// The browser side of the notifications: the desktop notification, the chime, the favicon badge. Each is safe to call
// anywhere (never throws; does nothing where the API is missing). The decisions are in notify.ts, which the tests import.
// The shapes are repeated here, not imported: the test project reads this file too, and it resolves imports differently.
type AttentionKind = 'paused' | 'failed' | 'done';
interface Attention { slug: string; kind: AttentionKind; title: string; body: string }

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
