import { describe, expect, test } from 'vitest';
import { cacheShare, costText, durationText, guarantees, hasUsage, lockSentence, openLock, openSentence, skipped, spanSeconds, stripStates, tileLine, tokensText, verifiedLock, usageText, costCell, costNotes } from '../web/ui/src/insights.js';

const usage = (o: Partial<{ rounds: number; durationSec: number; turns: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null; estimatedUsd: number; unpriced: number }> = {}) =>
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

describe('the test lock is shown only when it is recorded and confirmed', () => {
  const lock = { sha: 'abcdef1234567', origRedSha: 'abcdef1234567', at: '2026-11-17T10:00:00', source: 'red-tests' as const, tests: 5, files: 2, relocks: 0, guards: [] };
  const timeline = (l: typeof lock | null) => ({ lock: l });

  test('an open lock is never shown as closed, and says why it is open', () => {
    const open = { at: '2026-11-17T10:05:00', reason: 'test-repair' as const, sha: 'abcdef1234567' };
    const v = { redCommit: 'abcdef1', timeline: { lock, lockOpen: open } };
    expect(verifiedLock(v)).toBeNull();
    expect(openLock(v)).toBe(open);
    expect(openSentence(open)).toMatch(/^Open: Test repair is changing the tests it claimed \(they were locked at abcdef1\)/);
    expect(openSentence({ ...open, reason: 'review-findings' })).toMatch(/^Open: Review asked for changes/);
    expect(openSentence({ ...open, reason: 'retry', sha: '' })).toMatch(/^Open: a stage at or before Red tests was started again, so the tests are being rewritten\. /);
    expect(openLock({ timeline: { lock } })).toBeNull();
    expect(openLock({ timeline: undefined })).toBeNull();
  });

  test('a recorded lock with a red-tests commit on the branch is shown', () => {
    expect(verifiedLock({ redCommit: 'abcdef1', timeline: timeline(lock) })).toBe(lock);
  });

  test('a run past Red tests with no lock record shows none (a run made before locks were recorded)', () => {
    expect(verifiedLock({ redCommit: 'abcdef1', timeline: timeline(null) })).toBeNull();
    expect(verifiedLock({ redCommit: 'abcdef1', timeline: undefined })).toBeNull();
  });

  test('a lock record without a red-tests commit on the branch shows none', () => {
    expect(verifiedLock({ redCommit: '', timeline: timeline(lock) })).toBeNull();
  });

  test('a lock record without a commit shows none', () => {
    expect(verifiedLock({ redCommit: 'abcdef1', timeline: timeline({ ...lock, sha: '' }) })).toBeNull();
  });

  test('the sentence names the commit and claims nothing about what happened since', () => {
    expect(lockSentence(lock)).toBe('5 tests in 2 files were locked when Red tests committed them, at abcdef1. A later stage that changes them is stopped.');
    expect(lockSentence({ ...lock, tests: null, files: null, source: 'test-repair' })).toContain('locked again after Test repair');
    expect(lockSentence(lock)).not.toMatch(/untouched|since/);
  });
});

describe('what the records show about a run', () => {
  const base = { state: 'running', stage: 'Implement', redCommit: 'abcdef1', worktree: '/w/x', branch: 'sdlc/x', pr: null, prState: null, prCi: null, ci: null, timeline: undefined };
  const by = (v: Parameters<typeof guarantees>[0]) => Object.fromEntries(guarantees(v).map(g => [g.key, g]));

  test('there is no lock item and no count of checked stages', () => {
    const all = guarantees(base);
    expect(all.map(g => g.key)).toEqual(['gates', 'isolated', 'pr']);
    expect(all.map(g => `${g.title} ${g.detail}`).join(' ')).not.toMatch(/locked|\d+ of \d+/i);
    expect(by(base).gates.state).toBe('pending');
    expect(by({ ...base, state: 'done', stage: 'Finalise' }).gates.state).toBe('pending');
  });

  test('the pull request item follows the recorded PR state and CI', () => {
    expect(by({ ...base, state: 'done', stage: 'Finalise', pr: 'u', prCi: 'passed' }).pr.state).toBe('held');
    expect(by({ ...base, pr: 'u', prCi: 'failed' }).pr.state).toBe('broken');
    expect(by({ ...base, state: 'done', stage: 'Finalise', pr: 'u', prState: 'MERGED' }).pr).toMatchObject({ title: 'Merged', detail: 'In the base branch' });
    expect(by(base).pr.state).toBe('pending');
  });

  test('a run with no worktree does not claim one', () => {
    expect(by({ ...base, worktree: null }).isolated.state).toBe('pending');
    expect(by(base).isolated).toMatchObject({ state: 'held', detail: 'sdlc/x' });
  });
});

describe('cost and tokens together', () => {
  test('a paid model shows dollars and tokens; an estimate is marked', () => {
    expect(usageText(usage({ costUsd: 0.42, tokens: 412_000 }))).toBe('$0.42 · 412k tok');
    expect(usageText(usage({ costUsd: 0.42, estimatedUsd: 0.1, tokens: 412_000 }))).toBe('≈$0.42 · 412k tok');
    expect(costCell(usage({ costUsd: 0.42, estimatedUsd: 0.1 }))).toBe('≈$0.42');
  });

  test('a free model, or one with no price, shows tokens only', () => {
    expect(usageText(usage({ costUsd: 0, tokens: 5000 }))).toBe('5.0k tok');
    expect(usageText(usage({ costUsd: null, tokens: 5000 }))).toBe('5.0k tok');
    expect(costCell(usage({ costUsd: 0 }))).toBe('free');
    expect(costCell(usage({ costUsd: null }))).toBe('—');
    expect(usageText(usage({ costUsd: null, tokens: 0, input: 0, output: 0 }))).toBe('');
    expect(usageText(null)).toBe('');
  });

  test('notes say what is estimated and what is left out', () => {
    expect(costNotes(usage())).toEqual([]);
    const notes = costNotes(usage({ estimatedUsd: 0.2, unpriced: 2 }));
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatch(/^2 agent rounds reported tokens but no cost/);
  });
});
