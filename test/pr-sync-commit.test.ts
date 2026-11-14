import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { clearPrCache } from '../src/pipeline/finalise.js';
import { runContext } from '../src/runs/index.js';
import { getCompletedTaskDetail } from '../src/runs/completed.js';
import { syncPr } from '../src/runs/prsync.js';
import { runView } from '../src/runs/view.js';
import { tmp, write } from './helpers.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const tryGit = (cwd: string, ...args: string[]): string | null => { try { return git(cwd, ...args); } catch { return null; } };

const SLUG = 'add-tokens';
const BRANCH = `sdlc/${SLUG}`;
const DOCS = `Docs/backlog/${SLUG}`;
const check = (name: string, conclusion: string) => ({ name, status: 'COMPLETED', conclusion, detailsUrl: 'https://github.com/o/r/actions/runs/777/job/1' });

let base: string;
let root: string;
let wt: string;
let origin: string;
let env: NodeJS.ProcessEnv;

/** A gh that answers `pr view` with out.json and `run view` with a failing CI log. */
function gh(o: { state?: string; ci?: string; comment?: string } = {}): void {
  const comments = [{ body: o.comment || 'please rename', author: { login: 'rev' }, createdAt: '2026-11-09T10:00:00Z' }];
  fs.writeFileSync(path.join(base, 'out.json'), JSON.stringify({ url: 'https://github.com/o/r/pull/91', state: o.state || 'OPEN', number: 91, statusCheckRollup: [check('check (18)', o.ci || 'SUCCESS')], comments, reviews: [] }));
  fs.writeFileSync(path.join(base, 'ci.log'), 'check (18)\tRun npm run lint\t2026-11-09T21:34:53.5Z ##[error]Process completed with exit code 1.\n');
  fs.mkdirSync(path.join(base, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'bin', 'gh'), `#!/bin/sh
if [ "$1" = "run" ]; then cat "${base}/ci.log"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat "${base}/out.json"; exit 0; fi
exit 1
`, { mode: 0o755 });
  clearPrCache();
}

const record = (extra: Record<string, unknown> = {}) => write(path.join(root, '.git/sdlc-runs'), `${SLUG}.json`, {
  slug: SLUG, worktree: wt, pid: 0, started: '2026-10-19T10:00:00', state: 'exited', exit_code: '0', interrupted: false, finished: '', message: '', branch: BRANCH, base: 'main', ...extra,
});
const originHas = (file: string): string | null => tryGit(origin, 'show', `${BRANCH}:${DOCS}/${file}`);
const originHead = () => git(origin, 'rev-parse', BRANCH);
const mainClean = () => expect(git(root, 'status', '--porcelain')).toBe('');
/** Removes the run's worktree: what a finished run that was cleaned up leaves. */
const dropWorktree = () => { git(root, 'worktree', 'remove', '--force', wt); git(root, 'branch', '-q', '-D', BRANCH); };

