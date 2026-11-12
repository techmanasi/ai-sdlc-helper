import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { backlogItems } from '../src/backlog/index.js';
import { branchNameInputs, commonDirOf } from '../src/gitdir.js';
import { mainTree } from '../src/runs/records.js';
import { tmp } from './helpers.js';

const savedPath = process.env.PATH;
const ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
afterEach(() => { process.env.PATH = savedPath; });

/** A repository with three backlog items, and a git on PATH that logs its arguments before running the real one. */
function fixture() {
  const base = fs.realpathSync(tmp('branch-names-'));
  const root = path.join(base, 'repo');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const git = (...args: string[]) => {
    const r = spawnSync(real, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...ENV } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  fs.mkdirSync(path.join(root, 'Docs/backlog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Docs/backlog/index.md'), '# Backlog\n\n- [ ] `one` - Feature: One\n- [ ] `two` - Feature: Two\n- [ ] `three` - Feature: Three\n');
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(base, 'git-calls.txt');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${savedPath}`;
  const asked = (what: string): number => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(l => l.includes(what)).length; } catch { return 0; } };
  const place = { root, backlogDir: 'Docs/backlog', branchPrefix: 'sdlc/' };
  const inProgress = (keep: boolean): string[] => backlogItems(place, { keepBranches: keep })!.items.filter(i => i.status === 'in-progress').map(i => i.slug).sort();
  return { base, root, git, asked, place, inProgress };
}

describe('the kept branch names', () => {
  test('are read once while the refs do not change, and every time without the option', () => {
    const f = fixture();
    expect(f.inProgress(true)).toEqual([]);
    expect(f.inProgress(true)).toEqual([]);
    expect(f.inProgress(true)).toEqual([]);
    expect(f.asked('for-each-ref')).toBe(1);
    expect(f.inProgress(false)).toEqual([]);
    expect(f.inProgress(false)).toEqual([]);
    expect(f.asked('for-each-ref')).toBe(3);
  });

  test('a new branch under the prefix folder, a packed one, an origin one and a deleted one each show on the next read', () => {
    const f = fixture();
    expect(f.inProgress(true)).toEqual([]);
    // The first branch makes the folder refs/heads/sdlc; the second only adds a file inside it.
    f.git('branch', 'sdlc/one');
    expect(f.inProgress(true)).toEqual(['one']);
    f.git('branch', 'sdlc/two');
    expect(f.inProgress(true)).toEqual(['one', 'two']);
    // Packed: the loose files go, the names stay; a branch that exists only in packed-refs is still found.
    f.git('pack-refs', '--all');
    expect(f.inProgress(true)).toEqual(['one', 'two']);
    f.git('update-ref', 'refs/remotes/origin/sdlc/three', 'HEAD');
    expect(f.inProgress(true)).toEqual(['one', 'three', 'two']);
    f.git('branch', '-D', 'sdlc/one');
    expect(f.inProgress(true)).toEqual(['three', 'two']);
    // A new commit moves a branch through a lock file in its folder: one more read at most, and the same names.
    f.git('commit', '-q', '--allow-empty', '-m', 'more');
    expect(f.inProgress(true)).toEqual(['three', 'two']);
    const settled = f.asked('for-each-ref');
    expect(f.inProgress(true)).toEqual(['three', 'two']);
    expect(f.asked('for-each-ref')).toBe(settled);
  });

  test('the files watched for a prefix are the packed refs, both ref folders and the prefix folders under each', () => {
    const rel = (prefix: string) => branchNameInputs('/g', prefix).map(p => p.slice(3));
    expect(rel('sdlc/')).toEqual(['packed-refs', 'refs/heads', 'refs/heads/sdlc', 'refs/remotes/origin', 'refs/remotes/origin/sdlc']);
    expect(rel('task-')).toEqual(['packed-refs', 'refs/heads', 'refs/remotes/origin']);
    expect(rel('team/sdlc/')).toEqual(['packed-refs', 'refs/heads', 'refs/heads/team', 'refs/heads/team/sdlc', 'refs/remotes/origin', 'refs/remotes/origin/team', 'refs/remotes/origin/team/sdlc']);
  });
});

describe('the git folder of a checkout, from files alone', () => {
  test('a main checkout, a worktree of it, and a folder that is neither', () => {
    const f = fixture();
    const wt = path.join(f.base, 'wt');
    f.git('worktree', 'add', '-q', wt, '-b', 'sdlc/one');
    const before = f.asked('');
    expect(commonDirOf(f.root)).toBe(path.join(f.root, '.git'));
    expect(commonDirOf(wt)).toBe(path.join(f.root, '.git'));
    expect(commonDirOf(f.base)).toBeNull();
    expect(f.asked('')).toBe(before);
  });

  test('the kept main working tree is asked for once, from the checkout and from its worktree', () => {
    const f = fixture();
    const wt = path.join(f.base, 'wt');
    f.git('worktree', 'add', '-q', wt, '-b', 'sdlc/one');
    for (let i = 0; i < 3; i++) expect(mainTree(f.root, process.env, { keep: true })).toBe(f.root);
    expect(f.asked('worktree list')).toBe(1);
    for (let i = 0; i < 3; i++) expect(mainTree(wt, process.env, { keep: true })).toBe(f.root);
    expect(f.asked('worktree list')).toBe(2);
    expect(mainTree(f.root)).toBe(f.root);
    expect(f.asked('worktree list')).toBe(3);
  });
});
