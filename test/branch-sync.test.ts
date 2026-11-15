import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stageRecoveryHint } from '../src/pipeline/hints.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Git } from '../src/pipeline/git.js';
import { Status } from '../src/pipeline/status.js';
import { Exit, type Ctx, type From } from '../src/pipeline/context.js';
import { clearPrCache } from '../src/pipeline/finalise.js';
import { syncBranch } from '../src/pipeline/branch-sync.js';
import { readRecord, registryDir, writeRecord } from '../src/runs/records.js';

// The resolver is an agent; the test plays it. Everything else (git, the stash, the rebase) is real.
const agent = vi.hoisted(() => ({ run: (_ctx: unknown, _name: string): void => { throw new Error('no resolver expected'); }, calls: [] as string[] }));
vi.mock('../src/pipeline/agent.js', async orig => ({
  ...(await orig<typeof import('../src/pipeline/agent.js')>()),
  runAgent: async (ctx: unknown, name: string, stage: string, prompt?: string) => { agent.calls.push(`${name}:${stage}:${prompt}`); agent.run(ctx, name); },
}));

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const slug = 'foo';
const PR = 'https://github.com/o/r/pull/5';
let saved: { PATH?: string; GHDIR?: string };
let root: string;
let repo: string;
let origin: string;
let other: string;
let ghDir: string;
let lines: string[];
let ctx: Ctx;

const write = (dir: string, f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
/** A commit made by "somebody else" on GitHub's copy of a branch, through a second clone. */
function onGithub(branch: string, file: string, text: string, subject = `chore: edit ${file}`) {
  sh(other, 'fetch', '-q', 'origin');
  sh(other, 'checkout', '-q', '-B', branch, `origin/${branch}`);
  write(other, file, text);
  sh(other, 'add', '-A');
  sh(other, 'commit', '-q', '-m', subject);
  sh(other, 'push', '-q', 'origin', branch);
}
const localCommit = (file: string, text: string, subject = `feat(${slug}): edit ${file}`) => {
  write(repo, file, text);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', subject);
};
const remoteTip = (b: string) => sh(origin, 'rev-parse', `refs/heads/${b}`);
const exists = (b: string) => spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '-q', `refs/heads/${b}`]).status === 0;
const onBranch = () => sh(repo, 'symbolic-ref', '--short', 'HEAD');
const sync = (caller = 'implement', resume: From = 'implement') => syncBranch(ctx, { caller, resume });
const stop = async (p: Promise<void>): Promise<number> => { try { await p; } catch (e) { if (e instanceof Exit) return e.code; throw e; } throw new Error('expected the run to stop'); };
const errors = () => { try { return read(repo, `docs/backlog/${slug}/logs/errors.log`); } catch { return ''; } };
const prState = (state: string) => fs.writeFileSync(path.join(ghDir, 'view.json'), JSON.stringify({ url: PR, state, number: 5 }));

