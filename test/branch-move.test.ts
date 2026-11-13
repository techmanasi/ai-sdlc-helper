import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Git } from '../src/pipeline/git.js';
import { Status } from '../src/pipeline/status.js';
import type { Ctx } from '../src/pipeline/context.js';
import { isRunBranch, moveReasonText, moveSkipped, moveToNewBranch, nextRunBranch, openMovedPr } from '../src/pipeline/branch-move.js';
import { clearPrCache, clearPrInBrief, getPrFromBrief } from '../src/pipeline/finalise.js';
import { draftPrText } from '../src/pipeline/ci.js';
import { diagnosePush, ensurePushable, pushFailureKind } from '../src/pipeline/push-check.js';

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const NEW_PR = 'https://github.com/o/r/pull/99';
const OLD_PR = 'https://github.com/o/r/pull/5';
const slug = 'foo';
let saved: { PATH?: string; GHDIR?: string };
let root: string;
let repo: string;
let origin: string;
let ghDir: string;
const lines: string[] = [];

/** A repo on `<prefix><slug>` with one commit pushed to a bare origin, and a fake gh driven by files in ghDir. */
function setup(prefix: string, withBrief = `---\npr: ${OLD_PR}\n---\n\n# ${slug}\n`) {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-branch-move-')));
  repo = path.join(root, 'repo');
  origin = path.join(root, 'origin.git');
  ghDir = path.join(root, 'gh');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(ghDir);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo gh 1; exit 0; fi',
    'if [ "$1 $2" = "pr view" ]; then [ -f "$GHDIR/view.json" ] && { cat "$GHDIR/view.json"; exit 0; }; exit 1; fi',
    'if [ "$1 $2" = "pr list" ]; then exit 1; fi',
    'if [ "$1 $2" = "pr create" ] && [ -f "$GHDIR/create-fails" ]; then cat "$GHDIR/create-fails" >&2; exit 1; fi',
    `if [ "$1 $2" = "pr create" ]; then echo "$@" >> "$GHDIR/create.log"; echo ${NEW_PR}; exit 0; fi`,
    'exit 1', '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.GHDIR = ghDir;
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'user.name', 'T');
  sh(repo, 'remote', 'add', 'origin', origin);
  const docs = `docs/backlog/${slug}`;
  fs.mkdirSync(path.join(repo, docs, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(repo, docs, 'brief.md'), withBrief);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'docs/backlog/*/logs/\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  sh(repo, 'push', '-q', '-u', 'origin', 'main');
  sh(repo, 'checkout', '-q', '-b', `${prefix}${slug}`);
  sh(repo, 'push', '-q', '-u', 'origin', `${prefix}${slug}`);
  lines.length = 0;
  const ctx = {
    root, slug, docs, log: `${docs}/logs`, branch: `${prefix}${slug}`, env: { ...process.env },
    config: { git: { branchPrefix: prefix, base: 'main' } },
    git: new Git(repo, { ...process.env }),
    status: new Status(path.join(repo, docs, 'logs', 'status.json'), slug),
    out: (l: string) => { lines.push(l); },
  } as unknown as Ctx;
  // The brief lives where the context's root says.
  (ctx as { root: string }).root = repo;
  return ctx;
}

beforeEach(() => { saved = { PATH: process.env.PATH, GHDIR: process.env.GHDIR }; clearPrCache(); });
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.GHDIR === undefined) delete process.env.GHDIR; else process.env.GHDIR = saved.GHDIR;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('isRunBranch and moveSkipped', () => {
  it('knows the run branch and its moves <slug>_N (N from 2), and no other item\'s branch', () => {
    expect(isRunBranch('sdlc/foo', 'sdlc/', 'foo')).toBe(true);
    expect(isRunBranch('sdlc/foo_2', 'sdlc/', 'foo')).toBe(true);
    expect(isRunBranch('feature/foo_12', 'feature/', 'foo')).toBe(true);
    // sdlc/foo-2 is the branch of an item named foo-2; _1 and _02 are never made.
    for (const b of ['sdlc/foo-2', 'sdlc/foo_1', 'sdlc/foo_02', 'sdlc/foo-resolve-conflict-1', 'sdlc/foo-bar', 'sdlc/foobar', 'main', 'sdlc/foo_', 'sdlc/foo-']) {
      expect(isRunBranch(b, 'sdlc/', 'foo'), b).toBe(false);
    }
  });
  it('reads SDLC_MOVE_BRANCH', () => {
    expect(moveSkipped({ SDLC_MOVE_BRANCH: '0' })).toBe(true);
    expect(moveSkipped({ SDLC_MOVE_BRANCH: 'Off' })).toBe(true);
    expect(moveSkipped({})).toBe(false);
    expect(moveSkipped({ SDLC_MOVE_BRANCH: '1' })).toBe(false);
  });
});

