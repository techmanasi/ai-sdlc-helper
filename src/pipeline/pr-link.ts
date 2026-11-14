// A run's pull request link, kept in its brief in the run's own checkout and committed on the run's branch. The main checkout
// (the project the run was started from) is never written: the link reaches it with the pull request when that merges.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../runs/records.js';
import type { Ctx } from './context.js';
import { keepError } from './errors.js';
import { execFileAsync } from '../trace.js';
import { clearPrInBrief, getPrFromBrief, recordPrInBrief } from './finalise.js';

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Records <url> as the run's pull request in <docs>/brief.md of the run's checkout, replacing any older link. A missing brief
 * is left alone; one that already holds <url> is not written. A failure to write is kept in errors.log and said in one line:
 * it never stops the run. Returns whether the brief holds <url> now.
 */
export function linkPrInBrief(ctx: Pick<Ctx, 'root' | 'docs' | 'log' | 'env' | 'out'>, url: string): boolean {
  const file = path.join(ctx.root, ctx.docs, 'brief.md');
  let text: string;
  // A checkout without this brief has nothing to link.
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (getPrFromBrief(text) === url) return true;
  // Whole or not at all: a temporary file beside it, renamed over it.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, recordPrInBrief(text, url), { mode: fs.statSync(file).mode & 0o777 });
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was left to remove */ }
    keepError(ctx, 'link pull request in the brief', `${file}: ${(e as Error).message}`);
    ctx.out(`WARNING: could not write the pull request link into ${file} (see ${ctx.log}/errors.log)`);
    return false;
  }
}

/**
 * A pull request was opened or replaced for the run: its link goes into the brief (linkPrInBrief) and is committed on the run's
 * branch at once, as its own commit, and pushed, so no later stage's commit carries it and no checkout keeps it uncommitted.
 * A brief that already has the link committed makes no commit. A failed commit or push is kept in errors.log and said in one
 * WARNING line: it never stops the run (the next push takes a commit that was not pushed).
 */
export function commitPrLink(ctx: Pick<Ctx, 'root' | 'docs' | 'log' | 'env' | 'out' | 'git' | 'slug' | 'branch'>, url: string): void {
  if (!linkPrInBrief(ctx, url)) return;
  commitRunDoc({
    git: (...a) => ctx.git.run(...a),
    branch: ctx.branch,
    keepError: (where, text) => keepError(ctx, where, text),
    warn: l => ctx.out(l),
    see: `${ctx.log}/errors.log`,
  }, [`${ctx.docs}/brief.md`], `chore(${ctx.slug}): link pull request`, 'the pull request link');
}

/** What commitRunDoc needs of the checkout it commits in. */
export interface RunDocCheckout {
  /** Runs git in the checkout; throws with git's message when it fails. */
  git(...args: string[]): string;
  /** The run's branch, pushed to origin. */
  branch: string;
  /** What to push (default: <branch>); a detached checkout pushes HEAD:refs/heads/<branch>. */
  pushRef?: string;
  /** Keeps git's whole message (errors.log). */
  keepError(where: string, text: string): void;
  /** One WARNING line for the output. */
  warn(line: string): void;
  /** Where the kept message is, for the WARNING line. */
  see: string;
}

/**
 * Commits <relFiles> (paths from the checkout's top; a removed tracked file is committed as removed) on the checkout's branch
 * as one commit with <message>, only those paths, and pushes it to origin. Files with no change from HEAD make no commit. A
 * failed commit or push is kept (keepError) and said in one WARNING line, which is also returned in <err>: it never throws.
 */
export function commitRunDoc(o: RunDocCheckout, relFiles: string[], message: string, what: string): { committed: boolean; pushed: boolean; err: string[] } {
  const shown = relFiles.join(', ');
  const warn = (line: string) => { o.warn(line); return line; };
  let changed: string[];
  try {
    const status = o.git('status', '--porcelain', '--', ...relFiles);
    changed = relFiles.filter(f => status.includes(f));
    if (!changed.length) return { committed: false, pushed: false, err: [] };
    o.git('add', '-A', '--', ...changed);
    o.git('commit', '-q', '-m', message, '--', ...changed);
  } catch (e) {
    o.keepError(`commit of ${what}`, (e as Error).message);
    return { committed: false, pushed: false, err: [warn(`WARNING: could not commit ${what} in ${shown} (see ${o.see})`)] };
  }
  try { o.git('push', 'origin', o.pushRef || o.branch); } catch (e) {
    o.keepError(`push of ${what}`, (e as Error).message);
    return { committed: true, pushed: false, err: [warn(`WARNING: could not push ${what} on ${o.branch} (see ${o.see})`)] };
  }
  return { committed: true, pushed: true, err: [] };
}

