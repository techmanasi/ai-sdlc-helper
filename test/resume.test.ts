import { describe, expect, test } from 'vitest';
import { defaultPick, resumeCommand, resumeOptions } from '../web/ui/src/resume.js';

const by = (o: ReturnType<typeof resumeOptions>) => Object.fromEntries(o.map(x => [x.key, x]));

describe('resumeOptions', () => {
  test('with the red-tests commit, Plan and Red tests are off with the reason, Spec points to Restart', () => {
    const o = by(resumeOptions({ redCommit: '1c3b784', hasTestIssues: false, resumeFrom: 'implement' }));
    expect(o.plan).toMatchObject({ enabled: false, note: expect.stringContaining('1c3b784') });
    expect(o['red-tests'].enabled).toBe(false);
    expect(o.spec).toMatchObject({ enabled: false, note: expect.stringContaining('Restart') });
    expect(o.implement).toMatchObject({ enabled: true, suggested: true });
    expect(o.review.enabled).toBe(true);
    expect(o.finalise.enabled).toBe(true);
  });
  test('Test repair needs test-issues.md', () => {
    expect(by(resumeOptions({ redCommit: 'abc', hasTestIssues: false, resumeFrom: '' }))['test-repair']).toMatchObject({ enabled: false, note: 'needs test-issues.md' });
    expect(by(resumeOptions({ redCommit: 'abc', hasTestIssues: true, resumeFrom: 'test-repair' }))['test-repair']).toMatchObject({ enabled: true, suggested: true });
  });
  test('without the red-tests commit only Plan and Red tests work', () => {
    const on = resumeOptions({ redCommit: '', hasTestIssues: false, resumeFrom: 'plan' }).filter(x => x.enabled).map(x => x.key);
    expect(on).toEqual(['plan', 'red-tests']);
  });
});

describe('defaultPick / resumeCommand', () => {
  test('preselects the suggested stage when it works, else the first that does', () => {
    expect(defaultPick(resumeOptions({ redCommit: 'abc', hasTestIssues: false, resumeFrom: 'implement' }))).toBe('implement');
    expect(defaultPick(resumeOptions({ redCommit: 'abc', hasTestIssues: false, resumeFrom: 'red-tests' }))).toBe('implement');
    expect(defaultPick(resumeOptions({ redCommit: '', hasTestIssues: false, resumeFrom: '' }))).toBe('plan');
  });
  test('names the slug and the stage', () => { expect(resumeCommand('x', 'review')).toBe('start x --from review'); });
});
