// Plain text for the wait panel. Every word comes from the wait record: no countdown, no waited-so-far, no rule text
// guessed from a status note. A time is shown only when the record has one.
import type { WaitView } from './api.js';

/** "Waiting for the usage limit to reset · resets 01:10" (no "resets" when the record has no parsed reset time). */
export function waitText(wait: WaitView | null | undefined): string {
  if (!wait || wait.reason !== 'usage-limit') return '';
  const base = 'Waiting for the usage limit to reset';
  if (!wait.until) return base;
  const at = new Date(wait.until);
  if (Number.isNaN(at.getTime())) return base;
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  return `${base} · resets ${time}`;
}
