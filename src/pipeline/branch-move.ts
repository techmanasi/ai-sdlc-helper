// A run whose branch cannot be pushed goes on on a new branch with its own pull request, so no one's work is rewritten.
import fs from 'node:fs';
import path from 'node:path';
import { isRunBranch } from '../gitdir.js';
import type { Ctx } from './context.js';
import { keepError } from './errors.js';
import { clearPrInBrief, findOrCreatePr, firstLine, getPrFromBrief } from './finalise.js';
import { linkPrEverywhere } from './pr-link.js';
import { draftPrText } from './ci.js';
import { appendRound } from './observe.js';
import { moveReasonText } from './status.js';
import { Git } from './git.js';

export { isRunBranch, moveReasonText };

/** Why a run goes on on a new branch: a code (moved_from.reason) and the details for the output. */
export interface MoveReason {
  /** pr-closed, pr-merged, earlier-run, diverged, branch-refused, push-refused (remote-ahead in status files from before the push check). */
  kind: string;
  detail: string;
}

/**
 * True when the developer turned the move off (SDLC_MOVE_BRANCH=0, no or off): the run then keeps its branch and a
 * refused push is handled as before.
 */
export const moveSkipped = (env: NodeJS.ProcessEnv): boolean => ['0', 'no', 'off'].includes(String(env.SDLC_MOVE_BRANCH ?? '').trim().toLowerCase());

const exists = (git: Git, ref: string): boolean => git.tryRun('rev-parse', '--verify', '--quiet', ref) !== null;

/** The branches named <base>_* on origin, asked now (a ref fetched earlier may be stale); empty when origin cannot be asked. */
function remoteMoved(git: Git, base: string): Set<string> {
  if (git.tryRun('remote', 'get-url', 'origin') === null) return new Set();
  try {
    const out = new Git(git.root, { ...git.env, GIT_TERMINAL_PROMPT: '0' }).runTimeout(30_000, 'ls-remote', '--heads', 'origin', `${base}_*`);
    return new Set(out.split('\n').map(l => /\trefs\/heads\/(.+)$/.exec(l)?.[1]).filter((n): n is string => !!n));
  } catch { return new Set(); }
}

/**
 * The first free <prefix><slug>_N (N from 2, or one past the branch the run is on now): not a local branch (shared by every
 * worktree of the repository), not a remote-tracking branch, and not on origin now. A slug holds no underscore, so the
 * name is never another backlog item's branch (<slug>-2, or a follow-up item <slug>-resolve-conflict-N).
 */
export function nextRunBranch(git: Git, prefix: string, slug: string): string {
  const base = `${prefix}${slug}`;
  const current = (git.tryRun('symbolic-ref', '--short', '-q', 'HEAD') || '').trim();
  const m = current.startsWith(`${base}_`) ? /^_(\d+)$/.exec(current.slice(base.length)) : null;
  let n = m ? Number(m[1]) + 1 : 2;
  const remote = remoteMoved(git, base);
  const taken = (name: string): boolean => exists(git, `refs/heads/${name}`) || exists(git, `refs/remotes/origin/${name}`) || remote.has(name);
  while (taken(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

const briefFile = (ctx: Ctx): string => path.join(ctx.root, ctx.docs, 'brief.md');
const readBrief = (ctx: Ctx): string | null => { try { return fs.readFileSync(briefFile(ctx), 'utf8'); } catch { return null; } };

/**
 * Switches the run to a new branch and records the move (status, brief, attempts log). <create> makes the branch and
 * checks it out (default: from where the run is); the bookkeeping is the same whichever way it was made. Returns its name.
 */
export function moveToNewBranch(ctx: Ctx, reason: MoveReason, create: (to: string) => void = to => { ctx.git.run('checkout', '-q', '-b', to); }): string {
  const to = nextRunBranch(ctx.git, ctx.config.git.branchPrefix, ctx.slug);
  create(to);
  return recordMove(ctx, to, reason);
}

/** The bookkeeping of a move once <to> is made and checked out (status, brief, attempts log): the run now goes on on <to>. */
export function recordMove(ctx: Ctx, to: string, reason: MoveReason): string {
  const from = ctx.branch;
  ctx.branch = to;

  let oldPr: string | null = null;
  const text = readBrief(ctx);
  if (text !== null) {
    oldPr = getPrFromBrief(text);
    const cleared = clearPrInBrief(text);
    if (cleared !== text) fs.writeFileSync(briefFile(ctx), cleared);
  }
  if (!oldPr && (reason.kind === 'pr-closed' || reason.kind === 'pr-merged')) oldPr = reason.detail;
  if (!oldPr && ctx.status.ci?.pr) oldPr = ctx.status.ci.pr;

  const at = new Date().toISOString();
  ctx.status.branch = to;
  ctx.status.movedFrom = { branch: from, reason: reason.kind, reason_text: moveReasonText(reason.kind), ...(oldPr ? { pr: oldPr } : {}), at };
  // The old pull request's CI state is not this run's now.
  if (ctx.status.ci && (!ctx.status.ci.pr || ctx.status.ci.pr === oldPr)) ctx.status.ci = undefined;
  ctx.status.write();
  ctx.movedFrom = { branch: from, pr: oldPr, reason: reason.kind };

  ctx.out(`MOVED: this run continues on branch ${to}`);
  ctx.out(`   why: ${moveReasonText(reason.kind)}${reason.detail ? ` (${reason.detail})` : ''}`);
  ctx.out(`   ${from} and its pull request are left as they are; a new pull request is opened for ${to}`);
  appendRound(path.join(ctx.root, ctx.log), { kind: 'move', at, from, to, reason: reason.kind });
  return to;
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
  // draftPrText names what the pull request replaces.
  const { title, body } = draftPrText(ctx);
  const opened = findOrCreatePr(ctx.root, ctx.branch, title, body, ctx.config.git.base || undefined, { draft: true });
  if (opened.url === null) {
    keepError(ctx, 'gh pr create', opened.error);
    ctx.out(`   could not open a pull request for ${ctx.branch}: ${firstLine(opened.error)} (the whole message is in ${ctx.log}/errors.log)`);
    return null;
  }
  const url = opened.url;
  linkPrEverywhere(ctx, url);
  ctx.out(`   pull request: ${url}`);
  return url;
}
