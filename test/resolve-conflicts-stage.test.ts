// The Resolve conflicts stage inside a pipeline run (FROM=resolve-conflicts): the agent only on a code conflict, a doubt
// pauses the run with the follow-up offer, and only a yes adds <slug>-resolve-conflict-N to the backlog.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { Status } from '../src/pipeline/status.js';
import { answerQuestions } from '../src/runs/view.js';
import { DOCS, LOG, SLUG, fixture, git, pipeline, read, statusOf, type Fixture } from './pipeline-fixture.js';
import { tmp, write } from './helpers.js';

// Each run is a chain of synchronous git and test runs: many seconds, and far more on a loaded machine (the full suite).
vi.setConfig({ testTimeout: 300_000 });

const BRANCH = `feature/${SLUG}`;
const ONE = 'export const one = () => 1;\n';

/** The fixture on its branch with a red-tests commit and a task change to src/existing.mjs, pushed to a bare origin; main then changes the same line. */
function conflicted(f: Fixture): { remote: string } {
  const remote = path.join(tmp('sdlc-rcs-'), 'origin.git');
  git(f.dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(f.dir, 'remote', 'add', 'origin', remote);
  git(f.dir, 'push', '-q', 'origin', 'main');
  git(f.dir, 'checkout', '-q', '-b', BRANCH);
  write(f.dir, `${DOCS}/specs-1.md`, 'spec\n');
  write(f.dir, `${DOCS}/plan-1.md`, 'plan\n');
  git(f.dir, 'add', '-A');
  git(f.dir, 'commit', '-q', '-m', `test(${SLUG}): add failing tests and spec/plan docs`);
  write(f.dir, 'src/existing.mjs', ONE.replace('1;', '1; // the task'));
  git(f.dir, 'commit', '-q', '-am', `feat(${SLUG}): implement per ${DOCS}/specs-1.md`);
  git(f.dir, 'push', '-q', '-u', 'origin', BRANCH);
  const other = path.join(path.dirname(remote), 'other');
  git(path.dirname(remote), 'clone', '-q', remote, other);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(other, 'config', k, v);
  write(other, 'src/existing.mjs', ONE.replace('1;', '1; // merged work'));
  git(other, 'commit', '-q', '-am', 'feat(other): other work (#9)');
  git(other, 'push', '-q', 'origin', 'main');
  return { remote };
}

describe('Resolve conflicts stage', () => {
  test('a doubt pauses without pushing and offers the follow-up item; a yes adds it, numbered', async () => {
    const f = fixture({ other: `printf 'VERDICT: DOUBT\\nDOUBT: one() is commented two ways\\n' > "$FAKE_LOG/resolve-conflicts-report.md"` });
    const { remote } = conflicted(f);
    const before = git(remote, 'rev-parse', BRANCH);
    const head = git(f.dir, 'rev-parse', 'HEAD');
    // Another follow-up already exists in the backlog: the next one is -2.
    fs.mkdirSync(path.join(f.dir, 'work/items', `${SLUG}-resolve-conflict-1`), { recursive: true });

    const r = await pipeline(f, { SDLC_RESOLVE_REVIEW: '0' }, { from: 'resolve-conflicts' });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual(['other']);
    expect(statusOf(f.dir)).toMatchObject({ state: 'paused', stage: 'Resolve conflicts' });
    expect(git(remote, 'rev-parse', BRANCH)).toBe(before);
    expect(git(f.dir, 'rev-parse', 'HEAD')).toBe(head);
    const q = read(f.dir, `${DOCS}/questions.md`);
    expect(q).toContain(`${SLUG}-resolve-conflict-2`);
    expect(read(f.dir, `${LOG}/resolve-conflict-followup.md`)).toContain('src/existing.mjs');
    expect(read(f.dir, 'work/items/index.md')).not.toContain('resolve-conflict');

    // The suggestion (what auto-accept takes) adds nothing; only a yes does.
    answerQuestions(path.join(f.dir, DOCS, 'questions.md'), { 1: 'yes' });
    const r2 = await pipeline(f, {}, { from: 'resolve-conflicts' });
    expect(r2.status).toBe(0);
    expect(r2.calls).toEqual([]);
    expect(read(f.dir, 'work/items/index.md')).toContain(`- [ ] \`${SLUG}-resolve-conflict-2\``);
    const brief = read(f.dir, `work/items/${SLUG}-resolve-conflict-2/brief.md`);
    expect(brief).toContain('src/existing.mjs');
    expect(brief).toContain('one() is commented two ways');
    expect(brief).toContain('feat(other): other work (#9)');
    expect(fs.existsSync(path.join(f.dir, DOCS, 'questions.md'))).toBe(false);
    expect(git(remote, 'rev-parse', BRANCH)).toBe(before);
  });

  test('answering no says again what the last attempt found, that nothing changed, and how to retry; the run is paused, not failed', async () => {
    const f = fixture({ other: `printf 'VERDICT: DOUBT\\nDOUBT: one() is commented two ways\\n' > "$FAKE_LOG/resolve-conflicts-report.md"` });
    const { remote } = conflicted(f);
    const before = git(remote, 'rev-parse', BRANCH);
    const first = await pipeline(f, { SDLC_RESOLVE_REVIEW: '0' }, { from: 'resolve-conflicts' });
    expect(first.stdout).toContain('What happened: the agent was not sure how to combine the changes in src/existing.mjs: one() is commented two ways. Nothing was pushed.');

    answerQuestions(path.join(f.dir, DOCS, 'questions.md'), { 1: 'no' });
    const r = await pipeline(f, {}, { from: 'resolve-conflicts' });
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
    expect(statusOf(f.dir)).toMatchObject({ state: 'paused', stage: 'Resolve conflicts' });
    expect(r.stdout).toContain('What happened: the agent was not sure how to combine');
    expect(r.stdout).toContain('You answered no, so no follow-up task was added. Your pull request and branch are unchanged. Press Resolve conflicts to try again');
    expect(r.stdout).toContain('What happened: the agent was not sure');
    expect(git(remote, 'rev-parse', BRANCH)).toBe(before);
  });

  describe('a doubt goes to independent reviewers (three by default)', () => {
    const RESOLVE = `printf 'export const one = () => 1; // merged work, and the task\\n' > src/existing.mjs
printf 'FILE: src/existing.mjs :: kept both comments\\nVERDICT: DOUBT\\nDOUBT: one() is commented two ways\\n' > "$FAKE_LOG/resolve-conflicts-report.md"`;

    test('all three safe: the doubt is overridden, the check runs and the branch is pushed; the judge is not needed', async () => {
      const f = fixture({ other: RESOLVE });
      const { remote } = conflicted(f);
      write(f.fake, 'resolve-review.out', 'The comments do not conflict.\nVERDICT: SAFE\n');
      const r = await pipeline(f, {}, { from: 'resolve-conflicts' });
      expect(r.status).toBe(0);
      expect(r.calls).toEqual(['other', 'resolve-review', 'resolve-review', 'resolve-review']);
      expect(r.stdout).toContain('all 3 reviewers found it safe: the doubt is overridden');
      expect(git(remote, 'rev-parse', BRANCH)).toBe(git(f.dir, 'rev-parse', 'HEAD'));
      expect(git(remote, 'show', `${BRANCH}:src/existing.mjs`)).toContain('merged work, and the task');
      expect(read(f.dir, `${LOG}/resolve-conflicts.md`)).toContain('all 3 independent reviewers found it safe');
      expect(read(f.dir, `${LOG}/resolve-review.md`)).toContain('3 of 3 reviewers found it safe');
    });

    test('the review step tells how far the panel is, and names the judge only when the reviewers disagree', async () => {
      const seen: string[] = [];
      const orig = Status.prototype.beginStep;
      vi.spyOn(Status.prototype, 'beginStep').mockImplementation(function (this: Status, key: string, detail = '') { if (key === 'review') seen.push(detail); orig.call(this, key, detail); });
      const f = fixture({ other: RESOLVE });
      conflicted(f);
      write(f.fake, 'resolve-review.out', 'The comments do not conflict.\nVERDICT: SAFE\n');
      await pipeline(f, {}, { from: 'resolve-conflicts' });
      expect(seen).toEqual(['Panel check in progress', '3/3 reviewers started', '1/3 reviewers finished', '2/3 reviewers finished', '3/3 reviewers finished']);
      seen.length = 0;
      const g = fixture({ other: RESOLVE });
      conflicted(g);
      write(g.fake, 'resolve-review.out', 'No.\nVERDICT: UNSAFE\n');
      write(g.fake, 'resolve-judge.out', 'Contradiction.\n');
      await pipeline(g, {}, { from: 'resolve-conflicts' });
      expect(seen.slice(-2)).toEqual(['Started verdict reviewer', 'Verdict finished']);
      vi.restoreAllMocks();
    });

    test('a reviewer that does not say SAFE keeps the doubt: the judge writes the conclusion, nothing is pushed, and the follow-up question carries the opinions', async () => {
      const f = fixture({ other: RESOLVE });
      const { remote } = conflicted(f);
      const before = git(remote, 'rev-parse', BRANCH);
      write(f.fake, 'resolve-review.out', 'The two comments contradict.\nVERDICT: UNSAFE\n');
      write(f.fake, 'resolve-judge.out', 'The reviewers agree the comments contradict.\n');
      const r = await pipeline(f, {}, { from: 'resolve-conflicts' });
      expect(r.status).toBe(2);
      expect(r.calls).toEqual(['other', 'resolve-review', 'resolve-review', 'resolve-review', 'resolve-judge']);
      expect(r.stdout).toContain('0 of 3 reviewers found it safe: the doubt stays');
      expect(git(remote, 'rev-parse', BRANCH)).toBe(before);
      const review = read(f.dir, `${LOG}/resolve-review.md`);
      expect(review).toContain('The reviewers agree the comments contradict.');
      expect(review).toContain('The two comments contradict.');
      expect(read(f.dir, `${LOG}/resolve-conflict-followup.md`)).toContain('Independent review: 0 of 3 reviewers found it safe. The reviewers agree the comments contradict.');
    });

    test('the number of reviewers is the user\'s: 2 reviewers, both safe, override the doubt; 0 asks the developer', async () => {
      const f = fixture({ other: RESOLVE });
      conflicted(f);
      write(f.fake, 'resolve-review.out', 'VERDICT: SAFE\n');
      const two = await pipeline(f, { SDLC_RESOLVE_REVIEWERS: '2' }, { from: 'resolve-conflicts' });
      expect(two.status).toBe(0);
      expect(two.calls).toEqual(['other', 'resolve-review', 'resolve-review']);
      expect(two.stdout).toContain('2 independent reviewers judge the resolution');
      expect(read(f.dir, `${LOG}/resolve-review.md`)).toContain('2 of 2 reviewers found it safe');

      const g = fixture({ other: RESOLVE });
      conflicted(g);
      const none = await pipeline(g, { SDLC_RESOLVE_REVIEWERS: '0' }, { from: 'resolve-conflicts' });
      expect(none.status).toBe(2);
      expect(none.calls).toEqual(['other']);
    });

    test('reviewers that share a model are not asked: the doubt stays and the report says which ones', async () => {
      const f = fixture({ other: RESOLVE });
      const { remote } = conflicted(f);
      const before = git(remote, 'rev-parse', BRANCH);
      write(f.fake, 'resolve-review.out', 'VERDICT: SAFE\n');
      // reviewers 1 and 2 on the same model
      const r = await pipeline(f, { SDLC_RESOLVE_REVIEWERS: '2', MODEL_RESOLVE_REVIEW_2: 'opus' }, { from: 'resolve-conflicts' });
      expect(r.status).toBe(2);
      expect(r.calls).toEqual(['other']);
      expect(r.stdout).toContain('WARNING: reviewers 1 and 2 use the same model (claude:opus)');
      expect(r.stdout).toContain('Independent review was not run: reviewers 1 and 2 use the same model (claude:opus)');
      expect(git(remote, 'rev-parse', BRANCH)).toBe(before);
      expect(read(f.dir, `${LOG}/resolve-review.md`)).toContain('reviewers 1 and 2 use the same model');
    });

    test('SDLC_RESOLVE_REVIEW=0 leaves the doubt to the developer without asking the reviewers', async () => {
      const f = fixture({ other: RESOLVE });
      conflicted(f);
      const r = await pipeline(f, { SDLC_RESOLVE_REVIEW: '0' }, { from: 'resolve-conflicts' });
      expect(r.status).toBe(2);
      expect(r.calls).toEqual(['other']);
    });
  });

  test('a safe resolution passes the full check and is pushed with the lease; the tests commit is found again after the rebase', async () => {
    const f = fixture({
      other: `printf 'export const one = () => 1; // merged work, and the task\\n' > src/existing.mjs
printf 'FILE: src/existing.mjs :: kept both comments\\nVERDICT: SAFE\\n' > "$FAKE_LOG/resolve-conflicts-report.md"`,
    });
    const { remote } = conflicted(f);
    const oldRed = git(f.dir, 'rev-parse', 'HEAD~1');
    const r = await pipeline(f, {}, { from: 'resolve-conflicts' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['other']);
    expect(git(remote, 'rev-parse', BRANCH)).toBe(git(f.dir, 'rev-parse', 'HEAD'));
    expect(git(remote, 'show', `${BRANCH}:src/existing.mjs`)).toContain('merged work, and the task');
    expect(git(f.dir, 'rev-list', '--merges', 'origin/main..HEAD')).toBe('');
    const newRed = git(f.dir, 'log', '--format=%H', '-1', `--grep=^test(${SLUG}): add failing tests`);
    expect(newRed).not.toBe(oldRed);
    expect(r.stdout).toContain(`tests commit is now ${newRed.slice(0, 7)}`);
    expect(read(f.dir, `${LOG}/resolve-conflicts.md`)).toContain('src/existing.mjs (code');
  });

  test('without a remote the stage is skipped and the run stays at Finalise', async () => {
    const f = fixture();
    git(f.dir, 'checkout', '-q', '-b', BRANCH);
    git(f.dir, 'commit', '-q', '--allow-empty', '-m', `test(${SLUG}): add failing tests and spec/plan docs`);
    write(f.dir, `${LOG}/status.json`, `${JSON.stringify({ stage: 'Finalise' })}\n`);
    const r = await pipeline(f, { SDLC_RESOLVE_CONFLICTS: '' }, { from: 'resolve-conflicts' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(statusOf(f.dir)).toMatchObject({ state: 'done', stage: 'Finalise' });
    expect(r.stdout).toContain('Resolve conflicts: Skipped: no origin remote');
    const skipped = await pipeline(f, { SDLC_RESOLVE_CONFLICTS: '0' }, { from: 'resolve-conflicts' });
    expect(skipped.stdout).toContain('Resolve conflicts: skipped (SDLC_RESOLVE_CONFLICTS=0)');
  });
});
