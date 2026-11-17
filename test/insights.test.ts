import { describe, expect, test } from 'vitest';
import { cacheShare, costText, durationText, guarantees, hasUsage, lockSentence, skipped, spanSeconds, stripStates, tileLine, tokensText } from '../web/ui/src/insights.js';

const usage = (o: Partial<{ rounds: number; durationSec: number; turns: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null }> = {}) =>
  ({ rounds: 1, durationSec: 60, turns: 3, tokens: 1000, input: 200, output: 800, cacheRead: 600, cacheWrite: 200, costUsd: 0.5, ...o });
const span = (stage: string, o: Record<string, unknown> = {}) => ({ stage, started: '2026-11-17T10:00:00', ended: '2026-11-17T10:02:05', passes: 1, steps: [], usage: usage(), ...o });

describe('the stage strip on a board row', () => {
  test('stages before the current one are done, the current one takes the state, the rest wait', () => {
    expect(stripStates({ state: 'running', stage: 'Red tests' })).toEqual(['done', 'done', 'active', 'pending', 'pending', 'pending', 'pending']);
    expect(stripStates({ state: 'paused', stage: 'Spec' })[0]).toBe('paused');
    expect(stripStates({ state: 'failed', stage: 'Implement' })[3]).toBe('failed');
    expect(stripStates({ state: 'stopped', stage: 'Plan' })[1]).toBe('failed');
  });

  test('a finished run, and one resolving conflicts, have every stage done', () => {
    expect(stripStates({ state: 'done', stage: 'Finalise' }).every(s => s === 'done')).toBe(true);
    expect(stripStates({ state: 'running', stage: 'Resolve conflicts' }).every(s => s === 'done')).toBe(true);
  });

  test('a run that has not started, or names no stage, shows nothing done', () => {
    expect(stripStates({ state: 'not started', stage: '' }).every(s => s === 'pending')).toBe(true);
    expect(stripStates({ state: 'failed', stage: '' }).every(s => s === 'pending')).toBe(true);
  });

  test('the old name of Finalise is read as Finalise', () => {
    expect(stripStates({ state: 'running', stage: '6/6 Finalise' })[6]).toBe('active');
  });
});

describe('numbers as text', () => {
  test('durations', () => {
    expect(durationText(42)).toBe('42s');
    expect(durationText(185)).toBe('3m 05s');
    expect(durationText(4320)).toBe('1h 12m');
    expect(durationText(null)).toBe('');
    expect(durationText(-3)).toBe('');
  });

  test('tokens', () => {
    expect(tokensText(812)).toBe('812');
    expect(tokensText(14200)).toBe('14.2k');
    expect(tokensText(250000)).toBe('250k');
    expect(tokensText(1310000)).toBe('1.31M');
    expect(tokensText(0)).toBe('—');
    expect(tokensText(null)).toBe('—');
  });

  test('cost: a dash when the agent reported none, never a made-up zero', () => {
    expect(costText(null)).toBe('—');
    expect(costText(0.42)).toBe('$0.42');
    expect(costText(0.004)).toBe('<$0.01');
    expect(costText(0)).toBe('$0.00');
  });

  test('the share of the input read from the cache', () => {
    expect(cacheShare(usage())).toBe(60);
    expect(cacheShare(usage({ input: 0, cacheRead: 0, cacheWrite: 0 }))).toBeNull();
  });

  test('a total with no rounds and no tokens is not worth a row', () => {
    expect(hasUsage(usage())).toBe(true);
    expect(hasUsage(usage({ rounds: 0, tokens: 0 }))).toBe(false);
    expect(hasUsage(undefined)).toBe(false);
  });

  test('seconds between two times, to now while the end is open', () => {
    expect(spanSeconds('2026-11-17T10:00:00Z', '2026-11-17T10:00:30Z', 0)).toBe(30);
    expect(spanSeconds('2026-11-17T10:00:00Z', null, Date.parse('2026-11-17T10:01:00Z'))).toBe(60);
    expect(spanSeconds('nonsense', null, 5)).toBeNull();
  });
});