/** Briefs already looked at in this state (file, mtime, size, pull request): a board that polls asks git about each once. */
const looked = new Set<string>();
/** The cleanup running for a brief in a state: a second ask while it runs waits for the same one (never two checkouts). */
const cleaning = new Map<string, Promise<'restored' | 'kept' | 'none'>>();

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
 * Once the run's pull request is merged, takes the link older versions wrote out of the main checkout's brief, so a pull that
 * brings the committed link is not blocked: when the brief's only change from HEAD is the pull request link, it is checked out
 * again. A brief with other edits is kept, and said so. Nothing else in the main checkout is touched and nothing is committed.
 */
export async function cleanMainBrief(o: CleanMainBrief): Promise<'restored' | 'kept' | 'none'> {
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
  const running = cleaning.get(key);
  if (running) return running;
  const p = cleanBrief(o, file, text, key).finally(() => cleaning.delete(key));
  cleaning.set(key, p);
  return p;
}

/** cleanMainBrief's git steps, asynchronous: the web server runs this beside its requests, never blocking them. */
async function cleanBrief(o: CleanMainBrief, file: string, text: string, key: string): Promise<'restored' | 'kept' | 'none'> {
  const git = async (...args: string[]) => { const r = await execFileAsync('git', ['-C', o.root, ...args], { env: o.env || process.env }); return { status: r.code, stdout: r.stdout, stderr: r.stderr, error: r.code === -1 ? r.error : undefined }; };
  const failed = (what: string, r: { status: number | null; stderr?: unknown; error?: Error }): 'none' => {
    o.keepError(`clean the main checkout's brief: git ${what}`, `${file}: git ${what} ${r.error ? `could not run: ${r.error.message}` : `exited with ${r.status}`}: ${String(r.stderr || '').trim() || '(no output)'}`);
    o.out(`WARNING: could not clean the pull request link out of ${file} (git ${what} failed; see errors.log)`);
    return 'none';
  };
  const status = await git('status', '--porcelain', '--', o.rel);
  if (status.status !== 0) return failed('status', status);
  // Unmodified (or untracked): nothing of ours to take out.
  if (!status.stdout.trim() || status.stdout.startsWith('??')) { looked.add(key); return 'none'; }
  const head = await git('show', `HEAD:${o.rel}`);
  if (head.status !== 0) return failed('show', head);
  if (clearPrInBrief(text).trim() !== clearPrInBrief(head.stdout).trim()) {
    looked.add(key);
    o.out(`Kept ${file} as it is: it has edits besides the pull request link, so the link was not taken out (the pull request ${o.mergedPr} is merged)`);
    return 'kept';
  }
  const restore = await git('checkout', '--', o.rel);
  if (restore.status !== 0) return failed('checkout', restore);
  o.out(`Restored ${file}: its only change was the link to ${o.mergedPr}, which is merged`);
  return 'restored';
}

/** cleanMainBrief for a pipeline run whose pull request <url> is merged: the main checkout's brief (a link an older version wrote there), when that is not this checkout. */
export async function cleanRunMainBrief(ctx: Pick<Ctx, 'root' | 'docs' | 'log' | 'env' | 'out'>, url: string): Promise<void> {
  let main: string;
  try { main = projectRoot(ctx.root, ctx.env); } catch (e) {
    keepError(ctx, 'clean the main checkout\'s brief: find the main checkout', (e as Error).message);
    ctx.out(`WARNING: could not find the main checkout to clean the pull request link out of its brief (see ${ctx.log}/errors.log)`);
    return;
  }
  // A run in the main checkout itself: its brief is the run's own, committed with the link.
  if (real(main) === real(ctx.root)) return;
  await cleanMainBrief({ root: main, rel: path.join(ctx.docs, 'brief.md'), mergedPr: url, env: ctx.env, keepError: (w, t) => keepError(ctx, w, t), out: l => ctx.out(l) });
}
