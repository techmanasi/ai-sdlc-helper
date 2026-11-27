import { describe, expect, test } from 'vitest';
import { awaitsMerge, linkPaths, resolveShown, showTestIssues, testRepairStarted } from '../web/ui/src/stages.js';
import {
  BOARD_STAGES,
  CONDITIONAL_STAGES,
  segments,
  segStateOf,
  segmentLabel,
  boardStageText,
  relativeTime,
} from '../web/ui/src/boardStages.js';

const pr = (state: 'OPEN' | 'MERGED' | 'CLOSED' | null) => ({ url: 'https://github.com/o/r/pull/85', state, number: 85, checkedAt: null, failed: false });

describe('what stays on the board', () => {
  test('a finished run stays until its pull request is merged', () => {
    expect(awaitsMerge({ state: 'done', pullRequest: pr('OPEN') })).toBe(true);
    expect(awaitsMerge({ state: 'done', pullRequest: pr('CLOSED') })).toBe(true);
    expect(awaitsMerge({ state: 'done', pullRequest: pr(null) })).toBe(true);
    expect(awaitsMerge({ state: 'done', pullRequest: null })).toBe(true);
    expect(awaitsMerge({ state: 'done', pullRequest: pr('MERGED') })).toBe(false);
  });

  test('a run that is not done is not waiting for a merge', () => {
    expect(awaitsMerge({ state: 'running', pullRequest: null })).toBe(false);
    expect(awaitsMerge({ state: 'failed', pullRequest: pr('OPEN') })).toBe(false);
  });
});

describe('Resolve conflicts on the stage rail', () => {
  const view = (o: Partial<Parameters<typeof resolveShown>[0]> = {}) => ({ stage: 'Finalise', record: null, stageFiles: {}, docs: ['brief.md', 'logs/run.out'], ...o });

  test('hidden for a finished run that never ran it', () => {
    expect(resolveShown(view())).toBe(false);
  });

  test('shown while it runs or after it ran', () => {
    expect(resolveShown(view({ stage: 'Resolve conflicts' }))).toBe(true);
    expect(resolveShown(view({ record: { from: 'resolve-conflicts' } }))).toBe(true);
    expect(resolveShown(view({ stageFiles: { 'Resolve conflicts': ['a.ts'] } }))).toBe(true);
    expect(resolveShown(view({ docs: ['logs/resolve-conflicts.json'] }))).toBe(true);
  });
});

describe('the test defect claims panel', () => {
  const view = (o: Record<string, unknown> = {}) => ({ testIssues: 'a :: b :: c', stage: 'Implement', state: 'failed', stageFiles: {}, docs: ['test-issues.md'], ...o });

  test('shows while Implement is over and Test repair has not started', () => {
    expect(showTestIssues(view())).toBe(true);
    expect(showTestIssues(view({ state: 'paused' }))).toBe(true);
  });

  test('hides once Test repair started, ran, or the run is past it, and when there are no claims', () => {
    expect(showTestIssues(view({ stage: 'Test repair', state: 'paused' }))).toBe(false);
    expect(showTestIssues(view({ stage: 'Review', state: 'running' }))).toBe(false);
    expect(showTestIssues(view({ stage: 'Finalise', state: 'done' }))).toBe(false);
    expect(showTestIssues(view({ stageFiles: { 'Test repair': ['x.md'] } }))).toBe(false);
    expect(showTestIssues(view({ docs: ['test-issues.md', 'test-repair-1.md'] }))).toBe(false);
    expect(showTestIssues(view({ testIssues: null }))).toBe(false);
    expect(testRepairStarted(view())).toBe(false);
  });
});

describe('paths in a question', () => {
  const docs = ['brief.md', 'logs/resolve-conflicts.md', 'logs/resolve-conflict-followup.md'];
  test('a path written from the repository root or from the task folder becomes a link; unknown files stay text', () => {
    const text = 'stopped (see docs/backlog/ci-full-suite-gate/logs/resolve-conflicts.md). The draft is logs/resolve-conflict-followup.md; add it to docs/backlog/index.md.';
    expect(linkPaths(text, docs, 'ci-full-suite-gate')).toEqual([
      'stopped (see ', { path: 'logs/resolve-conflicts.md' }, '). The draft is ', { path: 'logs/resolve-conflict-followup.md' }, '; add it to docs/backlog/index.md.',
    ]);
  });
  test('text without a known file is returned whole', () => {
    expect(linkPaths('nothing here', docs, 'x')).toEqual(['nothing here']);
  });
});

// --- boardStages ---

const mark = (stage: string, status: 'started' | 'completed' | 'failed' | 'paused' | 'stopped', started: string, ended: string | null = null) =>
  ({ stage, status, started, ended });

