import { describe, expect, test } from 'vitest';
import { POLL_PAUSED_MS, POLL_RUNNING_MS, pollDelay } from '../web/ui/src/polling.js';

describe('pollDelay', () => {
  test('a running run is asked every 2 s, a paused one every 5 s', () => {
    expect(pollDelay('running', true)).toBe(POLL_RUNNING_MS);
    expect(POLL_RUNNING_MS).toBe(2000);
    expect(pollDelay('paused', true)).toBe(POLL_PAUSED_MS);
    expect(POLL_PAUSED_MS).toBeGreaterThanOrEqual(5000);
    expect(POLL_PAUSED_MS).toBeLessThanOrEqual(10000);
  });

  test('a run not loaded yet is asked at the running rate until its state is known', () => {
    expect(pollDelay(undefined, true)).toBe(POLL_RUNNING_MS);
  });

  test('a settled run has no timer', () => {
    for (const s of ['done', 'failed', 'stopped', 'refused', 'interrupted', 'not started']) expect(pollDelay(s, true), s).toBeNull();
  });

  test('a hidden tab has no timer, whatever the state', () => {
    for (const s of ['running', 'paused', 'done', undefined]) expect(pollDelay(s, false), String(s)).toBeNull();
  });
});
