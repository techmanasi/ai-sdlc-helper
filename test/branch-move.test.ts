import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { Git } from '../src/pipeline/git.js';
import { Status } from '../src/pipeline/status.js';
import type { Ctx } from '../src/pipeline/context.js';
import { isRunBranch, moveSkipped, moveToNewBranch, nextRunBranch, openMovedPr, whyMove } from '../src/pipeline/branch-move.js';
import { clearPrCache, getPrFromBrief } from '../src/pipeline/finalise.js';

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
    `if [ "$1 $2" = "pr create" ]; then echo "$@" >> "$GHDIR/create.log"; echo ${NEW_PR}; exit 0; fi`,
    'exit 1', '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.GHDIR = ghDir;
  spawnSync('git', ['init', '-q', '--bare', origin]);
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
  it('knows the run branch and its numbered moves', () => {
    expect(isRunBranch('sdlc/foo', 'sdlc/', 'foo')).toBe(true);
    expect(isRunBranch('sdlc/foo-2', 'sdlc/', 'foo')).toBe(true);
    expect(isRunBranch('feature/foo-12', 'feature/', 'foo')).toBe(true);
    for (const b of ['sdlc/foo-bar', 'sdlc/foobar', 'main', 'sdlc/foo-']) expect(isRunBranch(b, 'sdlc/', 'foo')).toBe(false);
  });
  it('reads SDLC_MOVE_BRANCH', () => {
    expect(moveSkipped({ SDLC_MOVE_BRANCH: '0' })).toBe(true);
    expect(moveSkipped({ SDLC_MOVE_BRANCH: 'Off' })).toBe(true);
    expect(moveSkipped({})).toBe(false);
    expect(moveSkipped({ SDLC_MOVE_BRANCH: '1' })).toBe(false);
  });
});

describe('nextRunBranch', () => {
  it('takes the first free number, here and on origin', () => {
    const ctx = setup('sdlc/');
    expect(nextRunBranch(ctx.git, 'sdlc/', slug)).toBe('sdlc/foo-2');
    // -2 only on origin (pushed from a second branch, then deleted here).
    sh(repo, 'branch', 'sdlc/foo-2');
    sh(repo, 'push', '-q', 'origin', 'sdlc/foo-2');
    sh(repo, 'branch', '-q', '-D', 'sdlc/foo-2');
    sh(repo, 'fetch', '-q', 'origin');
    expect(nextRunBranch(ctx.git, 'sdlc/', slug)).toBe('sdlc/foo-3');
  });
  it('goes one past the branch it is on', () => {
    const ctx = setup('feature/');
    sh(repo, 'checkout', '-q', '-b', 'feature/foo-2');
    expect(nextRunBranch(ctx.git, 'feature/', slug)).toBe('feature/foo-3');
  });
});

describe('whyMove', () => {
  it('is null with no origin, and when origin equals or is behind HEAD', () => {
    const ctx = setup('sdlc/');
    expect(whyMove(ctx)).toBeNull();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'ahead');
    expect(whyMove(ctx)).toBeNull();
    sh(repo, 'remote', 'remove', 'origin');
    expect(whyMove(ctx)).toBeNull();
  });
  it('says remote-ahead with the count after another clone pushed', () => {
    const ctx = setup('sdlc/');
    const other = path.join(root, 'other');
    spawnSync('git', ['clone', '-q', origin, other]);
    sh(other, 'config', 'user.email', 'o@example.com'); sh(other, 'config', 'user.name', 'O');
    sh(other, 'checkout', '-q', `sdlc/${slug}`);
    fs.writeFileSync(path.join(other, 'x.txt'), 'x');
    sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'theirs');
    sh(other, 'push', '-q', 'origin', `sdlc/${slug}`);
    const why = whyMove(ctx);
    expect(why?.kind).toBe('remote-ahead');
    expect(why?.detail).toContain('1 commits');
  });
  it('says pr-closed and pr-merged from gh', () => {
    const ctx = setup('sdlc/');
    fs.writeFileSync(path.join(ghDir, 'view.json'), JSON.stringify({ url: OLD_PR, state: 'CLOSED', number: 5 }));
    expect(whyMove(ctx)).toEqual({ kind: 'pr-closed', detail: OLD_PR });
    clearPrCache();
    fs.writeFileSync(path.join(ghDir, 'view.json'), JSON.stringify({ url: OLD_PR, state: 'MERGED', number: 5 }));
    expect(whyMove(ctx)).toEqual({ kind: 'pr-merged', detail: OLD_PR });
    clearPrCache();
    fs.writeFileSync(path.join(ghDir, 'view.json'), JSON.stringify({ url: OLD_PR, state: 'OPEN', number: 5 }));
    expect(whyMove(ctx)).toBeNull();
  });
  it('goes on, and keeps the error, when origin cannot be asked', () => {
    const ctx = setup('sdlc/');
    sh(repo, 'remote', 'set-url', 'origin', path.join(root, 'nowhere.git'));
    expect(whyMove(ctx)).toBeNull();
    const errors = fs.readFileSync(path.join(repo, ctx.log, 'errors.log'), 'utf8');
    expect(errors).toContain('fetch');
    expect(lines.join('\n')).toContain('going on with it');
  });
});