describe('BOARD_STAGES', () => {
  test('has all 8 stages in order, with Test repair and Resolve conflicts as conditional', () => {
    expect(BOARD_STAGES).toEqual(['Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Finalise', 'Resolve conflicts']);
    expect(CONDITIONAL_STAGES.has('Test repair')).toBe(true);
    expect(CONDITIONAL_STAGES.has('Resolve conflicts')).toBe(true);
    expect(CONDITIONAL_STAGES.has('Implement')).toBe(false);
  });
});

describe('segStateOf', () => {
  test('not reached when there are no marks', () => {
    expect(segStateOf('Spec', undefined)).toBe('not reached');
    expect(segStateOf('Spec', null)).toBe('not reached');
    expect(segStateOf('Spec', [])).toBe('not reached');
  });

  test('not reached when the stage has no matching mark', () => {
    expect(segStateOf('Review', [mark('Spec', 'completed', 'T1', 'T2')])).toBe('not reached');
  });

  test('running for a started stage', () => {
    expect(segStateOf('Implement', [mark('Implement', 'started', 'T1')])).toBe('running');
  });

  test('completed from a completed mark', () => {
    expect(segStateOf('Spec', [mark('Spec', 'completed', 'T1', 'T2')])).toBe('completed');
  });

  test('failed from a failed or stopped mark', () => {
    expect(segStateOf('Red tests', [mark('Red tests', 'failed', 'T1', 'T2')])).toBe('failed');
    expect(segStateOf('Review', [mark('Review', 'stopped', 'T1', 'T2')])).toBe('failed');
  });

  test('paused from a paused mark', () => {
    expect(segStateOf('Implement', [mark('Implement', 'paused', 'T1')])).toBe('paused');
  });

  test('recognises 6/6 Finalise as Finalise', () => {
    expect(segStateOf('Finalise', [mark('6/6 Finalise', 'completed', 'T1', 'T2')])).toBe('completed');
  });
});

describe('segments', () => {
  test('fresh item: every stage is not reached, conditional ones are dashed', () => {
    const segs = segments(undefined);
    expect(segs).toHaveLength(8);
    for (const seg of segs) {
      expect(seg.state).toBe('not reached');
      expect(seg.dashed).toBe(CONDITIONAL_STAGES.has(seg.name));
    }
  });

  test('running Implement: Spec/Plan/Red done, Implement running, the rest not reached', () => {
    const segs = segments([
      mark('Spec', 'completed', 'T1', 'T2'),
      mark('Plan', 'completed', 'T3', 'T4'),
      mark('Red tests', 'completed', 'T5', 'T6'),
      mark('Implement', 'started', 'T7'),
    ]);
    expect(segs.map(s => s.state)).toEqual([
      'completed', 'completed', 'completed', 'running', 'not reached', 'not reached', 'not reached', 'not reached',
    ]);
    // Test repair and Resolve conflicts are conditional + not reached → dashed.
    const testRepair = segs.find(s => s.name === 'Test repair')!;
    expect(testRepair.dashed).toBe(true);
    const resolveConflicts = segs.find(s => s.name === 'Resolve conflicts')!;
    expect(resolveConflicts.dashed).toBe(true);
    // Non-conditional not-reached segments are not dashed.
    expect(segs.find(s => s.name === 'Review')!.dashed).toBe(false);
  });

  test('failed Review: earlier stages completed, Review failed', () => {
    const segs = segments([
      mark('Spec', 'completed', 'T1', 'T2'),
      mark('Plan', 'completed', 'T3', 'T4'),
      mark('Red tests', 'completed', 'T5', 'T6'),
      mark('Implement', 'completed', 'T7', 'T8'),
      mark('Review', 'failed', 'T9', 'T10'),
    ]);
    expect(segs.map(s => s.state)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'not reached', 'failed', 'not reached', 'not reached',
    ]);
    expect(segs.find(s => s.name === 'Review')!.dashed).toBe(false);
    expect(segs.find(s => s.name === 'Test repair')!.dashed).toBe(true);
  });

  test('done run that ran Test repair', () => {
    const segs = segments([
      mark('Spec', 'completed', 'T1', 'T2'),
      mark('Plan', 'completed', 'T3', 'T4'),
      mark('Red tests', 'completed', 'T5', 'T6'),
      mark('Implement', 'completed', 'T7', 'T8'),
      mark('Test repair', 'completed', 'T9', 'T10'),
      mark('Review', 'completed', 'T11', 'T12'),
      mark('Finalise', 'completed', 'T13', 'T14'),
    ]);
    expect(segs.map(s => s.state)).toEqual([
      'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'not reached',
    ]);
    // Test repair ran → not dashed.
    expect(segs.find(s => s.name === 'Test repair')!.dashed).toBe(false);
    // Resolve conflicts did not run → dashed.
    expect(segs.find(s => s.name === 'Resolve conflicts')!.dashed).toBe(true);
  });

  test('done run without Test repair: dashed for both conditional stages', () => {
    const segs = segments([
      mark('Spec', 'completed', 'T1', 'T2'),
      mark('Plan', 'completed', 'T3', 'T4'),
      mark('Red tests', 'completed', 'T5', 'T6'),
      mark('Implement', 'completed', 'T7', 'T8'),
      mark('Review', 'completed', 'T11', 'T12'),
      mark('Finalise', 'completed', 'T13', 'T14'),
    ]);
    expect(segs.find(s => s.name === 'Test repair')!.dashed).toBe(true);
    expect(segs.find(s => s.name === 'Resolve conflicts')!.dashed).toBe(true);
    expect(segs.find(s => s.name === 'Test repair')!.state).toBe('not reached');
  });
});