describe('the line on a stage tile', () => {
  const now = Date.parse('2026-11-17T10:03:00');
  test('a waiting stage and a skipped one', () => {
    expect(tileLine('pending', undefined, 0, '', now)).toBe('Not started');
    expect(tileLine('skipped', undefined, 0, '', now)).toBe('Not needed');
  });

  test('a running stage shows its step and the time since it began', () => {
    expect(tileLine('active', span('Implement', { ended: null }), 0, 'Running the tests', now)).toBe('Running the tests · 3m 00s');
  });

  test('a finished stage shows its files and how long it took', () => {
    expect(tileLine('done', span('Plan'), 2, '', now)).toBe('2 files · 2m 05s');
    expect(tileLine('done', undefined, 1, '', now)).toBe('1 file');
  });

  test('a paused and a failed stage say so', () => {
    expect(tileLine('paused', span('Spec'), 0, '', now)).toMatch(/^Waiting for you/);
    expect(tileLine('failed', span('Spec'), 0, '', now)).toMatch(/^Stopped here/);
  });
});

describe('Test repair that was never needed', () => {
  test('skipped when the run is past it and it has no record and no files', () => {
    expect(skipped('Test repair', 'done', [span('Implement')], {})).toBe(true);
  });

  test('not skipped when it ran, changed files, is still ahead, or there is no timeline to tell', () => {
    expect(skipped('Test repair', 'done', [span('Test repair')], {})).toBe(false);
    expect(skipped('Test repair', 'done', [], { 'Test repair': ['a.test.ts'] })).toBe(false);
    expect(skipped('Test repair', 'pending', [], {})).toBe(false);
    expect(skipped('Test repair', 'done', undefined, {})).toBe(false);
    expect(skipped('Review', 'done', [], {})).toBe(false);
  });
});

describe('what protects a run', () => {
  const base = { state: 'running' as const, stage: 'Implement', redCommit: '', worktree: '/w/x', branch: 'sdlc/x', pr: null, prState: null, prCi: null, ci: null, timeline: undefined };
  const lock = { sha: 'abcdef1234567', origRedSha: 'abcdef1234567', at: '2026-11-17T10:00:00', source: 'red-tests' as const, tests: 5, files: 2, relocks: 0, guards: [] };
  const timeline = (l: typeof lock | null) => ({ stages: [], lock: l, usage: usage({ rounds: 0, tokens: 0 }) });
  const by = (v: Parameters<typeof guarantees>[0]) => Object.fromEntries(guarantees(v).map(g => [g.key, g]));

  test('before Red tests nothing is locked', () => {
    const g = by({ ...base, stage: 'Spec' });
    expect(g.lock.state).toBe('pending');
    expect(g.gates.title).toBe('0 of 7 stages checked');
  });

  test('after Red tests the lock is held and names the commit and the tests', () => {
    const g = by({ ...base, timeline: timeline(lock) });
    expect(g.lock.state).toBe('held');
    expect(g.lock.detail).toContain('5 tests at abcdef1');
    expect(g.gates.title).toBe('3 of 7 stages checked');
  });

  test('a run on an older server still shows the lock from its red commit', () => {
    expect(by({ ...base, redCommit: '1234567' }).lock.detail).toContain('1234567');
  });

  test('a stopped edit of a locked test is counted', () => {
    const g = by({ ...base, timeline: timeline({ ...lock, guards: [{ at: 'x', stage: 'Implement', restored: ['a.test.ts'] }] as never }) });
    expect(g.lock.detail).toContain('1 edit stopped');
  });

  test('a failed run breaks the gate promise at its stage, and CI decides the last one', () => {
    expect(by({ ...base, state: 'failed' }).gates.state).toBe('broken');
    expect(by({ ...base, state: 'done', stage: 'Finalise', pr: 'u', prCi: 'passed' }).pr.state).toBe('held');
    expect(by({ ...base, pr: 'u', prCi: 'failed' }).pr.state).toBe('broken');
    expect(by({ ...base, state: 'done', stage: 'Finalise', pr: 'u', prState: 'MERGED' }).pr.title).toBe('Merged');
  });

  test('a run with no worktree does not claim one', () => {
    expect(by({ ...base, worktree: null }).isolated.state).toBe('pending');
  });

  test('the lock in one sentence', () => {
    expect(lockSentence(lock)).toBe('5 tests in 2 files were locked when Red tests finished. Implement and Review cannot change them.');
    expect(lockSentence({ ...lock, tests: null, files: null, source: 'test-repair' })).toContain('locked again after an audited Test repair');
  });
});
