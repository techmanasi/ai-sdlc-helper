import { describe, expect, test } from 'vitest';
import { awaitsMerge, linkPaths, resolveShown, showTestIssues, testRepairStarted } from '../web/ui/src/stages.js';

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
