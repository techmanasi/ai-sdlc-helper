import { describe, expect, test } from 'vitest';
import { runTimeline } from '../src/runs/timeline.js';

const t = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}`;
const round = (stage: string, at: number, extra: Record<string, unknown> = {}) => ({ kind: 'agent', at: t(at), stage, agent: stage, durationSec: 2, turns: 1, tokens: 15, ...extra });
const usage = (costUsd: number | null) => ({ input: 10, output: 5, cacheRead: 100, cacheWrite: 7, costUsd });

describe('runTimeline', () => {
  test('a step ends when the next step starts, a stage when the next stage starts, and the last stays open', () => {
    const tl = runTimeline([
      { kind: 'stage', at: t(0), stage: 'Spec' },
      { kind: 'step', at: t(1), stage: 'Spec', key: 'a', label: 'A' },
      { kind: 'step', at: t(3), stage: 'Spec', key: 'b', label: 'B' },
      { kind: 'stage', at: t(5), stage: 'Plan' },
      { kind: 'step', at: t(6), stage: 'Plan', key: 'c', label: 'C' },
    ]);
    expect(tl.stages.map(s => s.stage)).toEqual(['Spec', 'Plan']);
    expect(tl.stages[0]).toMatchObject({ started: t(0), ended: t(5), passes: 1 });
    expect(tl.stages[0].steps).toEqual([{ key: 'a', label: 'A', started: t(1), ended: t(3) }, { key: 'b', label: 'B', started: t(3), ended: t(5) }]);
    expect(tl.stages[1].ended).toBeNull();
    expect(tl.stages[1].steps[0].ended).toBeNull();
    expect(tl.lock).toBeNull();
  });

  test('an end row closes the open stage and step', () => {
    const tl = runTimeline([
      { kind: 'stage', at: t(0), stage: 'Review' },
      { kind: 'step', at: t(1), stage: 'Review', key: 'agent', label: 'x' },
      { kind: 'end', at: t(9), state: 'done', stage: 'Review' },
    ]);
    expect(tl.stages[0].ended).toBe(t(9));
    expect(tl.stages[0].steps[0].ended).toBe(t(9));
  });

  test('two passes of one stage: one entry, the latest steps, usage of both', () => {
    const tl = runTimeline([
      { kind: 'stage', at: t(0), stage: 'Implement' },
      { kind: 'step', at: t(1), stage: 'Implement', key: 'old', label: 'Old' },
      round('implement', 2, { usage: usage(0.5) }),
      { kind: 'stage', at: t(10), stage: 'Test repair' },
      { kind: 'stage', at: t(20), stage: 'Implement' },
      { kind: 'step', at: t(21), stage: 'Implement', key: 'new', label: 'New' },
      round('implement', 22, { usage: usage(0.25) }),
    ]);
    expect(tl.stages.map(s => s.stage)).toEqual(['Implement', 'Test repair']);
    const impl = tl.stages[0];
    expect(impl.passes).toBe(2);
    expect(impl.steps.map(s => s.key)).toEqual(['new']);
    expect(impl.usage).toMatchObject({ rounds: 2, tokens: 30, input: 20, output: 10, cacheRead: 200, cacheWrite: 14, costUsd: 0.75, durationSec: 4, turns: 2 });
  });

  test('every pass of a stage is kept as a round with its own steps and times; the latest round holds the open step', () => {
    const tl = runTimeline([
      { kind: 'stage', at: t(0), stage: 'Implement' },
      { kind: 'step', at: t(1), stage: 'Implement', key: 'old', label: 'Old' },
      { kind: 'stage', at: t(10), stage: 'Test repair' },
      { kind: 'stage', at: t(20), stage: 'Implement' },
      { kind: 'step', at: t(21), stage: 'Implement', key: 'new', label: 'New' },
    ]);
    const impl = tl.stages[0];
    expect(impl.rounds.map(r => ({ started: r.started, ended: r.ended, steps: r.steps.map(x => x.key) })))
      .toEqual([{ started: t(0), ended: t(10), steps: ['old'] }, { started: t(20), ended: null, steps: ['new'] }]);
    expect(impl.steps).toBe(impl.rounds[1].steps);
    expect(tl.stages[1].rounds).toHaveLength(1);
  });

  test('a file with no stage rows has no rounds', () => {
    expect(runTimeline([{ kind: 'step', at: t(1), stage: 'Spec', key: 'a', label: 'A' }]).stages[0].rounds).toEqual([]);
  });

  test('cost is null when no round reported one, and totals sum over stages', () => {
    const none = runTimeline([{ kind: 'stage', at: t(0), stage: 'Spec' }, round('spec', 1), round('spec', 2, { usage: usage(null) })]);
    expect(none.stages[0].usage.costUsd).toBeNull();
    expect(none.usage.costUsd).toBeNull();
    const some = runTimeline([
      { kind: 'stage', at: t(0), stage: 'Spec' }, round('spec', 1, { usage: usage(1) }),
      { kind: 'stage', at: t(2), stage: 'Plan' }, round('plan', 3, { usage: usage(2) }), round('plan', 4),
    ]);
    expect(some.usage).toMatchObject({ rounds: 3, costUsd: 3, tokens: 45, input: 20 });
  });

  test('finer agent stages map onto the status stage, and an unknown one goes to the open stage', () => {
    const tl = runTimeline([
      { kind: 'stage', at: t(0), stage: 'Test repair' },
      round('test-repair', 1), round('test-audit', 2),
      { kind: 'stage', at: t(3), stage: 'Resolve conflicts' },
      round('resolve-review-2', 4), round('resolve-judge', 5), round('mystery', 6),
    ]);
    const by = Object.fromEntries(tl.stages.map(s => [s.stage, s.usage.rounds]));
    expect(by).toEqual({ 'Test repair': 2, 'Resolve conflicts': 3 });
  });

  test('an old file with only agent rounds builds stages from the rounds', () => {
    const tl = runTimeline([
      { kind: 'start', at: t(0), stage: 'spec', agent: 'spec' }, round('spec', 5),
      round('red-tests', 20, { durationSec: 4 }),
    ]);
    expect(tl.stages.map(s => s.stage)).toEqual(['Spec', 'Red tests']);
    expect(tl.stages[0]).toMatchObject({ started: t(0), ended: t(5), passes: 0, steps: [] });
    expect(new Date(tl.stages[1].started).getTime() - new Date(t(20)).getTime()).toBeLessThanOrEqual(0);
    expect(tl.usage.rounds).toBe(2);
  });

  test('a retry from or before Red tests removes the lock until the tests are committed again', () => {
    const lock = { kind: 'lock', at: t(1), sha: 'a'.repeat(40), origRedSha: 'a'.repeat(40), source: 'red-tests', tests: 6, files: 2 };
    const guard = { kind: 'guard', at: t(2), stage: 'Implement', restored: ['a.test.ts'] };
    for (const from of ['', 'spec', 'plan', 'red-tests']) {
      expect(runTimeline([lock, guard, { kind: 'run', at: t(3), from }]).lock).toBeNull();
    }
    for (const stage of ['Spec', 'Plan', 'Red tests']) {
      expect(runTimeline([lock, { kind: 'stage', at: t(3), stage }]).lock).toBeNull();
    }
    const again = runTimeline([lock, guard, { kind: 'run', at: t(3), from: 'red-tests' }, { kind: 'stage', at: t(4), stage: 'Red tests' }, { ...lock, at: t(5), sha: 'c'.repeat(40) }]).lock;
    expect(again).toMatchObject({ sha: 'c'.repeat(40), relocks: 0, guards: [] });
  });

  test('the lock is open, with its reason, from the moment locked tests may be changed until they are committed again', () => {
    const lock = { kind: 'lock', at: t(1), sha: 'a'.repeat(40), origRedSha: 'a'.repeat(40), source: 'red-tests', tests: 6, files: 2 };
    // never locked: nothing to open
    expect(runTimeline([{ kind: 'stage', at: t(1), stage: 'Red tests' }]).lockOpen).toBeNull();
    // locked: closed
    expect(runTimeline([lock]).lockOpen).toBeNull();
    // the user starts again at Red tests
    expect(runTimeline([lock, { kind: 'run', at: t(3), from: 'red-tests' }])).toMatchObject({ lock: null, lockOpen: { at: t(3), reason: 'retry', sha: 'a'.repeat(40) } });
    // Review sends its findings back through Red tests
    const loop = [lock, { kind: 'stage', at: t(2), stage: 'Implement' }, { kind: 'stage', at: t(3), stage: 'Review' }, { kind: 'stage', at: t(4), stage: 'Red tests' }];
    expect(runTimeline(loop)).toMatchObject({ lock: null, lockOpen: { at: t(4), reason: 'review-findings' } });
    // still open if the run stops there
    expect(runTimeline([...loop, { kind: 'end', at: t(5), state: 'failed', stage: 'Red tests' }]).lockOpen).toMatchObject({ reason: 'review-findings' });
    // closed again once the tests are committed
    expect(runTimeline([...loop, { ...lock, at: t(6), sha: 'c'.repeat(40) }])).toMatchObject({ lock: { sha: 'c'.repeat(40) }, lockOpen: null });
  });

  test('Test repair opens the lock while it works; an accepted repair locks again, a rejected one leaves the old lock closed', () => {
    const lock = { kind: 'lock', at: t(1), sha: 'a'.repeat(40), origRedSha: 'a'.repeat(40), source: 'red-tests', tests: 6, files: 2 };
    const repairing = [lock, { kind: 'stage', at: t(2), stage: 'Implement' }, { kind: 'stage', at: t(3), stage: 'Test repair' }];
    expect(runTimeline(repairing)).toMatchObject({ lock: { sha: 'a'.repeat(40) }, lockOpen: { at: t(3), reason: 'test-repair', sha: 'a'.repeat(40) } });
    expect(runTimeline([...repairing, { ...lock, at: t(4), sha: 'b'.repeat(40), source: 'test-repair' }])).toMatchObject({ lock: { sha: 'b'.repeat(40), relocks: 1 }, lockOpen: null });
    expect(runTimeline([...repairing, { kind: 'end', at: t(4), state: 'failed', stage: 'Test repair' }])).toMatchObject({ lock: { sha: 'a'.repeat(40) }, lockOpen: null });
    expect(runTimeline([...repairing, { kind: 'stage', at: t(4), stage: 'Implement' }])).toMatchObject({ lock: { sha: 'a'.repeat(40) }, lockOpen: null });
    // Test repair with no lock on record opens nothing
    expect(runTimeline([{ kind: 'stage', at: t(3), stage: 'Test repair' }]).lockOpen).toBeNull();
  });

  test('a resume after Red tests keeps the lock', () => {
    const lock = { kind: 'lock', at: t(1), sha: 'a'.repeat(40), origRedSha: 'a'.repeat(40), source: 'red-tests', tests: 6, files: 2 };
    for (const from of ['implement', 'test-repair', 'review', 'resolve-conflicts']) {
      expect(runTimeline([lock, { kind: 'run', at: t(3), from }, { kind: 'stage', at: t(4), stage: 'Implement' }]).lock).not.toBeNull();
    }
  });

  test('the latest lock with the number of earlier ones, and every guard', () => {
    const tl = runTimeline([
      { kind: 'lock', at: t(1), sha: 'a'.repeat(40), origRedSha: 'a'.repeat(40), source: 'red-tests', tests: 6, files: 2 },
      { kind: 'guard', at: t(2), stage: 'Implement', restored: ['t/a.test.ts'] },
      { kind: 'lock', at: t(3), sha: 'b'.repeat(40), origRedSha: 'a'.repeat(40), source: 'test-repair', tests: null, files: null },
      { kind: 'guard', at: t(4), stage: 'Review', restored: ['t/b.test.ts', 5] },
    ]);
    expect(tl.lock).toEqual({
      sha: 'b'.repeat(40), origRedSha: 'a'.repeat(40), at: t(3), source: 'test-repair', tests: null, files: null, relocks: 1,
      guards: [{ at: t(2), stage: 'Implement', restored: ['t/a.test.ts'] }, { at: t(4), stage: 'Review', restored: ['t/b.test.ts'] }],
    });
  });

  test('malformed rows are ignored and an empty list gives an empty timeline', () => {
    const tl = runTimeline([null, 'x', 3, {}, { kind: 'stage' }, { kind: 'step', at: t(1) }, { kind: 'agent', at: t(2), stage: 'spec', usage: 'bad' }]);
    expect(tl.stages.map(s => s.stage)).toEqual(['Spec']);
    expect(runTimeline([])).toMatchObject({ stages: [], lock: null, usage: { rounds: 0, costUsd: null } });
  });
});