beforeEach(() => {
  clearPrCache();
  base = fs.realpathSync(tmp('pr-sync-commit-'));
  root = path.join(base, 'repo');
  origin = path.join(base, 'origin.git');
  wt = path.join(base, 'wts', SLUG);
  write(root, 'sdlc.config.json', { suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } });
  write(root, 'Docs/backlog/index.md', `# Backlog\n\n- [ ] \`${SLUG}\` - Feature: Add tokens\n`);
  write(root, `${DOCS}/brief.md`, `# ${SLUG}\n\nPull request: https://github.com/o/r/pull/91\n`);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(base, 'init', '-q', '--bare', origin);
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  git(root, 'worktree', 'add', '-q', wt, '-b', BRANCH);
  git(wt, 'push', '-q', '-u', 'origin', BRANCH);
  record();
  env = { ...GIT_ENV, PATH: `${path.join(base, 'bin')}:${process.env.PATH}` };
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('Sync PR commits its files on the run\'s branch', () => {
  test('a worktree of a run that is not running: pr-comments.md is committed and pushed there; the main checkout is untouched', async () => {
    gh();
    const r = await syncPr(runContext(root, env), SLUG);
    expect(r.err).toBeUndefined();
    expect(r.count).toBe(1);
    expect(git(wt, 'log', '-1', '--format=%s')).toBe(`chore(${SLUG}): sync PR comments`);
    expect(git(wt, 'show', '--name-only', '--format=', 'HEAD')).toBe(`${DOCS}/pr-comments.md`);
    expect(originHas('pr-comments.md')).toContain('please rename');
    expect(originHead()).toBe(git(wt, 'rev-parse', 'HEAD'));
    mainClean();
    expect(fs.existsSync(path.join(root, DOCS, 'pr-comments.md'))).toBe(false);
  });

  test('the same comments again make no commit', async () => {
    gh();
    const ctx = runContext(root, env);
    await syncPr(ctx, SLUG);
    const head = originHead();
    gh();
    const r = await syncPr(ctx, SLUG);
    expect(r.err).toBeUndefined();
    expect(originHead()).toBe(head);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
  });

  test('a running run: the file goes into its worktree only, with no commit, and the result says so', async () => {
    record({ state: 'running', pid: process.pid });
    gh();
    const head = git(wt, 'rev-parse', 'HEAD');
    const r = await syncPr(runContext(root, env), SLUG);
    expect(fs.readFileSync(path.join(wt, DOCS, 'pr-comments.md'), 'utf8')).toContain('please rename');
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(head);
    expect(originHead()).toBe(head);
    expect(r.notes?.join(' ')).toContain('is running');
    mainClean();
  });

  test('no worktree: the commit lands on origin\'s branch through a temporary worktree that is removed again', async () => {
    dropWorktree();
    gh({ comment: 'use a map' });
    const before = originHead();
    const r = await syncPr(runContext(root, env), SLUG);
    expect(r.err).toBeUndefined();
    expect(originHead()).not.toBe(before);
    expect(git(origin, 'log', '-1', '--format=%s', BRANCH)).toBe(`chore(${SLUG}): sync PR comments`);
    expect(originHas('pr-comments.md')).toContain('use a map');
    expect(git(root, 'worktree', 'list').split('\n')).toHaveLength(1);
    mainClean();
    // Again with the same comments: nothing new.
    const head = originHead();
    gh({ comment: 'use a map' });
    await syncPr(runContext(root, env), SLUG);
    expect(originHead()).toBe(head);
    expect(git(root, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('no worktree and the PR merged: nothing is written, the comments are only in the result', async () => {
    dropWorktree();
    gh({ state: 'MERGED' });
    const before = originHead();
    const r = await syncPr(runContext(root, env), SLUG);
    expect(r.count).toBe(1);
    expect(r.notes?.join(' ')).toContain('merged');
    expect(originHead()).toBe(before);
    mainClean();
  });

  test('a push that fails is kept in errors.log and said in the result', async () => {
    git(wt, 'remote', 'set-url', 'origin', path.join(base, 'missing.git'));
    gh();
    const r = await syncPr(runContext(root, env), SLUG);
    expect(r.err?.join('\n')).toContain('could not push the PR comments');
    expect(fs.readFileSync(path.join(wt, DOCS, 'logs', 'errors.log'), 'utf8')).toContain('push of the PR comments');
    expect(git(wt, 'log', '-1', '--format=%s')).toBe(`chore(${SLUG}): sync PR comments`);
    mainClean();
  });

  test('ci-failure.md is committed while the CI fails, and its removal is committed once the CI is green', async () => {
    const ctx = runContext(root, env);
    gh({ ci: 'FAILURE' });
    await syncPr(ctx, SLUG);
    expect(originHas('ci-failure.md')).toContain('# CI failure of the pull request');
    expect(git(wt, 'log', '--format=%s', '-2').split('\n')).toContain(`chore(${SLUG}): CI failure report`);
    gh({ ci: 'SUCCESS' });
    const r = await syncPr(ctx, SLUG);
    expect(r.err).toBeUndefined();
    expect(fs.existsSync(path.join(wt, DOCS, 'ci-failure.md'))).toBe(false);
    expect(originHas('ci-failure.md')).toBeNull();
    expect(git(wt, 'log', '-1', '--format=%s')).toBe(`chore(${SLUG}): CI failure report`);
    expect(git(wt, 'status', '--porcelain', '--', DOCS)).toBe('');
    mainClean();
  });

  test('with no worktree, the Completed detail and the run view read the comments from the branch', async () => {
    dropWorktree();
    gh({ comment: 'split this function' });
    const ctx = runContext(root, env);
    await syncPr(ctx, SLUG);
    expect(fs.existsSync(path.join(root, DOCS, 'pr-comments.md'))).toBe(false);
    expect(getCompletedTaskDetail(ctx, SLUG).prComments).toContain('split this function');
    expect(runView(ctx, SLUG, { changes: false, tailLines: 0, checkPr: false }).hasPrComments).toBe(true);
  });
});
