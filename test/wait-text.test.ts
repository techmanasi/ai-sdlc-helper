// The wait panel's words are a pure function of the wait record in status.json (via the API). This checks the real
// module the UI imports: no countdown, no waited-so-far, and no time that the record did not carry.
import { describe, expect, test } from 'vitest';
import type { WaitView } from '../web/ui/src/api.js';
import { waitText } from '../web/ui/src/waitPanel.js';

const wait = (over: Partial<WaitView> = {}): WaitView => ({
  reason: 'usage-limit',
  since: '2026-11-28T10:00:00.000Z',
  ...over,
});

describe('waitText', () => {
  test('names the limit from the record and nothing else when there is no reset time', () => {
    expect(waitText(wait())).toBe('Waiting for the usage limit to reset');
    expect(waitText(wait({ until: 'not-a-date' }))).toBe('Waiting for the usage limit to reset');
  });

  test('adds the reset clock time only when the record parsed one', () => {
    const until = new Date(2026, 10, 28, 1, 10, 0).toISOString();
    expect(waitText(wait({ until }))).toBe('Waiting for the usage limit to reset · resets 01:10');
    const midnight = new Date(2026, 10, 28, 0, 5, 0).toISOString();
    expect(waitText(wait({ until: midnight }))).toBe('Waiting for the usage limit to reset · resets 00:05');
  });

  test('is silent without a wait record or for a reason it does not know', () => {
    expect(waitText(null)).toBe('');
    expect(waitText(undefined)).toBe('');
    // an unknown reason cannot be described truthfully, so the panel stays empty
    expect(waitText({ reason: 'unknown', since: '' } as unknown as WaitView)).toBe('');
  });

  test('never renders a countdown or a waited-so-far duration', () => {
    const until = new Date(2026, 10, 28, 1, 10, 0).toISOString();
    const first = waitText(wait({ until }));
    const second = waitText(wait({ until }));
    expect(first).toBe(second);
    expect(first).not.toMatch(/\d+\s*(s|sec|second|min|minute|h|hour|left|remaining|ago|elapsed)/i);
  });
});
