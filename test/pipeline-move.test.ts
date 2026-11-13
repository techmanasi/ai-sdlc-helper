import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DOCS, LOG, SLUG, fixture, git, pipeline, read, statusOf, type Fixture } from './pipeline-fixture.js';
import { write } from './helpers.js';
import { getPrFromBrief } from '../src/pipeline/finalise.js';

afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
vi.setConfig({ testTimeout: 300_000 });

const BRANCH = `feature/${SLUG}`;
const MOVED = `${BRANCH}_2`;
const NEW_PR = 'https://github.com/o/r/pull/99';
const FAILS_AT_IMPLEMENT = { MAX_ATTEMPTS: '1', FAKE_NO_IMPL: '1' };

// createOrGetPr asks gh with the test process's PATH: the stand-in goes first there too.
let savedPath: string | undefined;
beforeEach(() => { savedPath = process.env.PATH; });
afterEach(() => { process.env.PATH = savedPath; });

/** A gh stand-in: installed and signed in, no pull request anywhere, `pr create` logs its arguments and prints NEW_PR. */
function fakeGh(f: Fixture): void {
  fs.writeFileSync(path.join(f.bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then exit 0; fi',
    'if [ "$1 $2" = "auth status" ]; then exit 0; fi',
    `if [ "$1 $2" = "pr create" ]; then echo "$@" >> "${f.fake}/gh-create.log"; echo ${NEW_PR}; exit 0; fi`,
    'exit 1', '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${f.bin}:${savedPath}`;
}

/** A bare origin holding main, and a second clone of it. */
function withOrigin(f: Fixture): { origin: string; other: string } {
  const origin = path.join(path.dirname(f.dir), 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(f.dir, 'remote', 'add', 'origin', origin);
  git(f.dir, 'push', '-q', 'origin', 'main');
  const other = path.join(path.dirname(f.dir), 'other');
  spawnSync('git', ['clone', '-q', origin, other]);
  git(other, 'config', 'user.email', 'o@example.com');
  git(other, 'config', 'user.name', 'O');
  return { origin, other };
}

const commitIn = (dir: string, file: string, text: string, msg: string): string => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
};

/** Origin's run branch holds an earlier run's commit; this checkout has no such branch (a fresh start). */
function earlierRun(other: string): string {
  git(other, 'checkout', '-q', '-b', BRANCH);
  const sha = commitIn(other, 'earlier.txt', 'earlier run\n', `test(${SLUG}): add failing tests and spec/plan docs`);
  git(other, 'push', '-q', 'origin', BRANCH);
  git(other, 'checkout', '-q', 'main');
  return sha;
}

const rows = (dir: string, kind: string) => read(dir, `${LOG}/attempts.jsonl`).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.kind === kind);
const remoteHas = (origin: string, ref: string) => spawnSync('git', ['-C', origin, 'rev-parse', '--verify', '-q', ref]).status === 0;

describe('the push check after Plan', () => {
  test('a pushable branch: no move, Red tests runs, the check records only ok', async () => {
    const f = fixture();
    fakeGh(f);
    withOrigin(f);
    const r = await pipeline(f, FAILS_AT_IMPLEMENT);
    expect(r.calls.slice(0, 3)).toEqual(['spec', 'plan', 'red-tests']);
    expect(r.stdout).toContain(`Push check: ${BRANCH} can be pushed`);
    expect(r.stdout).not.toContain('MOVED:');
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(rows(f.dir, 'push-check')).toMatchObject([{ finding: 'pushable', action: 'none' }]);
    expect(rows(f.dir, 'move')).toEqual([]);
    expect(statusOf(f.dir).moved_from).toBeUndefined();
  });

  for (const mode of ['local', 'ci'] as const) {
    test(`origin's branch holds an earlier run's work (${mode}): a new branch from the base; Red tests pushes it and links its pull request`, async () => {
      const f = fixture();
      fakeGh(f);
      const { origin, other } = withOrigin(f);
      const earlier = earlierRun(other);
      const r = await pipeline(f, { ...FAILS_AT_IMPLEMENT, SDLC_FULL_SUITE: mode });
      expect(r.calls.slice(0, 3)).toEqual(['spec', 'plan', 'red-tests']);
      expect(r.stdout).toContain('MOVED:');
      expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(MOVED);
      // Made from the base: the earlier run's commit is not in it.
      expect(spawnSync('git', ['-C', f.dir, 'merge-base', '--is-ancestor', earlier, 'HEAD']).status).not.toBe(0);
      expect(git(origin, 'rev-parse', BRANCH)).toBe(earlier);
      expect(statusOf(f.dir)).toMatchObject({ branch: MOVED, moved_from: { branch: BRANCH, reason: 'earlier-run' } });
      expect(rows(f.dir, 'push-check')).toMatchObject([{ finding: 'earlier-run', action: 'new-branch-from-base' }]);
      // Red tests pushed the new branch, opened its pull request, and committed and pushed the link.
      const log = git(f.dir, 'log', '--format=%s', 'main..HEAD').split('\n');
      expect(log).toContain(`chore(${SLUG}): link pull request`);
      expect(git(origin, 'rev-parse', MOVED)).toBe(git(f.dir, 'rev-parse', `${MOVED}`));
      expect(getPrFromBrief(git(origin, 'show', `${MOVED}:${DOCS}/brief.md`))).toBe(NEW_PR);
      const created = read(f.fake, 'gh-create.log');
      expect(created).toContain(`--head ${MOVED}`);
      expect(created).toContain(`Replaces branch ${BRANCH}`);
    });
  }

  test('paused after the move, resumed at Plan: no second move', async () => {
    const f = fixture({ 'red-tests': 'true' });
    fakeGh(f);
    const { other } = withOrigin(f);
    earlierRun(other);
    let r = await pipeline(f, FAILS_AT_IMPLEMENT);
    expect(r.stdout).toContain('RED GATE FAILED');
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(MOVED);
    fixtureStage(f, 'red-tests', null);
    r = await pipeline(f, FAILS_AT_IMPLEMENT, { from: 'plan' });
    expect(r.stdout).not.toContain('MOVED:');
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(MOVED);
    expect(git(f.dir, 'branch', '--list', `${BRANCH}_3`)).toBe('');
    expect(rows(f.dir, 'move')).toHaveLength(1);
    expect(statusOf(f.dir)).toMatchObject({ branch: MOVED, moved_from: { branch: BRANCH } });
  });

  test('SDLC_MOVE_BRANCH=0 keeps the branch', async () => {
    const f = fixture();
    fakeGh(f);
    const { other } = withOrigin(f);
    earlierRun(other);
    const r = await pipeline(f, { ...FAILS_AT_IMPLEMENT, SDLC_MOVE_BRANCH: '0' });
    expect(r.stdout).not.toContain('MOVED:');
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
  });

  test('a branch that conflicts with the base: Resolve conflicts runs inline and the run goes on to Red tests', async () => {
    const f = fixture();
    fakeGh(f);
    const { origin, other } = withOrigin(f);
    commitIn(other, 'notes.md', 'a\n', 'notes');
    git(other, 'push', '-q', 'origin', 'main');
    git(f.dir, 'pull', '-q', 'origin', 'main');
    git(f.dir, 'checkout', '-q', '-b', BRANCH);
    commitIn(f.dir, 'notes.md', 'a\nmine\n', 'mine');
    git(f.dir, 'push', '-q', 'origin', BRANCH);
    git(other, 'pull', '-q');
    const base = commitIn(other, 'notes.md', 'a\ntheirs\n', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    const r = await pipeline(f, FAILS_AT_IMPLEMENT);
    expect(r.stdout).toContain('Resolve conflicts runs now');
    expect(r.calls.slice(0, 3)).toEqual(['spec', 'plan', 'red-tests']);
    // The branch on origin now holds the base, and both sides' lines.
    expect(spawnSync('git', ['-C', origin, 'merge-base', '--is-ancestor', base, BRANCH]).status).toBe(0);
    const notes = git(f.dir, 'show', `HEAD:notes.md`);
    expect(notes).toContain('mine');
    expect(notes).toContain('theirs');
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(read(f.dir, `${DOCS}/questions.md`)).toBe('');
  });

  test('a code conflict with the base that is not resolved: the run stops with the caller\'s resume command', async () => {
    const f = fixture();
    fakeGh(f);
    const { origin, other } = withOrigin(f);
    git(f.dir, 'checkout', '-q', '-b', BRANCH);
    commitIn(f.dir, 'src/existing.mjs', 'export const one = () => 1; // mine\n', 'mine');
    git(f.dir, 'push', '-q', 'origin', BRANCH);
    commitIn(other, 'src/existing.mjs', 'export const one = () => 1; // theirs\n', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    const before = git(origin, 'rev-parse', BRANCH);
    const r = await pipeline(f, FAILS_AT_IMPLEMENT);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`ai-sdlc-helper pipeline ${SLUG} --from red-tests`);
    expect(r.stdout).not.toContain('--from resolve-conflicts');
    expect(r.calls).not.toContain('red-tests');
    expect(git(origin, 'rev-parse', BRANCH)).toBe(before);
    // The follow-up question is never asked inline: questions.md belongs to Plan.
    expect(read(f.dir, `${DOCS}/questions.md`)).toBe('');
    expect(read(f.dir, `${LOG}/resolve-conflicts.md`)).not.toBe('');
    expect(statusOf(f.dir).stage).toBe('Plan');
  });

  test('a refused start (the red-tests commit exists) makes no branch, no push and no pull request', async () => {
    const f = fixture();
    fakeGh(f);
    let r = await pipeline(f, FAILS_AT_IMPLEMENT);
    expect(r.status).toBe(1);
    const { origin, other } = withOrigin(f);
    git(f.dir, 'push', '-q', 'origin', BRANCH);
    git(other, 'fetch', '-q');
    git(other, 'checkout', '-q', BRANCH);
    commitIn(other, 'theirs.txt', 'theirs\n', 'theirs');
    git(other, 'push', '-q', 'origin', BRANCH);
    const refs = git(origin, 'for-each-ref');
    const checksBefore = rows(f.dir, 'push-check').length;
    r = await pipeline(f, FAILS_AT_IMPLEMENT, { from: 'plan' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('already exists');
    expect(git(f.dir, 'branch', '--list', `${BRANCH}_*`)).toBe('');
    expect(git(origin, 'for-each-ref')).toBe(refs);
    expect(read(f.fake, 'gh-create.log')).toBe('');
    expect(rows(f.dir, 'push-check')).toHaveLength(checksBefore);
  });

  test('a start at Review does not run the check (local mode)', async () => {
    const f = fixture();
    fakeGh(f);
    await pipeline(f, FAILS_AT_IMPLEMENT);
    const { other } = withOrigin(f);
    git(f.dir, 'push', '-q', 'origin', BRANCH);
    git(other, 'fetch', '-q');
    git(other, 'checkout', '-q', BRANCH);
    commitIn(other, 'theirs.txt', 'theirs\n', 'theirs');
    git(other, 'push', '-q', 'origin', BRANCH);
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.stdout).not.toContain('Push check:');
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(statusOf(f.dir).moved_from).toBeUndefined();
    expect(remoteHas(path.join(path.dirname(f.dir), 'origin.git'), MOVED)).toBe(false);
  });
});

describe('a start at Resolve conflicts', () => {
  test('does not move even when origin is ahead', async () => {
    const f = fixture();
    fakeGh(f);
    await pipeline(f, FAILS_AT_IMPLEMENT);
    const { other } = withOrigin(f);
    git(f.dir, 'push', '-q', 'origin', BRANCH);
    git(other, 'fetch', '-q');
    git(other, 'checkout', '-q', BRANCH);
    commitIn(other, 'theirs.txt', 'theirs\n', 'theirs');
    git(other, 'push', '-q', 'origin', BRANCH);
    await pipeline(f, {}, { from: 'resolve-conflicts' });
    expect(git(f.dir, 'branch', '--list', MOVED)).toBe('');
  });
});

const OLD_PR = 'https://github.com/o/r/pull/5';

/**
 * The run in its own worktree, started from the fixture's checkout (the main checkout): the brief, committed with an older
 * pull request link, is in both, and the run's record names the worktree and where it was started from.
 */
function inWorktree(f: Fixture): Fixture {
  write(f.dir, `${DOCS}/brief.md`, `---\npr: ${OLD_PR}\n---\n\n# ${SLUG}\n\nAdd sum(a, b).\n`);
  git(f.dir, 'commit', '-q', '-am', 'brief with an older pull request');
  git(f.dir, 'push', '-q', 'origin', 'main');
  const wt = path.join(path.dirname(f.dir), 'wt');
  git(f.dir, 'worktree', 'add', '-q', '-b', BRANCH, wt);
  write(path.join(f.dir, '.git', 'sdlc-runs'), `${SLUG}.json`, `${JSON.stringify({ slug: SLUG, worktree: wt, root: f.dir, pid: 0, started: '2026-11-14T10:00:00', interrupted: false, finished: '', message: '' })}\n`);
  return { ...f, dir: wt };
}

describe('a new pull request is linked in the brief of the worktree and of the main checkout', () => {
  test('Red tests opens the pull request in ci mode: both briefs hold the new link, not the older one', async () => {
    const f = fixture();
    fakeGh(f);
    withOrigin(f);
    const wt = inWorktree(f);
    await pipeline(wt, { ...FAILS_AT_IMPLEMENT, SDLC_FULL_SUITE: 'ci' });
    expect(read(f.fake, 'gh-create.log')).toContain(`--head ${BRANCH}`);
    for (const dir of [wt.dir, f.dir]) {
      const brief = read(dir, `${DOCS}/brief.md`);
      expect(getPrFromBrief(brief), dir).toBe(NEW_PR);
      expect(brief, dir).not.toContain(OLD_PR);
    }
  });

  test('a moved run opens its new pull request: the main checkout\'s brief holds the new link, not the older one', async () => {
    const f = fixture();
    fakeGh(f);
    const { other } = withOrigin(f);
    const wt = inWorktree(f);
    // The earlier run started from the main that holds the brief.
    git(other, 'pull', '-q');
    earlierRun(other);
    const r = await pipeline(wt, FAILS_AT_IMPLEMENT);
    expect(r.stdout).toContain('MOVED:');
    expect(git(wt.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(MOVED);
    const main = read(f.dir, `${DOCS}/brief.md`);
    expect(getPrFromBrief(main)).toBe(NEW_PR);
    expect(main).not.toContain(OLD_PR);
    expect(getPrFromBrief(read(wt.dir, `${DOCS}/brief.md`))).toBe(NEW_PR);
  });
});

const ONE = 'export const one = () => 1;\n';
const RESOLVED = 'export const one = () => 1; // merged work, and the task\n';

/**
 * The run's branch holds a task commit to src/existing.mjs that was pushed and then rewritten here with another change of the same
 * line (diverged, the rebase onto origin's branch conflicts: a new branch); origin's main changed that line too (so the task commit
 * conflicts with it).
 */
function conflictingMove(f: Fixture): { origin: string; mine: string; theirs: string } {
  const { origin, other } = withOrigin(f);
  git(f.dir, 'checkout', '-q', '-b', BRANCH);
  const theirs = commitIn(f.dir, 'src/existing.mjs', ONE.replace('1;', '1; // the task, first try'), 'the task');
  git(f.dir, 'push', '-q', 'origin', BRANCH);
  write(f.dir, 'src/existing.mjs', ONE.replace('1;', '1; // the task'));
  git(f.dir, 'commit', '-q', '--amend', '-am', 'the task');
  const mine = git(f.dir, 'rev-parse', 'HEAD');
  commitIn(other, 'src/existing.mjs', ONE.replace('1;', '1; // merged work'), 'merged work');
  git(other, 'push', '-q', 'origin', 'main');
  return { origin, mine, theirs };
}

describe('the new branch is made from origin\'s base, conflicts resolved as Resolve conflicts resolves them', () => {
  test('a conflicting commit that the resolver resolves: the new branch is origin\'s base with the resolved commit, and it is pushed', async () => {
    const f = fixture({ other: `printf '${RESOLVED.trim()}\\n' > src/existing.mjs
printf 'FILE: src/existing.mjs :: kept both comments\\nVERDICT: SAFE\\n' > "$FAKE_LOG/resolve-conflicts-report.md"` });
    fakeGh(f);
    const { origin, theirs } = conflictingMove(f);
    const r = await pipeline(f, FAILS_AT_IMPLEMENT);
    expect(r.calls.slice(0, 4)).toEqual(['spec', 'plan', 'other', 'red-tests']);
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(MOVED);
    expect(rows(f.dir, 'push-check')).toMatchObject([{ finding: 'diverged', action: 'new-branch-from-base' }]);
    expect(r.stdout).toContain('conflicts resolved in src/existing.mjs');
    // From origin's main, in a straight line, with the resolved change; pushed with its pull request.
    expect(spawnSync('git', ['-C', origin, 'merge-base', '--is-ancestor', 'main', MOVED]).status).toBe(0);
    expect(git(origin, 'rev-list', '--merges', `main..${MOVED}`)).toBe('');
    expect(git(origin, 'show', `${MOVED}:src/existing.mjs`)).toBe(RESOLVED.trim());
    expect(git(origin, 'log', '--format=%s', `main..${MOVED}`).split('\n')).toContain('the task');
    expect(read(f.fake, 'gh-create.log')).toContain(`--head ${MOVED}`);
    // The old branch, on origin, as it was.
    expect(git(origin, 'rev-parse', BRANCH)).toBe(theirs);
  });

  test('the resolver doubts and the panel finds it unsafe: the run stops, nothing is pushed, the old branch is checked out again and no new branch is left', async () => {
    const f = fixture({ other: `printf '${RESOLVED.trim()}\\n' > src/existing.mjs
printf 'FILE: src/existing.mjs :: kept both comments\\nVERDICT: DOUBT\\nDOUBT: one() is commented two ways\\n' > "$FAKE_LOG/resolve-conflicts-report.md"` });
    fakeGh(f);
    write(f.fake, 'resolve-review.out', 'The two comments contradict.\nVERDICT: UNSAFE\n');
    write(f.fake, 'resolve-judge.out', 'The reviewers agree the comments contradict.\n');
    const { origin, mine, theirs } = conflictingMove(f);
    const refs = git(origin, 'for-each-ref');
    const r = await pipeline(f, FAILS_AT_IMPLEMENT);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(['spec', 'plan', 'other', 'resolve-review', 'resolve-review', 'resolve-review', 'resolve-judge']);
    expect(git(origin, 'for-each-ref')).toBe(refs);
    expect(git(origin, 'rev-parse', BRANCH)).toBe(theirs);
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(git(f.dir, 'rev-parse', 'HEAD')).toBe(mine);
    expect(git(f.dir, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(git(f.dir, 'branch', '--list', `${BRANCH}_*`)).toBe('');
    expect(git(f.dir, 'rev-parse', `refs/sdlc-backup/${BRANCH}/local`)).toBe(mine);
    expect(fs.existsSync(path.join(f.dir, '.git', 'rebase-merge'))).toBe(false);
    // Plan's work is still there.
    expect(read(f.dir, `${DOCS}/plan-1.md`)).toBe('plan\n');
    expect(r.stdout).toContain(`Nothing was pushed; ${BRANCH} is checked out again, unchanged (refs/sdlc-backup/${BRANCH}/local is ${mine.slice(0, 7)})`);
    expect(r.stdout).toContain(`ai-sdlc-helper pipeline ${SLUG} --from red-tests`);
    expect(read(f.dir, `${LOG}/errors.log`)).toContain('one() is commented two ways');
    expect(rows(f.dir, 'push-check').map(x => x.action)).toEqual(['new-branch-stopped']);
    expect(rows(f.dir, 'move')).toEqual([]);
    expect(statusOf(f.dir).moved_from).toBeUndefined();
  });
});

/** Rewrites (or with null, restores the default of) one stage's stand-in script. */
function fixtureStage(f: Fixture, stage: string, script: string | null): void {
  const file = path.join(f.fake, `${stage}.sh`);
  if (script === null) {
    const fresh = fixture();
    fs.copyFileSync(path.join(fresh.fake, `${stage}.sh`), file);
  } else fs.writeFileSync(file, `set -e\n${script}\n`);
}
