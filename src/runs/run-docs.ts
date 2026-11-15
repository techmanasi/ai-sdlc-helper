// The files "Sync PR" brings into a run's docs (pr-comments.md, ci-failure.md): kept in the run's own checkout and committed
// on the run's branch, like the pull request link. The main checkout (the project the run was started from) is never written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from '../trace.js';
import { commitRunDoc } from '../pipeline/pr-link.js';
import { keepError } from '../pipeline/errors.js';
import { isRunning, readRecord } from './records.js';
import { liveBranch, runWorktree, type RunContext } from './index.js';

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

const gitIn = (cwd: string, env: NodeJS.ProcessEnv) => (...args: string[]): string => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr || r.stdout || r.error?.message || '(no output)').trim()}`);
  return String(r.stdout);
};

/** The run's own checkout: its worktree, never the main checkout (a run in the main checkout itself has none here). */
function ownWorktree(ctx: RunContext, slug: string): string | null {
  const wt = runWorktree(ctx, slug);
  return wt && real(wt) !== real(ctx.root) ? wt : null;
}

export interface SaveRunDoc {
  /** The file's name in <backlogDir>/<slug>/. */
  file: string;
  /** Its new text; null removes it. */
  text: string | null;
  /** The commit message. */
  message: string;
  /** What it is, for the error lines ("the PR comments"). */
  what: string;
  /** The PR's state when known: a merged or closed PR's branch gets nothing. */
  prState?: string | null;
}

export interface SavedRunDoc {
  /** Where the file went: committed on the branch, left in the running run's worktree, or nowhere. */
  where: 'committed' | 'worktree' | 'unchanged' | 'none';
  /** One line for the result when the file was not committed (why). */
  note?: string;
  /** Error lines, each also kept in errors.log. */
  err: string[];
}

/**
 * Saves <o.file> for <slug> on the run's branch (see SaveRunDoc):
 * - a worktree of a run that is not running: written there, committed (only that file) and pushed;
 * - a worktree of a running run: written there only (its next docs commit takes it);
 * - no worktree, the branch on origin and the PR neither merged nor closed: committed through a temporary worktree of
 *   origin's branch in the system temp folder, pushed, and the temporary worktree removed;
 * - otherwise nothing is written.
 * No change from what the branch holds makes no commit. Every failure goes to errors.log (the worktree's, else the run
 * registry's) and into <err>; this never throws.
 */
export function saveRunDoc(ctx: RunContext, slug: string, o: SaveRunDoc): SavedRunDoc {
  const rec = readRecord(ctx.reg, slug);
  const wt = ownWorktree(ctx, slug);
  const where = wt ? { root: wt, log: path.join(ctx.backlogDir, slug, 'logs') } : { root: ctx.reg, log: '' };
  const see = path.join(where.root, where.log, 'errors.log');
  const rel = path.join(ctx.backlogDir, slug, o.file);
  const err: string[] = [];
  const fail = (step: string, text: string): SavedRunDoc => {
    keepError(where, `Sync PR: ${step} ${o.what}`, text);
    err.push(`Could not ${step} ${o.what} (${o.file}): ${text.split('\n')[0]} (see ${see})`);
    return { where: 'none', err };
  };
  const put = (dir: string): string | null => {
    const file = path.join(dir, rel);
    try {
      if (o.text === null) fs.rmSync(file, { force: true });
      else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, o.text); }
      return null;
    } catch (e) { return `${file}: ${(e as Error).message}`; }
  };
  const branch = liveBranch(ctx, slug, rec);
  const checkout = (git: (...a: string[]) => string, pushRef?: string) => ({
    git, branch, ...(pushRef ? { pushRef } : {}), see,
    keepError: (w: string, t: string) => keepError(where, `Sync PR: ${w}`, t),
    warn: () => { /* the lines are returned in err */ },
  });

  if (wt) {
    const bad = put(wt);
    if (bad) return fail(o.text === null ? 'remove' : 'write', bad);
    if (isRunning(rec)) return { where: 'worktree', note: `${slug} is running: ${o.file} is in its worktree, and the run's next commit takes it`, err };
    const c = commitRunDoc(checkout(gitIn(wt, ctx.env)), [rel], o.message, o.what);
    return { where: c.committed ? 'committed' : 'unchanged', err: c.err };
  }

  if (isRunning(rec)) return { where: 'none', note: `${slug} is running in the main checkout: ${o.file} was not written`, err };
  if (o.prState === 'MERGED' || o.prState === 'CLOSED') return { where: 'none', note: `the pull request is ${o.prState.toLowerCase()}: ${o.file} was not written`, err };
  const git = gitIn(ctx.root, ctx.env);
  let onOrigin: string;
  try { onOrigin = git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`).trim(); } catch (e) { return fail('find the branch for', (e as Error).message); }
  if (!onOrigin) return { where: 'none', note: `${slug} has no worktree and ${branch} is not on origin: ${o.file} was not written`, err };
  try { git('fetch', '-q', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); } catch (e) { return fail('fetch the branch for', (e as Error).message); }
  // What origin's branch holds already: the same makes no commit, and needs no temporary worktree.
  let held: string | null;
  try { held = git('show', `origin/${branch}:${rel.split(path.sep).join('/')}`); } catch { held = null; }
  if (held === o.text) return { where: 'unchanged', err };

  let tmp = '';
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-sync-${slug}-`));
    try { git('worktree', 'add', '-q', '--detach', tmp, `origin/${branch}`); } catch (e) { return fail('check out the branch for', (e as Error).message); }
    const bad = put(tmp);
    if (bad) return fail(o.text === null ? 'remove' : 'write', bad);
    const c = commitRunDoc(checkout(gitIn(tmp, ctx.env), `HEAD:refs/heads/${branch}`), [rel], o.message, o.what);
    return { where: c.committed ? 'committed' : 'unchanged', err: c.err };
  } catch (e) {
    return fail('save', (e as Error).message);
  } finally {
    if (tmp) {
      const r = spawnSync('git', ['-C', ctx.root, 'worktree', 'remove', '--force', tmp], { encoding: 'utf8', env: ctx.env });
      if (r.status !== 0) {
        keepError(where, `Sync PR: remove the temporary worktree ${tmp}`, String(r.stderr || r.error?.message || '(no output)'));
        err.push(`Could not remove the temporary worktree ${tmp} (see ${see})`);
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* git removed it */ }
    }
  }
}