describe('nextRunBranch', () => {
  it('skips other items\' branches, local branches, remote-tracking ones and names only on origin', () => {
    const ctx = setup('sdlc/');
    expect(nextRunBranch(ctx.git, 'sdlc/', slug)).toBe('sdlc/foo_2');
    // Another item (foo-2) and a follow-up item of this one: neither is a name the move could take, and neither is skipped over.
    sh(repo, 'branch', 'sdlc/foo-2');
    sh(repo, 'branch', 'sdlc/foo-resolve-conflict-1');
    expect(nextRunBranch(ctx.git, 'sdlc/', slug)).toBe('sdlc/foo_2');
    // _2 here (every worktree shares refs/heads), _3 only on origin (never fetched here).
    sh(repo, 'branch', 'sdlc/foo_2');
    const other = path.join(root, 'other');
    spawnSync('git', ['clone', '-q', origin, other]);
    sh(other, 'push', '-q', 'origin', 'origin/main:refs/heads/sdlc/foo_3');
    expect(sh(repo, 'branch', '-r', '--list', 'origin/sdlc/foo_3')).toBe('');
    expect(nextRunBranch(ctx.git, 'sdlc/', slug)).toBe('sdlc/foo_4');
    // _4 only as a remote-tracking ref (deleted on origin since).
    sh(repo, 'update-ref', 'refs/remotes/origin/sdlc/foo_4', 'HEAD');
    expect(nextRunBranch(ctx.git, 'sdlc/', slug)).toBe('sdlc/foo_5');
  });
  it('goes one past the branch it is on', () => {
    const ctx = setup('feature/');
    sh(repo, 'checkout', '-q', '-b', 'feature/foo_2');
    expect(nextRunBranch(ctx.git, 'feature/', slug)).toBe('feature/foo_3');
  });
});

