import { describe, expect, test } from 'vitest';
import { answeredBetween, attemptMarksLabel, backBar, backToImplementText, doneFoldLabel, edgeScrollTarget, foldDone, followedStage, followNote, hiddenCounts, mayAutoScroll, paneTone, phoneOpens, pickRound, prBadge, roundEndText, roundLabel, roundMarks, roundMarksLabel, roundStartText, roundsOf, scrollTarget, shownStage, stepPills, waitsFor } from '../web/ui/src/stagePane.js';
import type { AttemptRound, StageRound } from '../web/ui/src/api.js';

const attempt = (over: Partial<AttemptRound> = {}): AttemptRound => ({
  at: '2026-11-28T10:00:00Z', stage: 'implement', agent: 'impl-1',
  durationSec: 30, exitCode: 1, responseChars: 100, turns: 2, tokens: 100,
  denied: [], filesChanged: [], warnings: [], ...over,
});

const stage = (name: string, state: string) => ({ name, key: name.toLowerCase().replace(' ', '-'), state: state as never });
const rail = (states: Record<string, string>) => Object.entries(states).map(([n, s]) => stage(n, s));

describe('the stage the pane follows', () => {
  test('the running stage, else the one that paused or failed', () => {
    expect(followedStage(rail({ Spec: 'done', Plan: 'active', 'Red tests': 'pending' }), { state: 'running', stage: 'Plan' })).toBe('plan');
    expect(followedStage(rail({ Spec: 'done', Plan: 'done', 'Red tests': 'failed', Implement: 'pending' }), { state: 'failed', stage: 'Red tests' })).toBe('red-tests');
    expect(followedStage(rail({ Spec: 'paused' }), { state: 'paused', stage: 'Spec' })).toBe('spec');
  });
  test('a ready run follows the stage it resumes at; a finished run the last that ran; a new run the first', () => {
    expect(followedStage(rail({ Spec: 'done', Plan: 'done', 'Red tests': 'pending' }), { state: 'ready', stage: 'Red tests' })).toBe('red-tests');
    expect(followedStage(rail({ Spec: 'done', Plan: 'done', Review: 'done', Finalise: 'pending' }), { state: 'done', stage: 'Review' })).toBe('review');
    expect(followedStage(rail({ Spec: 'pending', Plan: 'pending' }), { state: 'not started', stage: 'Spec' })).toBe('spec');
    expect(followedStage([], { state: 'done', stage: '' })).toBe('');
  });
  test('a picked stage wins while it exists; one that left the rail falls back to the followed stage', () => {
    const r = rail({ Spec: 'done', Plan: 'active' });
    expect(shownStage(r, 'plan', 'spec')).toBe('spec');
    expect(shownStage(r, 'plan', '')).toBe('plan');
    expect(shownStage(r, 'plan', 'resolve-conflicts')).toBe('plan');
  });
});

describe('what the pane says', () => {
  test('tone by state', () => {
    expect(['failed', 'paused', 'active', 'done', 'pending', 'skipped'].map(s => paneTone(s as never))).toEqual(['stop', 'stop', 'run', 'done', 'idle', 'idle']);
  });
  test('the follow note names why the stage is shown, and is empty for a picked stage or a finished one', () => {
    expect(followNote('active', true)).toBe('Following the running stage');
    expect(followNote('failed', true)).toBe('Following the stage where the run stopped');
    expect(followNote('active', false)).toBe('');
    expect(followNote('done', true)).toBe('');
  });
  test('the back bar names both stages and the way back; null on the followed stage', () => {
    const r = rail({ Spec: 'done', Plan: 'done', 'Red tests': 'done', Implement: 'active', Review: 'pending' });
    expect(backBar(r, 'implement', 'implement')).toBeNull();
    expect(backBar(r, 'implement', 'plan')).toEqual({ text: 'You are looking at Plan. Implement is running. This pane goes back to the running stage by itself when the run moves on.', back: 'Back to Implement', live: true });
    expect(backBar(r, 'implement', 'review')?.text).toMatch(/^You are looking at Review, which has not started\./);
    const f = rail({ Spec: 'done', 'Red tests': 'failed', Plan: 'done' });
    expect(backBar(f, 'red-tests', 'plan')).toMatchObject({ text: 'You are looking at Plan. The run stopped at Red tests.', back: 'Back to Red tests', live: false });
  });
  test('what a stage that has not started waits for', () => {
    expect(waitsFor('Review')).toEqual(['Implement', 'Test repair, if needed']);
    expect(waitsFor('Nope')).toEqual([]);
  });
});

