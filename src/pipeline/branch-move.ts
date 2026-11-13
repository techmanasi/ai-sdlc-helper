// A run whose branch cannot be pushed goes on on a new branch with its own pull request, so no one's work is rewritten.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '../trace.js';
import { isRunBranch } from '../gitdir.js';
import type { Ctx } from './context.js';
import { keepError } from './errors.js';
import { clearPrCache, clearPrInBrief, createOrGetPr, getPrFromBrief, getPrStatus, recordPrInBrief } from './finalise.js';
import { draftPrText } from './ci.js';
import { appendRound } from './observe.js';
import type { Git } from './git.js';

export { isRunBranch };

/** Why a run cannot go on on its branch. */
export type MoveReason =
  | { kind: 'remote-ahead'; detail: string }
  | { kind: 'pr-closed' | 'pr-merged'; detail: string };

/**
 * True when the developer turned the move off (SDLC_MOVE_BRANCH=0, no or off): the run then keeps its branch and a
 * refused push is handled as before.
 */
export const moveSkipped = (env: NodeJS.ProcessEnv): boolean => ['0', 'no', 'off'].includes(String(env.SDLC_MOVE_BRANCH ?? '').trim().toLowerCase());

const exists = (git: Git, ref: string): boolean => git.tryRun('rev-parse', '--verify', '--quiet', ref) !== null;