describe('moveToNewBranch', () => {
  it('switches to a new branch at the same commit and records the move, with the reason in words', () => {
    const ctx = setup('sdlc/');
    const head = sh(repo, 'rev-parse', 'HEAD');
    expect(moveToNewBranch(ctx, { kind: 'earlier-run', detail: 'x' })).toBe('sdlc/foo_2');
    expect(ctx.branch).toBe('sdlc/foo_2');
    expect(sh(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('sdlc/foo_2');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    // The old branch is intact here and on origin.
    expect(sh(repo, 'rev-parse', 'sdlc/foo')).toBe(head);
    expect(sh(origin, 'rev-parse', 'sdlc/foo')).toBe(head);
    const brief = fs.readFileSync(path.join(repo, ctx.docs, 'brief.md'), 'utf8');
    expect(getPrFromBrief(brief)).toBeNull();
    expect(brief).toContain(`# ${slug}`);
    const st = JSON.parse(fs.readFileSync(path.join(repo, ctx.log, 'status.json'), 'utf8'));
    expect(st.branch).toBe('sdlc/foo_2');
    expect(st.moved_from).toMatchObject({ branch: 'sdlc/foo', reason: 'earlier-run', reason_text: moveReasonText('earlier-run'), pr: OLD_PR });
    expect(st.moved_from.reason_text).not.toBe('earlier-run');
    const rows = fs.readFileSync(path.join(repo, ctx.log, 'attempts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'move', from: 'sdlc/foo', to: 'sdlc/foo_2', reason: 'earlier-run' });
    expect(lines.join('\n')).toContain('MOVED: this run continues on branch sdlc/foo_2');
  });
  it('keeps other front matter and uses the closed PR when the brief has none; works with feature/', () => {
    const ctx = setup('feature/', `---\nowner: me\n---\n\n# ${slug}\n`);
    moveToNewBranch(ctx, { kind: 'pr-closed', detail: OLD_PR });
    expect(ctx.branch).toBe('feature/foo_2');
    const brief = fs.readFileSync(path.join(repo, ctx.docs, 'brief.md'), 'utf8');
    expect(brief).toContain('owner: me');
    expect(ctx.movedFrom).toEqual({ branch: 'feature/foo', pr: OLD_PR, reason: 'pr-closed' });
  });
  it('uses the branch maker it is given', () => {
    const ctx = setup('sdlc/');
    const made: string[] = [];
    moveToNewBranch(ctx, { kind: 'diverged', detail: 'x' }, to => { made.push(to); sh(repo, 'checkout', '-q', '--orphan', to); });
    expect(made).toEqual(['sdlc/foo_2']);
    expect(ctx.status.movedFrom?.reason).toBe('diverged');
  });
});

describe('clearPrInBrief and draftPrText', () => {
  it('removes every pull request line it knows: front matter and body', () => {
    const text = `---\npr: ${OLD_PR}\nowner: me\n---\n\n# foo\nPR: ${OLD_PR}\ntext\npr: https://github.com/o/r/pull/6\n`;
    const out = clearPrInBrief(text);
    expect(getPrFromBrief(out)).toBeNull();
    expect(out).toBe('---\nowner: me\n---\n\n# foo\ntext\n');
    expect(clearPrInBrief(`# foo\nPR: ${OLD_PR}\nPR: ${NEW_PR}`)).toBe('# foo\n');
  });
  it('names what a moved run\'s pull request replaces, in words', () => {
    const ctx = setup('sdlc/');
    expect(draftPrText(ctx).body).not.toContain('Replaces');
    (ctx as { movedFrom?: unknown }).movedFrom = { branch: 'sdlc/foo', pr: OLD_PR, reason: 'pr-merged' };
    expect(draftPrText(ctx).body).toContain(`Replaces ${OLD_PR} (its pull request is merged).`);
    (ctx as { movedFrom?: unknown }).movedFrom = { branch: 'sdlc/foo', pr: null, reason: 'earlier-run' };
    expect(draftPrText(ctx).body).toContain(`Replaces branch sdlc/foo (${moveReasonText('earlier-run')}).`);
  });
});

describe('openMovedPr', () => {
  it('opens nothing when no commit is ahead of the base', async () => {
    const ctx = setup('sdlc/');
    moveToNewBranch(ctx, { kind: 'earlier-run', detail: 'x' });
    expect(await openMovedPr(ctx)).toBeNull();
    expect(fs.existsSync(path.join(ghDir, 'create.log'))).toBe(false);
    expect(spawnSync('git', ['-C', origin, 'rev-parse', '--verify', '-q', 'sdlc/foo_2']).status).not.toBe(0);
  });
  it('pushes the new branch and opens a draft pull request that names what it replaces, once', async () => {
    const ctx = setup('sdlc/');
    moveToNewBranch(ctx, { kind: 'pr-merged', detail: OLD_PR });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'work');
    expect(await openMovedPr(ctx)).toBe(NEW_PR);
    expect(sh(origin, 'rev-parse', 'sdlc/foo_2')).toBe(sh(repo, 'rev-parse', 'HEAD'));
    const created = fs.readFileSync(path.join(ghDir, 'create.log'), 'utf8');
    expect(created).toContain('--head sdlc/foo_2');
    expect(created).toContain('--draft');
    expect(created.split('Replaces').length - 1).toBe(1);
    expect(created).toContain(`Replaces ${OLD_PR} (its pull request is merged)`);
    expect(getPrFromBrief(fs.readFileSync(path.join(repo, ctx.docs, 'brief.md'), 'utf8'))).toBe(NEW_PR);
  });
  it('does nothing for a run that did not move', async () => {
    const ctx = setup('sdlc/');
    expect(await openMovedPr(ctx)).toBeNull();
  });
  it('a failed gh pr create: gh\'s message and exit code are kept in errors.log, and one line names it and where the rest is', async () => {
    const ctx = setup('sdlc/');
    const said = 'pull request create failed: GraphQL: Head sha can\'t be blank (createPullRequest)';
    fs.writeFileSync(path.join(ghDir, 'create-fails'), `${said}\n`);
    moveToNewBranch(ctx, { kind: 'pr-merged', detail: OLD_PR });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'work');
    expect(await openMovedPr(ctx)).toBeNull();
    const errors = fs.readFileSync(path.join(repo, ctx.log, 'errors.log'), 'utf8');
    expect(errors).toContain(`gh pr create exited with 1: ${said}`);
    expect(lines).toContain(`   could not open a pull request for sdlc/foo_2: gh pr create exited with 1: ${said} (the whole message is in ${ctx.log}/errors.log)`);
    expect(getPrFromBrief(fs.readFileSync(path.join(repo, ctx.docs, 'brief.md'), 'utf8'))).toBeNull();
  });
});

// ---- The push check ----

/** A second clone on the run's branch: what someone else (or an earlier run) pushes. */
function otherClone(): string {
  const other = path.join(root, 'other');
  if (!fs.existsSync(other)) {
    spawnSync('git', ['clone', '-q', origin, other]);
    sh(other, 'config', 'user.email', 'o@example.com'); sh(other, 'config', 'user.name', 'O');
  }
  sh(other, 'fetch', '-q', 'origin');
  return other;
}
const commitFile = (dir: string, file: string, text: string, msg = file) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', msg);
  return sh(dir, 'rev-parse', 'HEAD');
};
/** Someone else pushes <file> to the run's branch on origin. */
function theyPush(file: string, text: string): string {
  const other = otherClone();
  sh(other, 'checkout', '-q', '-B', `sdlc/${slug}`, `origin/sdlc/${slug}`);
  const c = commitFile(other, file, text, `theirs: ${file}`);
  sh(other, 'push', '-q', 'origin', `sdlc/${slug}`);
  return c;
}
const remoteSha = (b = `sdlc/${slug}`) => sh(origin, 'rev-parse', b);
const checks = () => fs.readFileSync(path.join(repo, `docs/backlog/${slug}/logs/attempts.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.kind === 'push-check');

describe('diagnosePush', () => {
  it('finds no origin, a pushable branch, and a branch behind origin\'s (earlier run only on a fresh start without own commits)', () => {
    const ctx = setup('sdlc/');
    expect(diagnosePush(ctx, { fresh: true })).toMatchObject({ kind: 'ok', reason: 'pushable' });
    commitFile(repo, 'mine.txt', 'mine');
    expect(diagnosePush(ctx, { fresh: true })).toMatchObject({ kind: 'ok', reason: 'pushable' });
    sh(repo, 'reset', '-q', '--hard', 'HEAD~1');
    theyPush('x.txt', 'x');
    expect(diagnosePush(ctx, { fresh: true })).toMatchObject({ kind: 'new-branch', reason: 'earlier-run' });
    expect(diagnosePush(ctx, { fresh: false })).toMatchObject({ kind: 'fast-forward', reason: 'behind' });
    sh(repo, 'remote', 'remove', 'origin');
    expect(diagnosePush(ctx, { fresh: true })).toMatchObject({ kind: 'ok', reason: 'no-origin' });
  });
  it('works in a single-branch clone, and with no branch on origin yet', () => {
    const base = setup('sdlc/');
    const single = path.join(root, 'single');
    spawnSync('git', ['clone', '-q', '--single-branch', '-b', 'main', origin, single]);
    sh(single, 'config', 'user.email', 's@example.com'); sh(single, 'config', 'user.name', 'S');
    sh(single, 'checkout', '-q', '-b', `sdlc/${slug}`);
    const ctx = { ...base, git: new Git(single, { ...process.env }) } as Ctx;
    theyPush('x.txt', 'x');
    expect(diagnosePush(ctx, { fresh: false })).toMatchObject({ kind: 'fast-forward' });
    sh(single, 'checkout', '-q', '-b', 'sdlc/foo_9');
    expect(diagnosePush({ ...ctx, branch: 'sdlc/foo_9' } as Ctx, { fresh: false })).toMatchObject({ kind: 'ok', reason: 'pushable', remote: null });
  });
});

describe('ensurePushable', () => {
  it('a pushable branch: nothing changes and the check records ok', async () => {
    const ctx = setup('sdlc/');
    const head = sh(repo, 'rev-parse', 'HEAD');
    await ensurePushable(ctx, { resume: 'red-tests', fresh: true });
    expect(ctx.branch).toBe('sdlc/foo');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(checks()).toMatchObject([{ finding: 'pushable', action: 'none' }]);
    expect(lines).toContain('Push check: sdlc/foo can be pushed');
  });

  it('origin holds the same commits from before a rebase: pushed with a lease, same branch, origin now at HEAD', async () => {
    const ctx = setup('sdlc/');
    const before = commitFile(repo, 'mine.txt', 'mine', 'mine');
    sh(repo, 'push', '-q', 'origin', 'sdlc/foo');
    // The base moved on origin; the run's branch was rebased onto it here (same change, new commit), not pushed.
    const other = otherClone();
    sh(other, 'checkout', '-q', 'main');
    commitFile(other, 'base.txt', 'base');
    sh(other, 'push', '-q', 'origin', 'main');
    sh(repo, 'fetch', '-q', 'origin');
    sh(repo, 'rebase', '-q', 'origin/main');
    const rebased = sh(repo, 'rev-parse', 'HEAD');
    expect(rebased).not.toBe(before);
    expect(remoteSha()).toBe(before);
    await ensurePushable(ctx, { resume: 'red-tests', fresh: false });
    expect(ctx.branch).toBe('sdlc/foo');
    expect(remoteSha()).toBe(rebased);
    expect(sh(repo, 'rev-parse', 'refs/sdlc-backup/sdlc/foo/remote')).toBe(before);
    expect(checks()).toMatchObject([{ finding: 'same-commits', action: 'lease-push' }]);
    expect(lines.join('\n')).toContain('Push check: origin holds the same commits from before a rebase: pushed with a lease');
    expect(ctx.movedFrom).toBeUndefined();
  });

  it('diverged, and a rebase onto origin\'s branch is clean: rebased and pushed normally, both sides\' commits kept', async () => {
    const ctx = setup('sdlc/');
    const mine = commitFile(repo, 'mine.txt', 'mine', 'mine');
    const theirs = theyPush('theirs.txt', 'theirs');
    await ensurePushable(ctx, { resume: 'red-tests', fresh: false });
    expect(ctx.branch).toBe('sdlc/foo');
    expect(remoteSha()).toBe(sh(repo, 'rev-parse', 'HEAD'));
    expect(sh(repo, 'merge-base', '--is-ancestor', theirs, 'HEAD')).toBe('');
    expect(sh(origin, 'show', 'sdlc/foo:mine.txt')).toBe('mine');
    expect(sh(origin, 'show', 'sdlc/foo:theirs.txt')).toBe('theirs');
    expect(sh(repo, 'rev-parse', 'refs/sdlc-backup/sdlc/foo/local')).toBe(mine);
    expect(checks()).toMatchObject([{ finding: 'diverged', action: 'rebase-push' }]);
  });

  it('diverged, and the rebase stops on a conflict: aborted, a new branch from the base with the run\'s commit, origin\'s branch untouched', async () => {
    const ctx = setup('sdlc/');
    const mine = commitFile(repo, 'c.txt', 'mine\n', 'mine');
    const theirs = theyPush('c.txt', 'theirs\n');
    await ensurePushable(ctx, { resume: 'red-tests', fresh: false });
    expect(ctx.branch).toBe('sdlc/foo_2');
    expect(sh(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('sdlc/foo_2');
    expect(fs.existsSync(path.join(repo, '.git', 'rebase-merge'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'c.txt'), 'utf8')).toBe('mine\n');
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('mine');
    expect(sh(repo, 'rev-parse', 'HEAD~1')).toBe(sh(repo, 'rev-parse', 'origin/main'));
    // Old branch, here and on origin, as it was.
    expect(sh(repo, 'rev-parse', 'sdlc/foo')).toBe(mine);
    expect(remoteSha()).toBe(theirs);
    // Something is committed: the new branch is pushed and its pull request opened now.
    expect(remoteSha('sdlc/foo_2')).toBe(sh(repo, 'rev-parse', 'HEAD'));
    expect(fs.readFileSync(path.join(ghDir, 'create.log'), 'utf8')).toContain('--head sdlc/foo_2');
    expect(checks()).toMatchObject([{ finding: 'diverged', action: 'new-branch-from-base' }]);
    expect(ctx.status.movedFrom).toMatchObject({ branch: 'sdlc/foo', reason: 'diverged' });
  });

  it('a new branch starts from origin\'s base, fetched just now, also when the local base is behind it', async () => {
    const ctx = setup('sdlc/');
    const mine = commitFile(repo, 'mine.txt', 'mine\n', 'mine');
    const localMain = sh(repo, 'rev-parse', 'main');
    const other = otherClone();
    sh(other, 'checkout', '-q', 'main');
    const ahead = commitFile(other, 'base.txt', 'base\n');
    sh(other, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(ghDir, 'view.json'), JSON.stringify({ url: OLD_PR, state: 'CLOSED', number: 5 }));
    await ensurePushable(ctx, { resume: 'red-tests', fresh: false });
    expect(ctx.branch).toBe('sdlc/foo_2');
    // The local base is not touched and not used: the new branch is origin's base plus the run's own commit.
    expect(sh(repo, 'rev-parse', 'main')).toBe(localMain);
    expect(sh(repo, 'rev-parse', 'HEAD~1')).toBe(ahead);
    expect(sh(repo, 'log', '-1', '--format=%s')).toBe('mine');
    expect(sh(repo, 'rev-parse', 'sdlc/foo')).toBe(mine);
    expect(sh(repo, 'rev-parse', 'refs/sdlc-backup/sdlc/foo/local')).toBe(mine);
    expect(checks()).toMatchObject([{ finding: 'pr-closed', action: 'new-branch-from-base' }]);
    expect(lines.join('\n')).toContain(`made from origin/main (${ahead.slice(0, 7)}) with this run's own commits`);
  });

  it('origin\'s base cannot be fetched: the run does not move, and says why', async () => {
    const ctx = setup('sdlc/');
    // The base exists here only: a new branch would have to come from the local one, which is never used.
    (ctx.config.git as { base: string }).base = 'trunk';
    sh(repo, 'branch', 'trunk', 'main');
    fs.writeFileSync(path.join(ghDir, 'view.json'), JSON.stringify({ url: OLD_PR, state: 'CLOSED', number: 5 }));
    const head = sh(repo, 'rev-parse', 'HEAD');
    await ensurePushable(ctx, { resume: 'red-tests', fresh: true });
    expect([ctx.branch, sh(repo, 'symbolic-ref', '--short', 'HEAD'), sh(repo, 'rev-parse', 'HEAD'), sh(repo, 'branch', '--list', 'sdlc/foo_*')]).toEqual(['sdlc/foo', 'sdlc/foo', head, '']);
    expect(ctx.movedFrom).toBeUndefined();
    expect(checks()).toMatchObject([{ finding: 'pr-closed', action: 'no-base' }]);
    expect(lines.join('\n')).toContain("a new branch is made only from origin's trunk, which could not be fetched (origin has no trunk): going on unchanged on sdlc/foo");
  });

  it('diverged with uncommitted tracked changes: no rebase, a new branch', async () => {
    const ctx = setup('sdlc/');
    commitFile(repo, 'mine.txt', 'mine');
    theyPush('theirs.txt', 'theirs');
    fs.appendFileSync(path.join(repo, '.gitignore'), 'tmp/\n');
    await ensurePushable(ctx, { resume: 'red-tests', fresh: false });
    expect(ctx.branch).toBe('sdlc/foo_2');
    expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toContain('tmp/');
    expect(fs.existsSync(path.join(repo, 'theirs.txt'))).toBe(false);
  });

  it('behind origin\'s branch with own history (not a fresh start): fast-forwarded', async () => {
    const ctx = setup('sdlc/');
    const theirs = theyPush('x.txt', 'x');
    await ensurePushable(ctx, { resume: 'implement', fresh: false });
    expect(ctx.branch).toBe('sdlc/foo');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(theirs);
    expect(checks()).toMatchObject([{ finding: 'behind', action: 'fast-forward' }]);
  });

  it('behind on a fresh start with no own commits: origin\'s branch is an earlier run\'s, so a new branch from the base', async () => {
    const ctx = setup('sdlc/');
    const theirs = theyPush('x.txt', 'x');
    await ensurePushable(ctx, { resume: 'red-tests', fresh: true });
    expect(ctx.branch).toBe('sdlc/foo_2');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(sh(repo, 'rev-parse', 'origin/main'));
    expect(remoteSha()).toBe(theirs);
    expect(checks()).toMatchObject([{ finding: 'earlier-run', action: 'new-branch-from-base' }]);
  });

  for (const state of ['CLOSED', 'MERGED'] as const) {
    it(`a ${state.toLowerCase()} pull request: a new branch`, async () => {
      const ctx = setup('sdlc/');
      fs.writeFileSync(path.join(ghDir, 'view.json'), JSON.stringify({ url: OLD_PR, state, number: 5 }));
      await ensurePushable(ctx, { resume: 'red-tests', fresh: true });
      expect(ctx.branch).toBe('sdlc/foo_2');
      expect(ctx.status.movedFrom).toMatchObject({ reason: state === 'CLOSED' ? 'pr-closed' : 'pr-merged', pr: OLD_PR });
    });
  }

  it('SDLC_MOVE_BRANCH=0 keeps the branch where a new one would be made; SDLC_PUSH_CHECK=0 skips the check', async () => {
    const ctx = setup('sdlc/');
    commitFile(repo, 'c.txt', 'mine\n');
    const theirs = theyPush('c.txt', 'theirs\n');
    const head = sh(repo, 'rev-parse', 'HEAD');
    await ensurePushable({ ...ctx, env: { ...ctx.env, SDLC_PUSH_CHECK: 'off' } } as Ctx, { resume: 'red-tests', fresh: false });
    expect(fs.existsSync(path.join(repo, ctx.log, 'attempts.jsonl'))).toBe(false);
    ctx.env = { ...ctx.env, SDLC_MOVE_BRANCH: '0' };
    await ensurePushable(ctx, { resume: 'red-tests', fresh: false });
    expect(ctx.branch).toBe('sdlc/foo');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(remoteSha()).toBe(theirs);
    expect(checks()).toMatchObject([{ action: 'kept' }]);
  });

  it('origin unreachable: nothing changes, one errors.log entry', async () => {
    const ctx = setup('sdlc/');
    const head = sh(repo, 'rev-parse', 'HEAD');
    sh(repo, 'remote', 'set-url', 'origin', path.join(root, 'nowhere.git'));
    await ensurePushable(ctx, { resume: 'red-tests', fresh: true });
    expect([ctx.branch, sh(repo, 'rev-parse', 'HEAD'), sh(repo, 'branch', '--list', 'sdlc/foo_*')]).toEqual(['sdlc/foo', head, '']);
    const errors = fs.readFileSync(path.join(repo, ctx.log, 'errors.log'), 'utf8');
    expect(errors.match(/^=== /gm)).toHaveLength(1);
    expect(checks()).toMatchObject([{ finding: 'fetch-failed', action: 'none' }]);
    expect(lines.join('\n')).toContain('going on unchanged');
  });
});

