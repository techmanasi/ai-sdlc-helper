// A run's pull request link, kept in its brief: in the run's worktree and in the checkout the run was started from.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../runs/records.js';
import type { Ctx } from './context.js';
import { keepError } from './errors.js';
import { spawnSync } from '../trace.js';
import { clearPrInBrief, getPrFromBrief, recordPrInBrief } from './finalise.js';

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Records <url> as the run's pull request in <docs>/brief.md here and in the main checkout's copy (the project the run was
 * started from), replacing any older link. A brief that is missing there is left alone; one that already holds <url> is
 * not written. A failure to write is kept in errors.log and said in one line: it never stops the run.
 */
export function linkPrEverywhere(ctx: Pick<Ctx, 'root' | 'docs' | 'log' | 'env' | 'out'>, url: string): void {
  const rel = path.join(ctx.docs, 'brief.md');
  const files = [path.join(ctx.root, rel)];
  let main: string | null = null;
  try { main = projectRoot(ctx.root, ctx.env); } catch (e) {
    keepError(ctx, 'link pull request: find the main checkout', (e as Error).message);
    ctx.out(`WARNING: could not find the main checkout to link ${url} in its brief (see ${ctx.log}/errors.log)`);
  }
  if (main && real(main) !== real(ctx.root)) files.push(path.join(main, rel));
  for (const file of files) {
    let text: string;
    // A checkout without this brief has nothing to link.
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (getPrFromBrief(text) === url) continue;
    // Whole or not at all: a temporary file beside it, renamed over it (an editor or the user may have the main checkout's open).
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, recordPrInBrief(text, url), { mode: fs.statSync(file).mode & 0o777 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was left to remove */ }
      keepError(ctx, 'link pull request in the brief', `${file}: ${(e as Error).message}`);
      ctx.out(`WARNING: could not write the pull request link into ${file} (see ${ctx.log}/errors.log)`);
    }
  }
}

/** Briefs already looked at in this state (file, mtime, size, pull request): a board that polls asks git about each once. */
const looked = new Set<string>();

export interface CleanMainBrief {
  /** The main checkout, and the brief's path from it. */
  root: string;
  rel: string;
  /** The pull request that is merged: only a brief whose link is this one is cleaned. */
  mergedPr: string;
  env?: NodeJS.ProcessEnv;
  /** Keeps git's whole message when a step fails (errors.log). */
  keepError(where: string, text: string): void;
  /** One plain line for the output. */
  out(line: string): void;
}

/**
 * Once the run's pull request is merged, takes the link linkPrEverywhere wrote out of the main checkout's brief, so a pull that
 * brings the committed link is not blocked: when the brief's only change from HEAD is the pull request link, it is checked out
 * again. A brief with other edits is kept, and said so. Nothing else in the main checkout is touched and nothing is committed.
 */
export function cleanMainBrief(o: CleanMainBrief): 'restored' | 'kept' | 'none' {
  const file = path.join(o.root, o.rel);
  let text: string;
  let key: string;
  try {
    text = fs.readFileSync(file, 'utf8');
    const st = fs.statSync(file);
    key = `${file}\0${st.mtimeMs}\0${st.size}\0${o.mergedPr}`;
  } catch { return 'none'; } // no brief in the main checkout: nothing to clean
  // Only the merged pull request's own link (a moved run's brief names its current one): an older one is not this merge's.
  if (getPrFromBrief(text) !== o.mergedPr || looked.has(key)) return 'none';
  const git = (...args: string[]) => spawnSync('git', ['-C', o.root, ...args], { encoding: 'utf8', env: o.env || process.env });
  const failed = (what: string, r: { status: number | null; stderr?: unknown; error?: Error }): 'none' => {
    o.keepError(`clean the main checkout's brief: git ${what}`, `${file}: git ${what} ${r.error ? `could not run: ${r.error.message}` : `exited with ${r.status}`}: ${String(r.stderr || '').trim() || '(no output)'}`);
    o.out(`WARNING: could not clean the pull request link out of ${file} (git ${what} failed; see errors.log)`);
    return 'none';
  };
  const status = git('status', '--porcelain', '--', o.rel);
  if (status.status !== 0) return failed('status', status);
  // Unmodified (or untracked): nothing of ours to take out.
  if (!status.stdout.trim() || status.stdout.startsWith('??')) { looked.add(key); return 'none'; }
  const head = git('show', `HEAD:${o.rel}`);
  if (head.status !== 0) return failed('show', head);
  if (clearPrInBrief(text).trim() !== clearPrInBrief(head.stdout).trim()) {
    looked.add(key);
    o.out(`Kept ${file} as it is: it has edits besides the pull request link, so the link was not taken out (the pull request ${o.mergedPr} is merged)`);
    return 'kept';
  }
  const restore = git('checkout', '--', o.rel);
  if (restore.status !== 0) return failed('checkout', restore);
  o.out(`Restored ${file}: its only change was the link to ${o.mergedPr}, which is merged`);
  return 'restored';
}

/** cleanMainBrief for a pipeline run whose pull request <url> is merged: the main checkout's brief, when that is not this checkout. */
export function cleanRunMainBrief(ctx: Pick<Ctx, 'root' | 'docs' | 'log' | 'env' | 'out'>, url: string): void {
  let main: string;
  try { main = projectRoot(ctx.root, ctx.env); } catch (e) {
    keepError(ctx, 'clean the main checkout\'s brief: find the main checkout', (e as Error).message);
    ctx.out(`WARNING: could not find the main checkout to clean the pull request link out of its brief (see ${ctx.log}/errors.log)`);
    return;
  }
  // A run in the main checkout itself: its brief is the run's own, committed with the link.
  if (real(main) === real(ctx.root)) return;
  cleanMainBrief({ root: main, rel: path.join(ctx.docs, 'brief.md'), mergedPr: url, env: ctx.env, keepError: (w, t) => keepError(ctx, w, t), out: l => ctx.out(l) });
}
