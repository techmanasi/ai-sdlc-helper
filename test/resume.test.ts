import { describe, expect, test } from 'vitest';
import { defaultPick, needsResumeConfirm, resumeCommand, resumeOptions } from '../web/ui/src/resume.js';

const by = (o: ReturnType<typeof resumeOptions>) => Object.fromEntries(o.map(x => [x.key, x]));

describe('resumeOptions', () => {
  test('with the red-tests commit, Spec, Plan and Red tests stay enabled with a note about keeping existing red tests', () => {
    const o = by(resumeOptions({ redCommit: '1c3b784', hasTestIssues: false, resumeFrom: 'implement' }));
    expect(o.spec).toMatchObject({ enabled: true, note: expect.stringContaining('1c3b784') });
    expect(o.plan).toMatchObject({ enabled: true, note: expect.stringContaining('1c3b784') });
    expect(o['red-tests']).toMatchObject({ enabled: true, note: expect.stringContaining('1c3b784') });
    expect(o.implement).toMatchObject({ enabled: true, suggested: true });
    expect(o.review.enabled).toBe(true);
    expect(o.finalise.enabled).toBe(true);
  });
  test('Test repair needs test-issues.md', () => {
    expect(by(resumeOptions({ redCommit: 'abc', hasTestIssues: false, resumeFrom: '' }))['test-repair']).toMatchObject({ enabled: false, note: 'needs test-issues.md' });
    expect(by(resumeOptions({ redCommit: 'abc', hasTestIssues: true, resumeFrom: 'test-repair' }))['test-repair']).toMatchObject({ enabled: true, suggested: true });
  });
  test('without the red-tests commit only Spec, Plan and Red tests work', () => {
    const on = resumeOptions({ redCommit: '', hasTestIssues: false, resumeFrom: 'plan' }).filter(x => x.enabled).map(x => x.key);
    expect(on).toEqual(['spec', 'plan', 'red-tests']);
  });
  test('needsResumeConfirm is true only for stages at or before Red tests', () => {
    for (const k of ['spec', 'plan', 'red-tests']) expect(needsResumeConfirm(k)).toBe(true);
    for (const k of ['implement', 'test-repair', 'review', 'finalise', 'resolve-conflicts']) expect(needsResumeConfirm(k)).toBe(false);
  });
});

describe('defaultPick / resumeCommand', () => {
  test('preselects the suggested stage when it works, else Implement (when redCommit exists) or Plan', () => {
    expect(defaultPick(resumeOptions({ redCommit: 'abc', hasTestIssues: false, resumeFrom: 'implement' }))).toBe('implement');
    expect(defaultPick(resumeOptions({ redCommit: 'abc', hasTestIssues: false, resumeFrom: 'red-tests' }))).toBe('red-tests');
    expect(defaultPick(resumeOptions({ redCommit: 'abc', hasTestIssues: false, resumeFrom: '' }))).toBe('implement');
    expect(defaultPick(resumeOptions({ redCommit: '', hasTestIssues: false, resumeFrom: '' }))).toBe('plan');
  });
  test('names the slug and the stage', () => { expect(resumeCommand('x', 'review')).toBe('start x --from review'); });
});
