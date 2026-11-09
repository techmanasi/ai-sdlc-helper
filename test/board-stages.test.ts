import { describe, expect, test } from 'vitest';
import { awaitsMerge, resolveShown } from '../web/ui/src/stages.js';

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