describe('segmentLabel', () => {
  test('not reached → just the stage name', () => {
    expect(segmentLabel({ name: 'Spec', state: 'not reached', dashed: false })).toBe('Spec');
  });

  test('running → "Implement · running"', () => {
    expect(segmentLabel({ name: 'Implement', state: 'running', dashed: false })).toBe('Implement · running');
  });

  test('completed → "Spec · done"', () => {
    expect(segmentLabel({ name: 'Spec', state: 'completed', dashed: false })).toBe('Spec · done');
  });

  test('failed → "Review · failed"', () => {
    expect(segmentLabel({ name: 'Review', state: 'failed', dashed: false })).toBe('Review · failed');
  });

  test('paused → "Implement · paused"', () => {
    expect(segmentLabel({ name: 'Implement', state: 'paused', dashed: false })).toBe('Implement · paused');
  });
});

describe('boardStageText', () => {
  test('done run', () => {
    expect(boardStageText({ state: 'done', stage: 'Finalise' })).toBe('All stages done');
  });

  test('not started', () => {
    expect(boardStageText({ state: 'not started', stage: '' })).toBe('Not started');
  });

  test('running Implement from the timeline', () => {
    expect(boardStageText({
      state: 'running',
      stage: 'Implement',
      stages: [
        mark('Spec', 'completed', 'T1', 'T2'),
        mark('Plan', 'completed', 'T3', 'T4'),
        mark('Red tests', 'completed', 'T5', 'T6'),
        mark('Implement', 'started', 'T7'),
      ],
    })).toBe('Implement · running');
  });

  test('failed at Red tests', () => {
    expect(boardStageText({
      state: 'failed',
      stage: 'Red tests',
      stages: [
        mark('Spec', 'completed', 'T1', 'T2'),
        mark('Plan', 'completed', 'T3', 'T4'),
        mark('Red tests', 'failed', 'T5', 'T6'),
      ],
    })).toBe('Failed at Red tests');
  });

  test('paused before Review', () => {
    expect(boardStageText({
      state: 'paused',
      stage: 'Review',
      stages: [
        mark('Spec', 'completed', 'T1', 'T2'),
        mark('Plan', 'completed', 'T3', 'T4'),
        mark('Red tests', 'completed', 'T5', 'T6'),
        mark('Implement', 'completed', 'T7', 'T8'),
        mark('Review', 'paused', 'T9'),
      ],
    })).toBe('Paused before Review');
  });

  test('falls back to status.json stage when the timeline has no active mark', () => {
    expect(boardStageText({
      state: 'running',
      stage: 'Plan',
      stages: [mark('Spec', 'completed', 'T1', 'T2')],
    })).toBe('Plan · running');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-11-28T12:00:00Z');

  test('null → dash with empty title', () => {
    expect(relativeTime(null, now)).toEqual({ text: '—', title: '' });
  });

  test('invalid → dash with the raw string as title', () => {
    expect(relativeTime('not-a-time', now)).toEqual({ text: '—', title: 'not-a-time' });
  });

  test('less than 30 s → "now"', () => {
    const r = relativeTime('2026-11-28T11:59:45Z', now);
    expect(r.text).toBe('now');
    expect(r.title).toBeTruthy();
  });

  test('under a minute → seconds', () => {
    expect(relativeTime('2026-11-28T11:59:15Z', now).text).toBe('45s');
  });

  test('under an hour → minutes', () => {
    expect(relativeTime('2026-11-28T11:45:00Z', now).text).toBe('15m');
  });

  test('under a day → hours', () => {
    expect(relativeTime('2026-11-28T09:00:00Z', now).text).toBe('3h');
  });

  test('more than a day → days', () => {
    expect(relativeTime('2026-11-25T12:00:00Z', now).text).toBe('3d');
  });

  test('title is an absolute time for a valid ISO', () => {
    const r = relativeTime('2026-11-28T09:00:00Z', now);
    expect(r.title).toMatch(/Nov/);
  });
});
