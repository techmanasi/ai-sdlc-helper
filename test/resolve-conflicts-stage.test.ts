// The Resolve conflicts stage inside a pipeline run (FROM=resolve-conflicts): the agent only on a code conflict, a doubt
// pauses the run with the follow-up offer, and only a yes adds <slug>-resolve-conflict-N to the backlog.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { answerQuestions } from '../src/runs/view.js';
import { DOCS, LOG, SLUG, fixture, git, pipeline, read, statusOf, type Fixture } from './pipeline-fixture.js';
import { tmp, write } from './helpers.js';

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

    const r = await pipeline(f, {}, { from: 'resolve-conflicts' });
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