describe('rounds', () => {
  const step = (key: string) => ({ key, label: key, started: 'a', ended: 'b' });
  test('a span without rounds stands in as one round; a missing span has none', () => {
    expect(roundsOf(undefined)).toEqual([]);
    const old = { stage: 'Spec', started: 's', ended: 'e', passes: 1, steps: [step('a')], usage: {} as never };
    expect(roundsOf(old)).toEqual([{ started: 's', ended: 'e', steps: [step('a')] }]);
    expect(roundsOf({ ...old, rounds: [{ started: '1', ended: '2', steps: [] }, { started: '3', ended: null, steps: [] }] })).toHaveLength(2);
  });
  test('the round on view is the picked one when it exists, else the latest', () => {
    const rs = [{ started: '1', ended: '2', steps: [] }, { started: '3', ended: null, steps: [] }];
    expect([0, 1, 2, 3, -1].map(n => pickRound(rs, n))).toEqual([2, 1, 2, 2, 2]);
    expect(roundLabel(1)).toBe('');
    expect(roundLabel(3)).toBe('Round 3');
    expect(roundLabel(undefined)).toBe('');
  });
});

describe('round marks on the tile', () => {
  const round = (extra: Partial<StageRound> = {}): StageRound => ({ started: '2026-11-28T10:00:00Z', ended: '2026-11-28T10:01:00Z', steps: [], ...extra });
  test('one mark per round, with a tone taken only from the record', () => {
    expect(roundMarks([
      round({ cause: 'questions', next: 'pause' }),
      round({ cause: 'passed', next: 'next-stage' }),
      round({ cause: 'check-failed', next: 'retry' }),
      round({ ended: null }),
      round(),
    ])).toEqual([
      { n: 1, tone: 'stop', label: 'questions' },
      { n: 2, tone: 'done', label: 'passed' },
      { n: 3, tone: 'stop', label: 'check failed' },
      { n: 4, tone: 'run', label: 'running' },
      { n: 5, tone: 'idle', label: '' },
    ]);
  });
  test('the accessible label names each recorded cause, a running round, and nothing for a missing cause', () => {
    const rs = [round({ cause: 'questions' }), round({ cause: 'passed' }), round({ ended: null }), round()];
    expect(roundMarksLabel(rs)).toBe('Rounds: 1 questions, 2 passed, 3 running, 4');
    expect(roundMarksLabel([])).toBe('');
    expect(roundMarksLabel([round()])).toBe('Rounds: 1');
  });
  test('every cause has its own word', () => {
    const causes: StageRound['cause'][] = ['passed', 'check-failed', 'questions', 'permission', 'limit', 'error', 'stopped', 'review-changes'];
    expect(roundMarks(causes.map(cause => round({ cause }))).map(m => m.label)).toEqual([
      'passed', 'check failed', 'questions', 'permission', 'limit', 'error', 'stopped', 'review changes',
    ]);
  });
});

describe('the rounds in the pane', () => {
  const round = (extra: Partial<StageRound> = {}): StageRound => ({ started: '2026-11-28T10:00:00Z', ended: '2026-11-28T10:01:00Z', steps: [], ...extra });
  test('the start line uses only a recorded reason', () => {
    expect((['run', 'resume', 'retry', 'review', 'user'] as const).map(startedBy => roundStartText(round({ startedBy })))).toEqual([
      'started: the run reached this stage', 'started: resumed', 'started: retry', 'started: review asked for changes', 'started: you started it',
    ]);
    expect(roundStartText(round())).toBe('');
    expect(roundStartText(undefined)).toBe('');
  });
  test('the end line names the cause and what came next, in words', () => {
    expect(roundEndText(round({ cause: 'questions', next: 'pause' }))).toBe('Questions → paused for your answers');
    expect(roundEndText(round({ cause: 'check-failed', next: 'retry' }))).toBe('Check failed → retry');
    expect(roundEndText(round({ cause: 'passed', next: 'next-stage' }))).toBe('Passed → next stage');
    expect(roundEndText(round({ cause: 'review-changes', next: 'retry' }))).toBe('Review changes → retry');
    expect(roundEndText(round({ cause: 'stopped', next: 'stop' }))).toBe('Stopped → stop');
    expect(roundEndText(round({ cause: 'permission', next: 'pause' }))).toBe('Permission → pause');
    expect(roundEndText(round({ cause: 'limit', next: 'retry' }))).toBe('Limit → retry');
    expect(roundEndText(round({ cause: 'error', next: 'stop' }))).toBe('Error → stop');
  });
  test('a missing field is no claim: no cause, no next, or still running', () => {
    expect(roundEndText(round())).toBe('');
    expect(roundEndText(undefined)).toBe('');
    expect(roundEndText(round({ ended: null, cause: 'passed', next: 'next-stage' }))).toBe('');
    expect(roundEndText(round({ cause: 'passed' }))).toBe('Passed');
  });
  test('the answered line needs both the end and the recorded answer time', () => {
    const prev = round({ ended: '2026-11-28T10:00:00Z', answeredAt: '2026-11-28T10:00:58Z' });
    const next = round({ started: '2026-11-28T10:00:58Z' });
    expect(answeredBetween(prev, next)).toBe('You answered · 00:58');
    expect(answeredBetween(prev, next, 3)).toBe('You answered 3 · 00:58');
    expect(answeredBetween({ ...prev, answeredAt: '2026-11-28T10:02:05Z' }, next)).toBe('You answered · 02:05');
    expect(answeredBetween({ ...prev, answeredAt: undefined }, next)).toBe('');
    expect(answeredBetween({ ...prev, ended: null }, next)).toBe('');
    expect(answeredBetween(prev, undefined)).toBe('');
    expect(answeredBetween({ ...prev, answeredAt: '2026-11-28T09:59:00Z' }, next)).toBe('');
    expect(answeredBetween({ ...prev, answeredAt: 'not a time' }, next)).toBe('');
  });
});

