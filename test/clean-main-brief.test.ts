// Once a run's pull request is merged, the link the run wrote into the main checkout's brief (uncommitted) is taken out again,
// so a pull that brings the committed link is not blocked; a brief with other edits is kept.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanMainBrief } from '../src/pipeline/pr-link.js';
import { clearPrCache, recordPrInBrief } from '../src/pipeline/finalise.js';
import { completedListAsync, listCompletedTasks, settleBriefCleanups, warmCompletedPrs } from '../src/runs/completed.js';
import { clearNotices } from '../src/runs/notices.js';
import { boardView } from '../src/runs/view.js';
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
beforeEach(() => { saved = process.env.PATH; clearPrCache(); clearNotices(); });
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
async function clean(p: ReturnType<typeof project>, mergedPr = PR) {
  const out: string[] = [];
  const kept: Array<[string, string]> = [];
  const r = await cleanMainBrief({ root: p.main, rel: p.rel, mergedPr, keepError: (w, t) => { kept.push([w, t]); }, out: l => { out.push(l); } });
  return { r, out, kept };
}

describe('cleanMainBrief', () => {
  test('only the link changed and its pull request is merged: the brief is checked out again and the checkout is clean', async () => {
    const p = project();
    const c = await clean(p);
    expect(c.r).toBe('restored');
    expect(fs.readFileSync(p.file, 'utf8')).toBe(BODY);
    expect(git(p.main, 'status', '--porcelain')).toBe('');
    expect(c.out).toEqual([`Restored ${p.file}: its only change was the link to ${PR}, which is merged`]);
    expect(c.kept).toEqual([]);
  });

  test('the link and an edit of the user\'s: the brief is kept as it is, and one line says why', async () => {
    const p = project();
    const edited = `${fs.readFileSync(p.file, 'utf8')}\nA note of mine.\n`;
    fs.writeFileSync(p.file, edited);
    const c = await clean(p);
    expect(c.r).toBe('kept');
    expect(fs.readFileSync(p.file, 'utf8')).toBe(edited);
    expect(c.out).toEqual([`Kept ${p.file} as it is: it has edits besides the pull request link, so the link was not taken out (the pull request ${PR} is merged)`]);
    // Asked again in the same state: nothing more is said.
    expect((await clean(p)).out).toEqual([]);
  });

  test('an unmodified brief, and a brief whose link is another pull request\'s: nothing is done', async () => {
    const p = project();
    git(p.main, 'commit', '-q', '-am', 'the link, committed');
    expect(await clean(p)).toMatchObject({ r: 'none', out: [] });
    const q = project();
    // A moved run: the brief names its current pull request; only that one's merge cleans it.
    expect(await clean(q, OLD_PR)).toMatchObject({ r: 'none', out: [] });
    expect(fs.readFileSync(q.file, 'utf8')).toBe(recordPrInBrief(BODY, PR));
  });

  test('git refuses the checkout: git\'s message is kept and one line says the brief was not cleaned', async () => {
    const p = project();
    fs.writeFileSync(path.join(p.main, '.git', 'index.lock'), '');
    const c = await clean(p);
    fs.rmSync(path.join(p.main, '.git', 'index.lock'));
    expect(c.r).toBe('none');
    expect(c.kept).toHaveLength(1);
    expect(c.kept[0][1]).toMatch(/index\.lock/);
    expect(c.out).toEqual([`WARNING: could not clean the pull request link out of ${p.file} (git checkout failed; see errors.log)`]);
    expect(fs.readFileSync(p.file, 'utf8')).toBe(recordPrInBrief(BODY, PR));
  });

  test('after the cleanup, a pull that brings the committed link goes through', async () => {
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
    expect((await clean(p)).r).toBe('restored');
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

  test('an open pull request: the brief keeps the link', async () => {
    const p = project();
    fakeGh(p, 'OPEN');
    listCompletedTasks(runContext(p.main));
    await settleBriefCleanups();
    expect(fs.readFileSync(p.file, 'utf8')).toBe(recordPrInBrief(BODY, PR));
  });

  test('a merged pull request: the brief is checked out again', async () => {
    const p = project();
    fakeGh(p, 'MERGED');
    const tasks = listCompletedTasks(runContext(p.main));
    // The cleanup runs after the list is answered, never inside it.
    expect(fs.readFileSync(p.file, 'utf8')).toBe(recordPrInBrief(BODY, PR));
    await settleBriefCleanups();
    expect(tasks.map(t => [t.slug, t.prState])).toEqual([[SLUG, 'MERGED']]);
    expect(fs.readFileSync(p.file, 'utf8')).toBe(BODY);
    expect(git(p.main, 'status', '--porcelain')).toBe('');
  });
});

describe('what a cleanup says reaches the next list and board', () => {
  function fakeGh(p: ReturnType<typeof project>): void {
    const bin = path.join(p.base, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr view" ]; then echo '${JSON.stringify({ url: PR, state: 'MERGED', number: 99 })}'; exit 0; fi\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${saved}`;
  }

  test('a brief kept for its edits: the Completed list that follows carries a notice, and so does the board', async () => {
    const p = project();
    fakeGh(p);
    fs.writeFileSync(p.file, `${recordPrInBrief(BODY, PR)}\nMy own edit.\n`);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const first = await completedListAsync(runContext(p.main));
      expect(first.notices).toBeUndefined(); // the cleanup runs after this answer
      await settleBriefCleanups();
      expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('Kept');
      const next = await completedListAsync(runContext(p.main));
      expect(next.notices).toHaveLength(1);
      expect(next.notices?.[0]).toMatchObject({ slug: SLUG, level: 'info' });
      expect(next.notices?.[0].text).toContain('it has edits besides the pull request link');
      expect(next.notices?.[0].id).toBeTruthy();
      expect(boardView(runContext(p.main), { changes: false }).notices?.map(n => n.id)).toEqual([next.notices?.[0].id]);
    } finally { err.mockRestore(); }
  });

  test('a restored brief says so too', async () => {
    const p = project();
    fakeGh(p);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await completedListAsync(runContext(p.main));
      await settleBriefCleanups();
      const next = await completedListAsync(runContext(p.main));
      expect(next.notices?.[0].text).toContain('Restored');
    } finally { err.mockRestore(); }
  });
});

describe('gh is not installed', () => {
  /** A PATH with git and nothing else (no gh). */
  function gitOnly(p: ReturnType<typeof project>): void {
    const bin = path.join(p.base, 'git-only');
    fs.mkdirSync(bin, { recursive: true });
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(real, path.join(bin, 'git'));
    process.env.PATH = bin;
  }
  const errorsLog = (p: ReturnType<typeof project>): string => {
    const f = path.join(p.main, runContext(p.main).backlogDir, SLUG, 'logs', 'errors.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  };

  test('the start-up warm-up skips with no-gh', async () => {
    const p = project();
    git(p.main, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    gitOnly(p);
    expect(await warmCompletedPrs(runContext(p.main))).toEqual({ skipped: 'no-gh' });
  });

  test('the Completed list answers a failed check for a task with a PR link, and keeps the message in errors.log', async () => {
    const p = project();
    gitOnly(p);
    const list = await completedListAsync(runContext(p.main));
    expect(list.prErrors).toHaveLength(1);
    expect(list.prErrors?.[0]).toMatchObject({ slug: SLUG, pr: PR });
    expect(list.prErrors?.[0].message).toMatch(/ENOENT|gh/);
    expect(errorsLog(p)).toMatch(/ENOENT|gh/);
  });
});