/** A repo with a bare origin; <state> decides what exists: 'pushed' (the task's branch on both), 'local' (never pushed), 'none'. */
function setup(state: 'pushed' | 'local' | 'none') {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-branch-sync-')));
  repo = path.join(root, 'repo');
  other = path.join(root, 'other');
  origin = path.join(root, 'origin.git');
  ghDir = path.join(root, 'gh');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(ghDir); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo gh 1; exit 0; fi',
    'if [ "$1 $2" = "pr view" ]; then [ -f "$GHDIR/view.json" ] && { cat "$GHDIR/view.json"; exit 0; }; exit 1; fi',
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
  write(repo, `${docs}/brief.md`, `# ${slug}\n`);
  write(repo, '.gitignore', 'docs/backlog/*/logs/\n');
  write(repo, 'app.txt', 'one\ntwo\nthree\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'init');
  sh(repo, 'push', '-q', '-u', 'origin', 'main');
  spawnSync('git', ['clone', '-q', origin, other]);
  sh(other, 'config', 'user.email', 'p@example.com');
  sh(other, 'config', 'user.name', 'Person');
  const branch = `sdlc/${slug}`;
  if (state !== 'none') {
    sh(repo, 'checkout', '-q', '-b', branch);
    localCommit(`${docs}/specs-1.md`, 'spec\n', `[spec] docs(${slug}): add the spec`);
    if (state === 'pushed') sh(repo, 'push', '-q', '-u', 'origin', branch);
  }
  lines = [];
  fs.mkdirSync(path.join(repo, docs, 'logs'), { recursive: true });
  ctx = {
    root: repo, slug, docs, log: `${docs}/logs`, branch, env: { ...process.env, SDLC_RESOLVE_REVIEW: 'off' },
    config: { backlogDir: 'docs/backlog', git: { branchPrefix: 'sdlc/', base: 'main' } },
    git: new Git(repo, { ...process.env }),
    status: new Status(path.join(repo, docs, 'logs', 'status.json'), slug),
    out: (l: string) => { lines.push(l); },
    priorStage: 'spec',
  } as unknown as Ctx;
  const dir = registryDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  writeRecord(dir, { slug, branch, status: 'running' } as never);
}

beforeEach(() => { saved = { PATH: process.env.PATH, GHDIR: process.env.GHDIR }; clearPrCache(); agent.calls.length = 0; agent.run = () => { throw new Error('no resolver expected'); }; });
afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.GHDIR === undefined) delete process.env.GHDIR; else process.env.GHDIR = saved.GHDIR;
  fs.rmSync(root, { recursive: true, force: true });
});

const STAGES: Array<[string, From]> = [['spec', 'spec'], ['implement', 'implement']];

describe('no local branch', () => {
  for (const [caller, resume] of STAGES) {
    it(`A: nothing anywhere: made from origin's base and pushed at once (${caller})`, async () => {
      setup('none');
      localCommit('later.txt', 'x\n'); // main moves on locally; origin's base is the start
      sh(repo, 'reset', '-q', '--hard', 'origin/main');
      await sync(caller, resume);
      expect(onBranch()).toBe('sdlc/foo');
      expect(remoteTip('sdlc/foo')).toBe(sh(repo, 'rev-parse', 'origin/main'));
    });
    it(`A: a closed pull request starts sdlc/foo_2 (${caller})`, async () => {
      setup('none');
      prState('CLOSED');
      // GitHub still has the branch's old copy; the closed PR retires it.
      sh(repo, 'branch', 'sdlc/foo');
      sh(repo, 'push', '-q', 'origin', 'sdlc/foo');
      sh(repo, 'branch', '-q', '-D', 'sdlc/foo');
      await sync(caller, resume);
      expect(onBranch()).toBe('sdlc/foo_2');
      expect(readRecord(registryDir(repo), slug)?.branch).toBe('sdlc/foo_2');
    });
  }
  it('A: a merged pull request refuses', async () => {
    setup('none');
    prState('MERGED');
    expect(await stop(sync('spec', 'spec'))).toBe(5);
    expect(exists('sdlc/foo')).toBe(false);
  });
  it('B: the remote branch holds the task: a tracking branch from it', async () => {
    setup('pushed');
    sh(repo, 'checkout', '-q', 'main');
    sh(repo, 'branch', '-q', '-D', 'sdlc/foo');
    await sync();
    expect(onBranch()).toBe('sdlc/foo');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(remoteTip('sdlc/foo'));
    expect(sh(repo, 'config', 'branch.sdlc/foo.remote')).toBe('origin');
  });
  it('C: the remote branch is foreign: a new sdlc/foo_2 and no question', async () => {
    setup('none');
    sh(other, 'checkout', '-q', '-b', 'sdlc/foo');
    write(other, 'stranger.txt', 'x\n');
    sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'unrelated work');
    sh(other, 'push', '-q', 'origin', 'sdlc/foo');
    await sync();
    expect(onBranch()).toBe('sdlc/foo_2');
    expect(remoteTip('sdlc/foo')).not.toBe(sh(repo, 'rev-parse', 'HEAD'));
  });
});