describe('pushFailureKind', () => {
  const cases: Array<[string, ReturnType<typeof pushFailureKind>]> = [
    ['fatal: unable to access \'https://github.com/o/r.git/\': Could not resolve host: github.com', 'unreachable'],
    ['ssh: connect to host github.com port 22: Connection refused', 'unreachable'],
    ['ssh: connect to host github.com port 22: Connection timed out', 'unreachable'],
    ['Connection reset by peer', 'unreachable'],
    ['git push --dry-run failed: spawnSync git ETIMEDOUT', 'unreachable'],
    ['remote: Invalid username or password.\nfatal: Authentication failed for \'https://github.com/o/r.git/\'', 'unreachable'],
    ['git@github.com: Permission denied (publickey).', 'unreachable'],
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'unreachable'],
    ['The requested URL returned error: 403', 'unreachable'],
    ['The requested URL returned error: 401', 'unreachable'],
    ['remote: Repository not found.', 'unreachable'],
    ['fatal: \'/x/nowhere.git\' does not appear to be a git repository\nfatal: Could not read from remote repository.', 'unreachable'],
    [' ! [remote rejected] sdlc/foo -> sdlc/foo (pre-receive hook declined)', 'branch-refused'],
    ['remote: error: GH006: Protected branch update failed for refs/heads/sdlc/foo.', 'branch-refused'],
    ['remote: error: GH013: Repository rule violations found for refs/heads/sdlc/foo.', 'branch-refused'],
    [' ! [rejected]        sdlc/foo -> sdlc/foo (non-fast-forward)', 'rejected'],
    [' ! [rejected]        sdlc/foo -> sdlc/foo (fetch first)', 'rejected'],
    ['error: something nobody has seen before', 'unknown'],
    // Only git's words count: the command line before them names the branch.
    ['git push --dry-run -q origin HEAD:refs/heads/sdlc/fix-403-handling failed: error: something nobody has seen before', 'unknown'],
    ['git push --dry-run -q origin HEAD:refs/heads/item/401 failed: error: failed to push some refs to \'/x/origin.git\'', 'unknown'],
    ['git push --dry-run -q origin HEAD:refs/heads/sdlc/timed-out failed: error: src refspec sdlc/timed-out does not match any', 'unknown'],
    ['error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403', 'unreachable'],
    // Another push moved the ref meanwhile: origin is ahead, the branch is not refused.
    [' ! [remote rejected] sdlc/foo -> sdlc/foo (cannot lock ref \'refs/heads/sdlc/foo\': is at 1111111 but expected 2222222)', 'rejected'],
  ];
  for (const [message, kind] of cases) it(`${kind}: ${message.split('\n').pop()}`, () => { expect(pushFailureKind(message)).toBe(kind); });
});