/** The first free <prefix><slug>-N (N from 2, or one past the branch the run is on now), checking here and on origin. */
export function nextRunBranch(git: Git, prefix: string, slug: string): string {
  const base = `${prefix}${slug}`;
  const current = (git.tryRun('symbolic-ref', '--short', '-q', 'HEAD') || '').trim();
  const m = current.startsWith(`${base}-`) ? /^-(\d+)$/.exec(current.slice(base.length)) : null;
  let n = m ? Number(m[1]) + 1 : 2;
  while (exists(git, `refs/heads/${base}-${n}`) || exists(git, `refs/remotes/origin/${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const briefFile = (ctx: Ctx): string => path.join(ctx.root, ctx.docs, 'brief.md');
const readBrief = (ctx: Ctx): string | null => { try { return fs.readFileSync(briefFile(ctx), 'utf8'); } catch { return null; } };

/**
 * Why the run should not push to its branch: origin's branch has commits the run does not have, or its pull request is
 * closed or merged. Null when it can (or when origin or gh cannot be asked: the run goes on as it did).
 */
export function whyMove(ctx: Ctx): MoveReason | null {
  const remotes = (ctx.git.tryRun('remote') || '').split('\n').map(s => s.trim());
  if (!remotes.includes('origin')) return null;
  const branch = ctx.branch;
  let remoteBranch = true;
  try { ctx.git.runTimeout(30_000, 'fetch', '-q', 'origin', branch); } catch (e) {
    const message = (e as Error).message;
    if (/couldn't find remote ref/.test(message)) remoteBranch = false;
    else {
      keepError(ctx, 'fetch', message);
      ctx.out(`   could not ask origin about ${branch} (see ${ctx.log}/errors.log): going on with it`);
      return null;
    }
  }
  const ref = `refs/remotes/origin/${branch}`;
  if (remoteBranch && exists(ctx.git, ref) && ctx.git.tryRun('merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD') === null) {
    const n = (ctx.git.tryRun('rev-list', '--count', `HEAD..origin/${branch}`) || '').trim() || 'some';
    return { kind: 'remote-ahead', detail: `${n} commits on origin/${branch} are not in this run` };
  }
  const gh = spawnSync('gh', ['--version'], { cwd: ctx.root, encoding: 'utf8', env: ctx.env, timeout: 30_000 });
  if (!gh || gh.status !== 0) return null;
  const text = readBrief(ctx);
  const briefPr = text ? getPrFromBrief(text) : null;
  clearPrCache();
  const pr = getPrStatus(ctx.root, briefPr || branch, ctx.env);
  if (pr?.state === 'CLOSED') return { kind: 'pr-closed', detail: pr.url };
  if (pr?.state === 'MERGED') return { kind: 'pr-merged', detail: pr.url };
  return null;
}

const sentence = (r: MoveReason): string =>
  r.kind === 'remote-ahead' ? `${r.detail}, so a push would be refused`
    : r.kind === 'pr-closed' ? `its pull request is closed (${r.detail})` : `its pull request is merged (${r.detail})`;

/** Switches the run to a new branch from where it is, and records the move (status, brief, attempts log). */
export function moveToNewBranch(ctx: Ctx, reason: MoveReason): void {
  const from = ctx.branch;
  const to = nextRunBranch(ctx.git, ctx.config.git.branchPrefix, ctx.slug);
  ctx.git.run('checkout', '-q', '-b', to);
  ctx.branch = to;

  let oldPr: string | null = null;
  const text = readBrief(ctx);
  if (text !== null) {
    oldPr = getPrFromBrief(text);
    const cleared = clearPrInBrief(text);
    if (cleared !== text) fs.writeFileSync(briefFile(ctx), cleared);
  }
  if (!oldPr && reason.kind !== 'remote-ahead') oldPr = reason.detail;
  if (!oldPr && ctx.status.ci?.pr) oldPr = ctx.status.ci.pr;

  const at = new Date().toISOString();
  ctx.status.branch = to;
  ctx.status.movedFrom = { branch: from, reason: reason.kind, ...(oldPr ? { pr: oldPr } : {}), at };
  // The old pull request's CI state is not this run's now.
  if (ctx.status.ci && (!ctx.status.ci.pr || ctx.status.ci.pr === oldPr)) ctx.status.ci = undefined;
  ctx.status.write();
  ctx.movedFrom = { branch: from, pr: oldPr, reason: reason.kind };

  ctx.out(`MOVED: this run continues on branch ${to}`);
  ctx.out(`   why: ${sentence(reason)}`);
  ctx.out(`   ${from} and its pull request are left as they are; a new pull request is opened for ${to}`);
  appendRound(path.join(ctx.root, ctx.log), { kind: 'move', at, from, to, reason: reason.kind });
}

/**
 * Pushes the moved run's branch and opens its draft pull request, once there is something to open it for. Returns the
 * link, or null (nothing committed yet, or the push or gh failed: Red tests tries again).
 */
export async function openMovedPr(ctx: Ctx): Promise<string | null> {
  if (!ctx.movedFrom) return null;
  const base = ctx.config.git.base || 'main';
  const baseRef = exists(ctx.git, `refs/remotes/origin/${base}`) ? `origin/${base}` : base;
  const ahead = Number((ctx.git.tryRun('rev-list', '--count', `${baseRef}..HEAD`) || '0').trim());
  if (!ahead) {
    ctx.out(`   the pull request for ${ctx.branch} is opened at Red tests (nothing is committed yet)`);
    return null;
  }
  try { ctx.git.run('push', '-u', 'origin', ctx.branch); } catch (e) {
    keepError(ctx, 'push', (e as Error).message);
    ctx.out(`   could not push ${ctx.branch} (see ${ctx.log}/errors.log): its pull request is not opened yet`);
    return null;
  }
  const { title, body } = draftPrText(ctx);
  const old = ctx.movedFrom.pr || `branch ${ctx.movedFrom.branch}`;
  const url = createOrGetPr(ctx.root, ctx.branch, title, `${body}\n\nReplaces ${old} (${ctx.movedFrom.reason || 'moved'}).`, ctx.config.git.base || undefined, { draft: true });
  if (!url) {
    keepError(ctx, 'gh pr create', 'no output available');
    ctx.out(`   could not open a pull request for ${ctx.branch} (see ${ctx.log}/errors.log)`);
    return null;
  }
  const text = readBrief(ctx);
  if (text !== null && getPrFromBrief(text) !== url) fs.writeFileSync(briefFile(ctx), recordPrInBrief(text, url));
  ctx.out(`   pull request: ${url}`);
  return url;
}
