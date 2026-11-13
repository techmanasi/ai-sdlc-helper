// Once a run's pull request is merged, the link the run wrote into the main checkout's brief (uncommitted) is taken out again,
// so a pull that brings the committed link is not blocked; a brief with other edits is kept.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { cleanMainBrief } from '../src/pipeline/pr-link.js';
import { clearPrCache, recordPrInBrief } from '../src/pipeline/finalise.js';
import { listCompletedTasks } from '../src/runs/completed.js';
import { runContext } from '../src/runs/index.js';
import { tmp } from './helpers.js';

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const tryGit = (cwd: string, ...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const PR = 'https://github.com/o/r/pull/99';
const OLD_PR = 'https://github.com/o/r/pull/5';
const SLUG = 'task';
const BODY = `# ${SLUG}\n\nType: feature\n`;

let saved: string | undefined;
beforeEach(() => { saved = process.env.PATH; clearPrCache(); });
afterEach(() => { process.env.PATH = saved; clearPrCache(); });

/** A main checkout with the item's brief committed and pushed to a bare origin, and a run worktree beside it with a record. */
function project() {
  const base = fs.realpathSync(tmp('clean-brief-'));
  const origin = path.join(base, 'origin.git');
  const main = path.join(base, 'main');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['init', '-q', '-b', 'main', main]);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(main, 'config', k, v);
  const rel = `${runContext(main).backlogDir}/${SLUG}/brief.md`;
  fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
  fs.writeFileSync(path.join(main, rel), BODY);
  fs.writeFileSync(path.join(main, path.dirname(rel), '..', 'index.md'), `# Backlog\n\n- [ ] \`${SLUG}\` - Feature: a task\n`);
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  git(main, 'remote', 'add', 'origin', origin);
  git(main, 'push', '-q', '-u', 'origin', 'main');
  const wt = path.join(base, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', `sdlc/${SLUG}`, wt);
  const reg = path.join(main, '.git', 'sdlc-runs');
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, `${SLUG}.json`), JSON.stringify({ slug: SLUG, worktree: wt, root: main, pid: 0, started: '2026-11-14T10:00:00', state: 'exited', exit_code: '0', interrupted: false, finished: '', message: '', branch: `sdlc/${SLUG}`, base: 'main' }));
  // The run linked its pull request in the main checkout's brief too (linkPrEverywhere): uncommitted there.
  const file = path.join(main, rel);
  fs.writeFileSync(file, recordPrInBrief(BODY, PR));
  return { base, origin, main, wt, rel, file };
}

/** cleanMainBrief on <p>'s brief, with what it said and kept. */
function clean(p: ReturnType<typeof project>, mergedPr = PR) {
  const out: string[] = [];
  const kept: Array<[string, string]> = [];
  const r = cleanMainBrief({ root: p.main, rel: p.rel, mergedPr, keepError: (w, t) => { kept.push([w, t]); }, out: l => { out.push(l); } });
  return { r, out, kept };
}

describe('cleanMainBrief', () => {
  test('only the link changed and its pull request is merged: the brief is checked out again and the checkout is clean', () => {
    const p = project();
    const c = clean(p);
    expect(c.r).toBe('restored');
    expect(fs.readFileSync(p.file, 'utf8')).toBe(BODY);
    expect(git(p.main, 'status', '--porcelain')).toBe('');
    expect(c.out).toEqual([`Restored ${p.file}: its only change was the link to ${PR}, which is merged`]);
    expect(c.kept).toEqual([]);
  });

  test('the link and an edit of the user\'s: the brief is kept as it is, and one line says why', () => {
    const p = project();
    const edited = `${fs.readFileSync(p.file, 'utf8')}\nA note of mine.\n`;
    fs.writeFileSync(p.file, edited);
    const c = clean(p);
    expect(c.r).toBe('kept');
    expect(fs.readFileSync(p.file, 'utf8')).toBe(edited);
    expect(c.out).toEqual([`Kept ${p.file} as it is: it has edits besides the pull request link, so the link was not taken out (the pull request ${PR} is merged)`]);
    // Asked again in the same state: nothing more is said.
    expect(clean(p).out).toEqual([]);
  });

  test('an unmodified brief, and a brief whose link is another pull request\'s: nothing is done', () => {
    const p = project();
    git(p.main, 'commit', '-q', '-am', 'the link, committed');
    expect(clean(p)).toMatchObject({ r: 'none', out: [] });
    const q = project();
    // A moved run: the brief names its current pull request; only that one's merge cleans it.
    expect(clean(q, OLD_PR)).toMatchObject({ r: 'none', out: [] });
    expect(fs.readFileSync(q.file, 'utf8')).toBe(recordPrInBrief(BODY, PR));
  });

  test('git refuses the checkout: git\'s message is kept and one line says the brief was not cleaned', () => {
    const p = project();
    fs.writeFileSync(path.join(p.main, '.git', 'index.lock'), '');
    const c = clean(p);
    fs.rmSync(path.join(p.main, '.git', 'index.lock'));
    expect(c.r).toBe('none');
    expect(c.kept).toHaveLength(1);
    expect(c.kept[0][1]).toMatch(/index\.lock/);
    expect(c.out).toEqual([`WARNING: could not clean the pull request link out of ${p.file} (git checkout failed; see errors.log)`]);
    expect(fs.readFileSync(p.file, 'utf8')).toBe(recordPrInBrief(BODY, PR));
  });

  test('after the cleanup, a pull that brings the committed link goes through', () => {
    const p = project();
    // The merge brought the brief with the link onto origin's main.
    const other = path.join(p.base, 'other');
    spawnSync('git', ['clone', '-q', p.origin, other]);
    for (const [k, v] of [['user.name', 'o'], ['user.email', 'o@o']]) git(other, 'config', k, v);
    fs.writeFileSync(path.join(other, p.rel), recordPrInBrief(BODY, PR));
    fs.appendFileSync(path.join(other, p.rel), '\nMerged.\n');
    git(other, 'commit', '-q', '-am', 'merge the task');
    git(other, 'push', '-q', 'origin', 'main');
    // With the link still uncommitted here, the pull is refused.
    expect(tryGit(p.main, 'pull', '-q', '--ff-only', 'origin', 'main').status).not.toBe(0);
    expect(clean(p).r).toBe('restored');
    expect(tryGit(p.main, 'pull', '-q', '--ff-only', 'origin', 'main').status).toBe(0);
    expect(fs.readFileSync(p.file, 'utf8')).toContain(`pr: ${PR}`);
  });
});

describe('the completed tasks list cleans a merged run\'s brief, and only a merged one\'s', () => {
  function fakeGh(p: ReturnType<typeof project>, state: 'OPEN' | 'MERGED'): void {
    const bin = path.join(p.base, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr view" ]; then echo '${JSON.stringify({ url: PR, state, number: 99 })}'; exit 0; fi\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${saved}`;
  }

  test('an open pull request: the brief keeps the link', () => {
    const p = project();
    fakeGh(p, 'OPEN');
    listCompletedTasks(runContext(p.main));
    expect(fs.readFileSync(p.file, 'utf8')).toBe(recordPrInBrief(BODY, PR));
  });

  test('a merged pull request: the brief is checked out again', () => {
    const p = project();
    fakeGh(p, 'MERGED');
    const tasks = listCompletedTasks(runContext(p.main));
    expect(tasks.map(t => [t.slug, t.prState])).toEqual([[SLUG, 'MERGED']]);
    expect(fs.readFileSync(p.file, 'utf8')).toBe(BODY);
    expect(git(p.main, 'status', '--porcelain')).toBe('');
  });
});