describe('ensurePushable, when origin takes no push or gh is missing', () => {
  it('a trial push origin cannot take (push URL nowhere, fetch fine): branch, HEAD and origin unchanged, no new branch', async () => {
    const ctx = setup('sdlc/');
    commitFile(repo, 'mine.txt', 'mine');
    const head = sh(repo, 'rev-parse', 'HEAD');
    const before = remoteSha();
    sh(repo, 'remote', 'set-url', '--push', 'origin', path.join(root, 'nowhere.git'));
    await ensurePushable(ctx, { resume: 'red-tests', fresh: true });
    expect([ctx.branch, sh(repo, 'symbolic-ref', '--short', 'HEAD'), sh(repo, 'rev-parse', 'HEAD'), remoteSha()]).toEqual(['sdlc/foo', 'sdlc/foo', head, before]);
    expect(sh(repo, 'branch', '--list', 'sdlc/foo_*')).toBe('');
    expect(ctx.movedFrom).toBeUndefined();
    expect(checks()).toMatchObject([{ finding: 'push-unreachable', action: 'none' }]);
    expect(fs.readFileSync(path.join(repo, ctx.log, 'errors.log'), 'utf8').match(/^=== /gm)).toHaveLength(1);
    expect(lines.join('\n')).toContain('origin cannot be reached or does not accept this user');
  });

  it('says once that gh is not available when it is not on PATH', async () => {
    const ctx = setup('sdlc/');
    // A PATH with git and nothing else (a system folder may hold gh: GitHub's runners have it in /usr/bin).
    const only = path.join(root, 'only-git');
    fs.mkdirSync(only);
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(realGit, path.join(only, 'git'));
    ctx.env = { ...ctx.env, PATH: only };
    await ensurePushable(ctx, { resume: 'red-tests', fresh: true });
    expect(lines.filter(l => l === "Push check: gh is not available, so the pull request's state was not checked")).toHaveLength(1);
    expect(ctx.branch).toBe('sdlc/foo');
  });

  it('origin has one commit with the same change and one the run lacks: no lease push, origin\'s extra commit survives', async () => {
    const ctx = setup('sdlc/');
    commitFile(repo, 'a.txt', 'a\n', 'a');
    sh(repo, 'push', '-q', 'origin', 'sdlc/foo');
    const theirs = theyPush('b.txt', 'b\n');
    // The run's commit, rewritten here (same change, new commit): git cherry shows one "-" and one "+".
    sh(repo, 'commit', '-q', '--amend', '-m', 'a again');
    sh(repo, 'fetch', '-q', 'origin');
    const cherry = sh(repo, 'cherry', 'HEAD', 'origin/sdlc/foo').split('\n').map(l => l[0]).sort();
    expect(cherry).toEqual(['+', '-']);
    await ensurePushable(ctx, { resume: 'red-tests', fresh: false });
    expect(sh(origin, 'merge-base', '--is-ancestor', theirs, 'sdlc/foo')).toBe('');
    expect(sh(origin, 'show', 'sdlc/foo:b.txt')).toBe('b');
    expect(checks().map(c => c.action)).not.toContain('lease-push');
  });
});
