// How often a page asks for a run again: the delay rules, with no Preact imports so tests can import them
// (docs/plans/run-view-performance.md, Step 1). null means no timer.
export const POLL_RUNNING_MS = 2000;
export const POLL_PAUSED_MS = 5000;

/**
 * The delay before the next load. A running run changes by the second; a paused one waits for a person; every other
 * state (done, failed, stopped, refused, interrupted, not started) changes only when someone acts, so it loads once,
 * again after the action, and on focus. A hidden tab has no timer; it loads once when it is visible again.
 */
export function pollDelay(state: string | undefined, visible: boolean): number | null {
  if (!visible) return null;
  if (state === undefined || state === 'running') return POLL_RUNNING_MS;
  if (state === 'paused') return POLL_PAUSED_MS;
  return null;
}