describe('local branch', () => {
  it('D: never pushed: continues, no push', async () => {
    setup('local');
    const tip = sh(repo, 'rev-parse', 'HEAD');
    await sync();
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(tip);
    expect(spawnSync('git', ['-C', origin, 'rev-parse', '--verify', '-q', 'refs/heads/sdlc/foo']).status).not.toBe(0);
  });
  it('D: a branch with nothing beyond the base is pushed at once', async () => {
    setup('none');
    sh(repo, 'checkout', '-q', '-b', 'sdlc/foo');
    await sync();
    expect(remoteTip('sdlc/foo')).toBe(sh(repo, 'rev-parse', 'HEAD'));
  });
  for (const [caller, resume] of STAGES) {
    it(`E: pushed once, then deleted on GitHub: a new branch from the base (${caller})`, async () => {
      setup('pushed');
      sh(origin, 'update-ref', '-d', 'refs/heads/sdlc/foo');
      await sync(caller, resume);
      expect(onBranch()).toBe('sdlc/foo_2');
    });
    it(`E: its pull request is closed (${caller})`, async () => {
      setup('pushed');
      prState('CLOSED');
      await sync(caller, resume);
      expect(onBranch()).toBe('sdlc/foo_2');
    });
  }
  it('F: equal: nothing changes', async () => {
    setup('pushed');
    const tip = sh(repo, 'rev-parse', 'HEAD');
    await sync();
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(tip);
  });
  it('G: behind with a clean tree: fast-forward', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'app.txt', 'one\ntwo\nthree\nfour\n');
    await sync();
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(remoteTip('sdlc/foo'));
  });
  it('H: behind, dirty in a file the update does not touch: fast-forward keeps the change', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'other.txt', 'theirs\n');
    write(repo, 'app.txt', 'one\ntwo\nthree\nmine\n');
    await sync();
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(remoteTip('sdlc/foo'));
    expect(read(repo, 'app.txt')).toContain('mine');
    expect(sh(repo, 'stash', 'list')).toBe('');
  });
  it('I: behind, dirty in a file the update changes: stash, ff, reapply cleanly', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'app.txt', 'ONE\ntwo\nthree\n');
    write(repo, 'app.txt', 'one\ntwo\nTHREE\n');
    write(repo, 'new.txt', 'untracked\n');
    await sync();
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(remoteTip('sdlc/foo'));
    expect(read(repo, 'app.txt')).toBe('ONE\ntwo\nTHREE\n');
    expect(read(repo, 'new.txt')).toBe('untracked\n');
    expect(sh(repo, 'stash', 'list')).toBe('');
    expect(sh(repo, 'for-each-ref', 'refs/sdlc/stash')).toBe('');
    expect(readRecord(registryDir(repo), slug)?.stash).toBeUndefined();
  });
  it('I: a conflicting reapply is resolved by the stash-mode resolver', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'app.txt', 'ONE\ntwo\nthree\n');
    write(repo, 'app.txt', 'uno\ntwo\nthree\n');
    agent.run = c => {
      const x = c as Ctx;
      write(repo, 'app.txt', 'both\ntwo\nthree\n');
      write(repo, `${x.log}/resolve-conflicts-report.md`, 'FILE: app.txt :: combined\nVERDICT: SAFE\n');
    };
    await sync();
    expect(read(repo, 'app.txt')).toBe('both\ntwo\nthree\n');
    expect(agent.calls[0]).toContain('resolve-stash');
    expect(sh(repo, 'stash', 'list')).toBe('');
    expect(sh(repo, 'diff', '--name-only', '--cached')).toBe('');
  });
  it('I: restarting at an earlier stage than the interrupted one keeps the stash, does not reapply it, and says where it is', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'app.txt', 'ONE\ntwo\nthree\n');
    write(repo, 'app.txt', 'one\ntwo\nTHREE\n');
    ctx.priorStage = 'implement';
    await sync('spec', 'spec');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(remoteTip('sdlc/foo'));
    expect(read(repo, 'app.txt')).toBe('ONE\ntwo\nthree\n');
    const stash = readRecord(registryDir(repo), slug)?.stash;
    expect(stash?.sha).toBe(sh(repo, 'rev-parse', 'refs/stash'));
    expect(sh(repo, 'for-each-ref', 'refs/sdlc/stash')).toContain(stash!.ref);
    const out = lines.join('\n');
    expect(out).toContain(`saved in the stash ${stash!.sha}`);
    expect(stageRecoveryHint({ slug, stage: 'Spec', exitCode: 1, runOut: lines }).autoAction?.label).toBe('Apply my saved changes');
  });
  it('I: a DOUBT keeps the stash, restores a clean tree and stops', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'app.txt', 'ONE\ntwo\nthree\n');
    write(repo, 'app.txt', 'uno\ntwo\nthree\n');
    agent.run = c => write(repo, `${(c as Ctx).log}/resolve-conflicts-report.md`, 'DOUBT: not sure\nVERDICT: DOUBT\n');
    expect(await stop(sync())).toBe(1);
    expect(sh(repo, 'stash', 'list')).toContain('sdlc:foo:spec:');
    expect(sh(repo, 'status', '--porcelain', '--', '.', ':(exclude)docs/backlog/foo/logs')).toBe('');
    expect(readRecord(registryDir(repo), slug)?.stash?.sha).toBe(sh(repo, 'rev-parse', 'refs/stash'));
    expect(sh(repo, 'for-each-ref', 'refs/sdlc/stash')).not.toBe('');
    expect(lines.join('\n')).toContain('BRANCH SYNC');
  });
  it("another worktree's stash@{0} is left alone", async () => {
    setup('pushed');
    write(repo, 'keep.txt', 'theirs\n');
    sh(repo, 'stash', 'push', '-u', '-m', 'somebody elses');
    onGithub('sdlc/foo', 'app.txt', 'ONE\ntwo\nthree\n');
    write(repo, 'app.txt', 'one\ntwo\nTHREE\n');
    await sync();
    const list = sh(repo, 'stash', 'list');
    expect(list).toContain('somebody elses');
    expect(list.split('\n')).toHaveLength(1);
  });
  for (const [caller, resume] of STAGES) {
    it(`J: ahead: continues (${caller})`, async () => {
      setup('pushed');
      localCommit('mine.txt', 'x\n');
      const tip = sh(repo, 'rev-parse', 'HEAD');
      await sync(caller, resume);
      expect(sh(repo, 'rev-parse', 'HEAD')).toBe(tip);
      expect(remoteTip('sdlc/foo')).not.toBe(tip);
    });
  }
  it('K: diverged with the same patches: backup, then a lease push', async () => {
    setup('pushed');
    localCommit('mine.txt', 'x\n');
    sh(repo, 'push', '-q', 'origin', 'sdlc/foo');
    onGithub('main', 'base.txt', 'b\n');
    sh(repo, 'fetch', '-q', 'origin');
    sh(repo, 'rebase', '-q', 'origin/main');
    const tip = sh(repo, 'rev-parse', 'HEAD');
    await sync();
    expect(remoteTip('sdlc/foo')).toBe(tip);
    expect(sh(repo, 'for-each-ref', 'refs/sdlc-backup')).not.toBe('');
  });
  it('L: diverged: backup, rebase (no merge commit), lease push', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'theirs.txt', 'theirs\n');
    localCommit('mine.txt', 'x\n');
    const was = sh(repo, 'rev-parse', 'HEAD');
    await sync();
    expect(sh(repo, 'rev-list', '--merges', 'HEAD', '--count')).toBe('0');
    expect(sh(repo, 'merge-base', '--is-ancestor', 'origin/sdlc/foo', 'HEAD') ?? '').toBe('');
    expect(remoteTip('sdlc/foo')).toBe(sh(repo, 'rev-parse', 'HEAD'));
    expect(read(repo, 'theirs.txt')).toBe('theirs\n');
    expect(read(repo, 'mine.txt')).toBe('x\n');
    expect(sh(repo, 'for-each-ref', 'refs/sdlc-backup')).toContain(was.slice(0, 0));
  });
  it('L: a rebase conflict goes to the resolver in branch-sync mode', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'app.txt', 'ONE\ntwo\nthree\n');
    localCommit('app.txt', 'uno\ntwo\nthree\n');
    agent.run = c => {
      write(repo, 'app.txt', 'both\ntwo\nthree\n');
      write(repo, `${(c as Ctx).log}/resolve-conflicts-report.md`, 'FILE: app.txt :: combined\nVERDICT: SAFE\n');
    };
    await sync();
    expect(agent.calls[0]).toContain('resolve-branch-sync');
    expect(read(repo, 'app.txt')).toBe('both\ntwo\nthree\n');
    expect(remoteTip('sdlc/foo')).toBe(sh(repo, 'rev-parse', 'HEAD'));
  });
  it('L: an unresolved rebase stops and puts the branch back', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'app.txt', 'ONE\ntwo\nthree\n');
    localCommit('app.txt', 'uno\ntwo\nthree\n');
    const was = sh(repo, 'rev-parse', 'HEAD');
    agent.run = c => write(repo, `${(c as Ctx).log}/resolve-conflicts-report.md`, 'DOUBT: unsure\nVERDICT: DOUBT\n');
    expect(await stop(sync())).toBe(1);
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(was);
    expect(sh(repo, 'status', '--porcelain', '--', '.', ':(exclude)docs/backlog/foo/logs')).toBe('');
  });
  it('M: diverged and dirty: stash, rebase, push, reapply', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'theirs.txt', 'theirs\n');
    localCommit('mine.txt', 'x\n');
    write(repo, 'app.txt', 'one\ntwo\nDIRTY\n');
    await sync();
    expect(read(repo, 'app.txt')).toBe('one\ntwo\nDIRTY\n');
    expect(remoteTip('sdlc/foo')).toBe(sh(repo, 'rev-parse', 'HEAD'));
    expect(sh(repo, 'stash', 'list')).toBe('');
  });
});