/** Ref files whose change can change what a branch holds: a cheap stamp, so the board asks git only when one moved. */
function refStamp(ctx: RunContext, branch: string): string {
  const common = path.dirname(ctx.reg);
  return [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`, 'packed-refs'].map(r => {
    try { const st = fs.statSync(path.join(common, r)); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; }
  }).join('|');
}

const shown = new Map<string, { stamp: string; text: string | null }>();

/**
 * A run doc's text for the views: the run's worktree's copy first, else what the run's branch holds (origin's, else the local
 * branch's), else the main checkout's copy (a merged PR brought it there). Null when none has it.
 */
export function readRunDoc(ctx: RunContext, slug: string, file: string): string | null {
  const wt = runWorktree(ctx, slug);
  if (wt) {
    try { return fs.readFileSync(path.join(wt, ctx.backlogDir, slug, file), 'utf8'); } catch { /* not in the worktree */ }
  }
  const branch = liveBranch(ctx, slug);
  const rel = [ctx.backlogDir.split(path.sep).join('/'), slug, file].join('/');
  const key = `${ctx.root}\0${branch}\0${rel}`;
  const stamp = refStamp(ctx, branch);
  let hit = shown.get(key);
  if (!hit || hit.stamp !== stamp) {
    let text: string | null = null;
    for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
      const r = spawnSync('git', ['-C', ctx.root, 'show', `${ref}:${rel}`], { encoding: 'utf8', env: ctx.env, maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 0) { text = String(r.stdout); break; }
    }
    hit = { stamp, text };
    shown.set(key, hit);
  }
  if (hit.text !== null) return hit.text;
  try { return fs.readFileSync(path.join(ctx.root, ctx.backlogDir, slug, file), 'utf8'); } catch { return null; }
}