describe('the pull request badge', () => {
  const url = 'https://github.com/o/r/pull/42';
  test('none without a pull request', () => {
    expect(prBadge({})).toBeNull();
    expect(prBadge({ pr: null })).toBeNull();
  });
  test('merged, closed, CI passed, failed, running, and not yet reported', () => {
    expect(prBadge({ pr: url, prState: 'MERGED' })?.text).toBe('PR · merged');
    expect(prBadge({ pr: url, prState: 'CLOSED' })?.tone).toBe('plain');
    expect(prBadge({ pr: url, prState: 'OPEN', prCi: 'passed' })).toMatchObject({ text: 'PR · CI ✓', tone: 'ok', title: 'Pull request #42 is open and its CI passed' });
    expect(prBadge({ pr: url, prCi: 'failed' })).toMatchObject({ text: 'PR · CI ✕', tone: 'bad' });
    expect(prBadge({ pr: url, prCi: 'in progress' })).toMatchObject({ text: 'PR · CI …', tone: 'wait' });
    expect(prBadge({ pr: url, prCi: 'none' })).toMatchObject({ text: 'PR · open', tone: 'wait' });
  });
});

describe('the rail on a narrow window', () => {
  const tiles = [0, 1, 2, 3, 4, 5].map(i => ({ left: i * 160, width: 150 }));
  test('leading done stages fold only when the un-folded rail does not fit', () => {
    const r = rail({ Spec: 'done', Plan: 'done', 'Red tests': 'done', Implement: 'done', 'Test repair': 'active', Review: 'pending' });
    const fold = foldDone(r, false, 'test-repair');
    expect(fold.folded.map(s => s.name)).toEqual(['Spec', 'Plan', 'Red tests', 'Implement']);
    expect(fold.shown.map(s => s.name)).toEqual(['Test repair', 'Review']);
    expect(doneFoldLabel(fold.folded)).toBe('4 stages done: Spec, Plan, Red tests, Implement');
    expect(foldDone(r, true, 'test-repair')).toEqual({ folded: [], shown: r });
  });
  test('the fold never takes a live stage or the picked stage, and never leaves only a fold', () => {
    const stopped = rail({ Spec: 'done', Plan: 'paused', 'Red tests': 'failed', Implement: 'active' });
    expect(foldDone(stopped, false, '').folded.map(s => s.name)).toEqual(['Spec']);
    expect(foldDone(stopped, false, '').shown.map(s => s.name)).toEqual(['Plan', 'Red tests', 'Implement']);
    const picked = rail({ Spec: 'done', Plan: 'done', Implement: 'active' });
    expect(foldDone(picked, false, 'plan').folded.map(s => s.name)).toEqual(['Spec']);
    expect(foldDone(picked, false, 'spec').folded).toEqual([]);
    expect(doneFoldLabel(foldDone(picked, false, 'plan').folded)).toBe('1 stage done: Spec');
    const allDone = rail({ Spec: 'done', Plan: 'done' });
    expect(foldDone(allDone, false, '').shown.map(s => s.name)).toEqual(['Plan']);
  });
  test('hidden counts per edge: a tile counts once its middle is out of view', () => {
    expect(hiddenCounts(tiles, 0, 500)).toEqual({ left: 0, right: 3 });
    expect(hiddenCounts(tiles, 320, 500)).toEqual({ left: 2, right: 1 });
    expect(hiddenCounts(tiles, 0, 2000)).toEqual({ left: 0, right: 0 });
  });
  test('scroll target: null when in view, else lands with a margin', () => {
    expect(scrollTarget(tiles[1], 0, 500)).toBeNull();
    expect(scrollTarget(tiles[5], 0, 500)).toBe(800 + 150 - 500 + 48);
    expect(scrollTarget(tiles[1], 300, 500)).toBe(112);
    expect(scrollTarget(tiles[0], 100, 500)).toBe(0);
  });
  test('edge arrows bring the nearest hidden tile into view and disappear when that side has none', () => {
    expect(edgeScrollTarget(tiles, 0, 500, 'right')).toBe(178);
    expect(edgeScrollTarget(tiles, 320, 500, 'left')).toBe(112);
    expect(edgeScrollTarget(tiles, 0, 2000, 'right')).toBeNull();
    expect(edgeScrollTarget(tiles, 0, 500, 'left')).toBeNull();
  });
  test('auto scroll leaves the rail alone for a few seconds after the user scrolled it', () => {
    expect(mayAutoScroll(10_000, 12_000)).toBe(false);
    expect(mayAutoScroll(10_000, 14_000)).toBe(true);
    expect(mayAutoScroll(0, 1_000_000)).toBe(true);
  });
});