describe('moveToNewBranch', () => {
  it('switches to a new branch at the same commit and records the move', () => {
    const ctx = setup('sdlc/');
    const head = sh(repo, 'rev-parse', 'HEAD');
    moveToNewBranch(ctx, { kind: 'remote-ahead', detail: '2 commits on origin/sdlc/foo are not in this run' });
    expect(ctx.branch).toBe('sdlc/foo-2');
    expect(sh(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('sdlc/foo-2');
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head);
    // The old branch is intact here and on origin.
    expect(sh(repo, 'rev-parse', 'sdlc/foo')).toBe(head);
    expect(sh(origin, 'rev-parse', 'sdlc/foo')).toBe(head);
    const brief = fs.readFileSync(path.join(repo, ctx.docs, 'brief.md'), 'utf8');
    expect(getPrFromBrief(brief)).toBeNull();
    expect(brief).toContain(`# ${slug}`);
    const st = JSON.parse(fs.readFileSync(path.join(repo, ctx.log, 'status.json'), 'utf8'));
    expect(st.branch).toBe('sdlc/foo-2');
    expect(st.moved_from).toMatchObject({ branch: 'sdlc/foo', reason: 'remote-ahead', pr: OLD_PR });
    const rows = fs.readFileSync(path.join(repo, ctx.log, 'attempts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'move', from: 'sdlc/foo', to: 'sdlc/foo-2', reason: 'remote-ahead' });
    expect(lines.join('\n')).toContain('MOVED: this run continues on branch sdlc/foo-2');
  });
  it('keeps other front matter and uses the closed PR when the brief has none; works with feature/', () => {
    const ctx = setup('feature/', `---\nowner: me\n---\n\n# ${slug}\n`);
    moveToNewBranch(ctx, { kind: 'pr-closed', detail: OLD_PR });
    expect(ctx.branch).toBe('feature/foo-2');
    const brief = fs.readFileSync(path.join(repo, ctx.docs, 'brief.md'), 'utf8');
    expect(brief).toContain('owner: me');
    expect(ctx.movedFrom).toEqual({ branch: 'feature/foo', pr: OLD_PR, reason: 'pr-closed' });
  });
  it('removes a body PR line', () => {
    const ctx = setup('sdlc/', `# ${slug}\nPR: ${OLD_PR}\n`);
    moveToNewBranch(ctx, { kind: 'remote-ahead', detail: 'x' });
    expect(fs.readFileSync(path.join(repo, ctx.docs, 'brief.md'), 'utf8')).toBe(`# ${slug}\n`);
  });
});

describe('openMovedPr', () => {
  it('opens nothing when no commit is ahead of the base', async () => {
    const ctx = setup('sdlc/');
    moveToNewBranch(ctx, { kind: 'remote-ahead', detail: 'x' });
    expect(await openMovedPr(ctx)).toBeNull();
    expect(fs.existsSync(path.join(ghDir, 'create.log'))).toBe(false);
    expect(spawnSync('git', ['-C', origin, 'rev-parse', '--verify', '-q', 'sdlc/foo-2']).status).not.toBe(0);
  });
  it('pushes the new branch and opens a draft pull request that names what it replaces', async () => {
    const ctx = setup('sdlc/');
    moveToNewBranch(ctx, { kind: 'pr-merged', detail: OLD_PR });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '-m', 'work');
    expect(await openMovedPr(ctx)).toBe(NEW_PR);
    expect(sh(origin, 'rev-parse', 'sdlc/foo-2')).toBe(sh(repo, 'rev-parse', 'HEAD'));
    const created = fs.readFileSync(path.join(ghDir, 'create.log'), 'utf8');
    expect(created).toContain('--head sdlc/foo-2');
    expect(created).toContain('--draft');
    expect(created).toContain(`Replaces ${OLD_PR} (pr-merged)`);
    expect(getPrFromBrief(fs.readFileSync(path.join(repo, ctx.docs, 'brief.md'), 'utf8'))).toBe(NEW_PR);
  });
  it('does nothing for a run that did not move', async () => {
    const ctx = setup('sdlc/');
    expect(await openMovedPr(ctx)).toBeNull();
  });
});