describe('N and the rest', () => {
  it('N: a failed fetch goes on offline, with no rebase and no push', async () => {
    setup('pushed');
    onGithub('sdlc/foo', 'theirs.txt', 'theirs\n');
    localCommit('mine.txt', 'x\n');
    const tip = sh(repo, 'rev-parse', 'HEAD');
    const before = remoteTip('sdlc/foo');
    sh(repo, 'remote', 'set-url', 'origin', path.join(root, 'gone.git'));
    await sync();
    expect(ctx.offline).toBe(true);
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(tip);
    expect(remoteTip('sdlc/foo')).toBe(before);
    expect(lines.join('\n')).toContain('BRANCH SYNC');
    expect(errors()).toContain('branch sync');
  });
  it('a rebase left in progress is aborted first, and said so', async () => {
    setup('pushed');
    sh(repo, 'checkout', '-q', 'main');
    localCommit('app.txt', 'x\ntwo\nthree\n', 'main change');
    sh(repo, 'checkout', '-q', 'sdlc/foo');
    localCommit('app.txt', 'y\ntwo\nthree\n', 'branch change');
    spawnSync('git', ['-C', repo, 'rebase', 'main']);
    expect(fs.existsSync(path.join(repo, '.git', 'rebase-merge'))).toBe(true);
    await sync();
    expect(fs.existsSync(path.join(repo, '.git', 'rebase-merge'))).toBe(false);
    expect(onBranch()).toBe('sdlc/foo');
    expect(lines.join('\n')).toContain('aborted');
  });
  it('a detached HEAD at the branch tip is re-attached', async () => {
    setup('pushed');
    sh(repo, 'checkout', '-q', '--detach');
    await sync();
    expect(onBranch()).toBe('sdlc/foo');
  });
  it('a detached HEAD behind the branch stops, naming the sha', async () => {
    setup('pushed');
    localCommit('mine.txt', 'x\n');
    sh(repo, 'checkout', '-q', '--detach', 'HEAD~1');
    expect(await stop(sync())).toBe(1);
    expect(lines.join('\n')).toContain(sh(repo, 'rev-parse', '--short', 'HEAD'));
  });
  it('a branch checked out in another worktree makes a new branch from its tip', async () => {
    setup('pushed');
    sh(repo, 'checkout', '-q', 'main');
    const wt = path.join(root, 'wt');
    sh(repo, 'worktree', 'add', '-q', wt, 'sdlc/foo');
    await sync();
    expect(onBranch()).toBe('sdlc/foo_2');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(sh(wt, 'rev-parse', 'HEAD'));
  });
  it('changed locked tests stop the run (Restart at Implement)', async () => {
    setup('pushed');
    sh(repo, 'checkout', '-q', 'sdlc/foo');
    localCommit('test/a.test.ts', 'it\n', `[red-tests] test(${slug}): add failing tests and spec/plan docs`);
    sh(repo, 'push', '-q', 'origin', 'sdlc/foo');
    const red = sh(repo, 'rev-parse', 'HEAD');
    onGithub('sdlc/foo', 'test/a.test.ts', 'changed\n');
    Object.assign(ctx, { origRedSha: red, redSha: red, lockSha: red, layout: { testPathspecs: ['test/'] } });
    expect(await stop(sync('implement', 'implement'))).toBe(1);
    expect(lines.join('\n')).toContain('test/a.test.ts');
  });
  it('a changed spec warns and the run goes on', async () => {
    setup('pushed');
    onGithub('sdlc/foo', `docs/backlog/${slug}/specs-1.md`, 'spec edited\n');
    await sync('implement', 'implement');
    expect(lines.join('\n')).toContain('specs-1.md');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(remoteTip('sdlc/foo'));
  });
  it('Restart Implement with the CI failure on GitHub (a Sync PR commit): the local branch is brought up, ci-failure.md is there before the agent and the push works', async () => {
    setup('pushed');
    onGithub('sdlc/foo', `docs/backlog/${slug}/ci-failure.md`, 'failing on GitHub\n');
    expect(fs.existsSync(path.join(repo, `docs/backlog/${slug}/ci-failure.md`))).toBe(false);
    await sync('implement', 'implement');
    expect(read(repo, `docs/backlog/${slug}/ci-failure.md`)).toBe('failing on GitHub\n');
    localCommit('impl.txt', 'x\n');
    sh(repo, 'push', 'origin', 'sdlc/foo');
    expect(remoteTip('sdlc/foo')).toBe(sh(repo, 'rev-parse', 'HEAD'));
  });
  it('Restart Implement with the CI failure: a missing worktree is recreated, ci-failure.md is there and the push works', async () => {
    setup('pushed');
    sh(repo, 'checkout', '-q', 'main');
    sh(repo, 'branch', '-q', '-D', 'sdlc/foo');
    // The CI failure report was written before the sync (in the log folder, which sync never touches).
    write(repo, `${ctx.log}/ci-failure.md`, 'failing\n');
    await sync('implement', 'implement');
    expect(onBranch()).toBe('sdlc/foo');
    expect(read(repo, `${ctx.log}/ci-failure.md`)).toBe('failing\n');
    localCommit('impl.txt', 'x\n');
    sh(repo, 'push', 'origin', 'sdlc/foo');
    expect(remoteTip('sdlc/foo')).toBe(sh(repo, 'rev-parse', 'HEAD'));
  });
});