describe('the phone', () => {
  test('the details open by themselves only for a stage that paused or failed', () => {
    expect([undefined, 'active', 'done', 'pending', 'paused', 'failed'].map(s => phoneOpens(s as never))).toEqual([false, false, false, false, true, true]);
  });
});

describe('Implement attempts', () => {
  test('the tile label counts failed and running attempts and the recorded attempts left', () => {
    const rows = [attempt({ agent: 'impl-1' }), attempt({ agent: 'impl-2' }), attempt({ agent: 'impl-3', exitCode: 0, running: true })];
    expect(attemptMarksLabel(rows, 5)).toBe('Attempts: 1 failed, 2 failed, 3 running, 2 left');
  });

  test('no "left" without a recorded max, and no label without recorded attempts', () => {
    const rows = [attempt(), attempt({ agent: 'impl-2', exitCode: 0, running: true })];
    expect(attemptMarksLabel(rows)).toBe('Attempts: 1 failed, 2 running');
    expect(attemptMarksLabel([], 5)).toBe('');
    // A max already used up adds no remaining marks.
    expect(attemptMarksLabel(rows, 2)).toBe('Attempts: 1 failed, 2 running');
  });

  test('the back-to line uses the recorded gate failures, else the error first line, else nothing', () => {
    expect(backToImplementText(attempt({ gate: { failing: ['a', 'b', 'c'], warnings: [] } }))).toBe('↩ Back to Implementing: 3 tests failing');
    expect(backToImplementText(attempt({ error: 'Error: lint failed\n  at line 4', gate: { failing: ['a'], warnings: [] } }))).toBe('↩ Back to Implementing: 1 test failing');
    expect(backToImplementText(attempt({ error: '  Error: lint failed  \n  at line 4' }))).toBe('↩ Back to Implementing: Error: lint failed');
    expect(backToImplementText(attempt())).toBe('');
  });
});

test('only the running pill counts up and a stop keeps its time after reload', () => {
  const started = '2026-11-19T12:00:00Z';
  const ended = '2026-11-19T12:00:42Z';
  const step = { key: 'write', label: 'Write tests', started, ended: null };
  const round = { started, ended: null, steps: [step] };
  const plan = ['Write tests', 'Check tests'];
  const later = Date.parse(ended) + 10000;
  expect(stepPills(round, 'active', plan, ended, later)).toEqual([
    { label: 'Write tests', state: 'open', time: '52s' },
    { label: 'Check tests', state: 'plan', time: '' },
  ]);
  expect(stepPills(round, 'failed', plan, ended, later)[0].time).toBe('failed at 42s');
  expect(stepPills(round, 'active', ['Read answers', ...plan], ended, later).map(pill => pill.label)).toEqual(plan);
  const closed = { ...round, ended, steps: [{ ...step, ended }] };
  expect(stepPills(closed, 'failed', plan, '', later)[0]).toEqual({ label: 'Write tests', state: 'cut', time: 'failed at 42s' });
  expect(stepPills(closed, 'done', [], '', later)[0]).toEqual({ label: 'Write tests', state: 'done', time: '42s' });
});
