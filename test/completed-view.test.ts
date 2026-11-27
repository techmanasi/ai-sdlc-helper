import { describe, expect, test } from 'vitest';
import { completedStageView, filterCompletedTasks, type CompletedStageMark } from '../web/ui/src/completedView.js';

const tasks = [
  { slug: 'add-search', title: 'Add Search', branch: 'sdlc/add-search', extra: 1 },
  { slug: 'fix-upload', title: 'Retry failed uploads', branch: 'bugfix/large-files', extra: 2 },
  { slug: 'docs', title: 'Document the pipeline', branch: 'sdlc/docs', extra: 3 },
];

const done = (stage: string): CompletedStageMark => ({ stage, status: 'completed' });
const regularStages = ['Spec', 'Plan', 'Red tests', 'Implement', 'Review', 'Finalise'].map(done);

describe('filterCompletedTasks', () => {
  test('matches the title, slug and branch live, without regard to case or surrounding space', () => {
    expect(filterCompletedTasks(tasks, '  SEARCH ').map(t => t.slug)).toEqual(['add-search']);
    expect(filterCompletedTasks(tasks, 'FAILED').map(t => t.slug)).toEqual(['fix-upload']);
    expect(filterCompletedTasks(tasks, 'LARGE-FILES').map(t => t.slug)).toEqual(['fix-upload']);
    expect(filterCompletedTasks(tasks, 'nothing matches this')).toEqual([]);
  });

  test('an empty query keeps every row and its original data', () => {
    expect(filterCompletedTasks(tasks, '   ')).toEqual(tasks);
    expect(filterCompletedTasks(tasks, 'search')[0].extra).toBe(1);
  });
});

describe('completedStageView', () => {
  test('shows no bar when the completed item has no recorded stages', () => {
    expect(completedStageView(undefined)).toBeNull();
    expect(completedStageView([])).toBeNull();
    expect(completedStageView([done('Unknown stage')])).toBeNull();
  });

  test('marks missing regular stages as no record and missing conditional stages not needed', () => {
    const view = completedStageView([done('Spec'), done('Review')]);
    expect(view?.segments).toEqual([
      { stage: 'Spec', state: 'done', label: 'Spec: done' },
      { stage: 'Plan', state: 'no-record', label: 'Plan: no record' },
      { stage: 'Red tests', state: 'no-record', label: 'Red tests: no record' },
      { stage: 'Implement', state: 'no-record', label: 'Implement: no record' },
      { stage: 'Test repair', state: 'not-needed', label: 'Test repair: not needed' },
      { stage: 'Review', state: 'done', label: 'Review: done' },
      { stage: 'Finalise', state: 'no-record', label: 'Finalise: no record' },
      { stage: 'Resolve conflicts', state: 'not-needed', label: 'Resolve conflicts: not needed' },
    ]);
    expect(view?.note).toBe('2 stages');
  });

  test('counts recorded stages and names conditional stages that ran', () => {
    expect(completedStageView(regularStages)?.note).toBe('6 stages');
    expect(completedStageView([...regularStages.slice(0, 4), done('Test repair'), ...regularStages.slice(4)])?.note)
      .toBe('7 stages · Test repair ran');
    const all = completedStageView([
      done('Spec'), done('Plan'), done('Red tests'), done('Implement'), done('Test repair'), done('Review'), done('Finalise'), done('Resolve conflicts'),
    ]);
    expect(all?.note).toBe('8 stages · Test repair ran · Resolve conflicts ran');
    expect(all?.segments.every(segment => segment.state === 'done')).toBe(true);
  });

  test('uses singular stage wording and does not call an unfinished recorded stage done', () => {
    expect(completedStageView([done('Spec')])?.note).toBe('1 stage');
    expect(completedStageView([{ stage: 'Spec', status: 'failed' }])).toBeNull();
    expect(completedStageView([done('Spec'), { stage: 'Finalise', status: 'stopped' }])).toBeNull();
  });
});
