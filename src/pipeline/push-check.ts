// The push check: after Plan (and when a later push is refused), whether the run's branch can be pushed, why not, and
// what is done about it: nothing, a mechanical fix (a fast-forward, a push with a lease, a rebase onto origin's branch),
// Resolve conflicts when the branch conflicts with the base, or a new branch from the base with the run's own commits.
// Never a bare force push; the old branch and its pull request are never deleted.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '../trace.js';
import { at, stop, type Ctx } from './context.js';
import { Git } from './git.js';
import { keepError } from './errors.js';
import { clearPrCache, getPrFromBrief, getPrStatus } from './finalise.js';
import { gitReason, isRejectedPush } from './ci.js';
import { appendRound } from './observe.js';
import { moveSkipped, nextRunBranch, openMovedPr, recordMove, type MoveReason } from './branch-move.js';
import { abortAll, leasePush, resolveConflictsStage, resolveRebaseStops, resolverFor, trialMerge, type FileResolution } from './resolve-conflicts.js';
import { resumeCommand } from './hints.js';
import { redPattern, repairPattern } from './stages.js';

/** SDLC_PUSH_CHECK=0 (or no, off) skips the whole check: the run keeps its branch and pushes as before. */
export const pushCheckSkipped = (env: NodeJS.ProcessEnv): boolean => ['0', 'no', 'off'].includes(String(env.SDLC_PUSH_CHECK ?? '').trim().toLowerCase());

export type PushFindingKind = 'ok' | 'unreachable' | 'new-branch' | 'fast-forward' | 'same-commits' | 'diverged' | 'unknown';

/** What diagnosePush found. L is HEAD, R origin's branch (null when it has none), B the base (origin's, else the local one). */
export interface PushFinding {
  kind: PushFindingKind;
  /** A code for the attempts log: no-origin, pushable, fetch-failed, push-unreachable, branch-refused, pr-closed, pr-merged, earlier-run, behind, same-commits, diverged, dry-run-failed. */
  reason: string;
  /** The finding in words, for the output. */
  text: string;
  local: string;
  remote: string | null;
  base: string | null;
  pr?: string;
}

/**
 * What a failed push says, in one word: origin refuses this branch in particular (a hook, a protected branch);
 * origin has commits the run lacks; origin cannot be reached or does not accept this user (a new branch would fail the
 * same way); or something else.
 */
export function pushFailureKind(message: string): 'unreachable' | 'branch-refused' | 'rejected' | 'unknown' {
  if (/remote rejected|pre-receive hook declined|protected branch|\bGH006\b|\bGH013\b/i.test(message)) return 'branch-refused';
  if (isRejectedPush(message)) return 'rejected';
  if (/could not resolve host|unable to access|connection (refused|timed out|reset)|timed out|ETIMEDOUT|authentication failed|permission denied|could not read username|terminal prompts disabled|\b(401|403)\b|repository not found|does not appear to be a git repository|could not read from remote repository/i.test(message)) return 'unreachable';
  return 'unknown';
}

const short = (sha: string | null): string => (sha || '').slice(0, 7);
const shaOf = (git: Git, ref: string): string | null => (git.tryRun('rev-parse', '--verify', '-q', `${ref}^{commit}`) || '').trim() || null;
const isAncestor = (git: Git, a: string, b: string): boolean => git.tryRun('merge-base', '--is-ancestor', a, b) !== null;

/** Git for talking to origin: never asks for a password (a prompt would hang the run). */
const netGit = (ctx: Ctx): Git => new Git(ctx.git.root, { ...ctx.git.env, GIT_TERMINAL_PROMPT: '0' });

/** Fetches one branch of origin into refs/remotes/origin/<name>, also in a single-branch clone: ok, absent, or git's message. */
function fetchBranch(ctx: Ctx, name: string): 'ok' | 'absent' | { error: string } {
  try {
    netGit(ctx).runTimeout(30_000, 'fetch', '-q', 'origin', `+refs/heads/${name}:refs/remotes/origin/${name}`);
    return 'ok';
  } catch (e) {
    const message = (e as Error).message;
    return /couldn't find remote ref/i.test(message) ? 'absent' : { error: message };
  }
}

/** The pull request of the branch (the brief's link first) when it is closed or merged; null when open, none, or gh is missing. */
function endedPr(ctx: Ctx): { state: 'CLOSED' | 'MERGED'; url: string } | null {
  let gh: ReturnType<typeof spawnSync> | null = null;
  try { gh = spawnSync('gh', ['--version'], { cwd: ctx.root, encoding: 'utf8', env: ctx.env, timeout: 30_000 }); } catch { gh = null; }
  if (!gh || gh.status !== 0) {
    ctx.out("Push check: gh is not available, so the pull request's state was not checked");
    return null;
  }
  let briefPr: string | null = null;
  try { briefPr = getPrFromBrief(fs.readFileSync(at(ctx, `${ctx.docs}/brief.md`), 'utf8')); } catch { /* no brief */ }
  clearPrCache();
  const pr = getPrStatus(ctx.root, briefPr || ctx.branch, ctx.env);
  return pr && (pr.state === 'CLOSED' || pr.state === 'MERGED') ? { state: pr.state, url: pr.url } : null;
}

/** The run's own commits: those of L since it left the base (none without a base). */
function ownCommits(git: Git, local: string, base: string | null): string[] {
  if (!base) return [];
  const mb = (git.tryRun('merge-base', local, base) || '').trim();
  return mb ? git.lines('rev-list', '--reverse', `${mb}..${local}`) : [];
}

/**
 * Why the run's branch can or cannot be pushed, and which fix applies. Changes nothing but the remote-tracking refs (a
 * fetch). <fresh>: the run started at Spec or Plan, so a branch whose work is all on origin holds an earlier run's work.
 */
export function diagnosePush(ctx: Ctx, opts: { fresh: boolean }): PushFinding {
  const git = ctx.git;
  const branch = ctx.branch;
  const local = git.head();
  const baseName = ctx.config.git.base || 'main';
  const found = (kind: PushFindingKind, reason: string, text: string, extra: Partial<PushFinding> = {}): PushFinding =>
    ({ kind, reason, text, local, remote: null, base: null, ...extra });
  if (git.tryRun('remote', 'get-url', 'origin') === null) return found('ok', 'no-origin', 'there is no origin remote: nothing to push to');

  const fetched = fetchBranch(ctx, branch);
  if (typeof fetched === 'object') {
    keepError(ctx, 'push check: fetch', fetched.error);
    return found('unreachable', 'fetch-failed', `could not ask origin about ${branch} (${gitReason(fetched.error)}; see ${ctx.log}/errors.log)`);
  }
  const remote = fetched === 'ok' ? shaOf(git, `refs/remotes/origin/${branch}`) : null;
  const baseFetch = fetchBranch(ctx, baseName);
  const base = (baseFetch === 'ok' ? shaOf(git, `refs/remotes/origin/${baseName}`) : null) || shaOf(git, `refs/heads/${baseName}`);
  const ctxOf = { remote, base };

  const pr = endedPr(ctx);
  if (pr) {
    const reason = pr.state === 'CLOSED' ? 'pr-closed' : 'pr-merged';
    return found('new-branch', reason, `the pull request of ${branch} is ${pr.state === 'CLOSED' ? 'closed' : 'merged'} (${pr.url})`, { ...ctxOf, pr: pr.url });
  }

  const diverged = (): PushFinding => {
    const cherry = (git.tryRun('cherry', local, remote as string) || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (cherry.length && cherry.every(l => l.startsWith('-'))) {
      return found('same-commits', 'same-commits', 'origin holds the same commits from before a rebase', ctxOf);
    }
    return found('diverged', 'diverged', `${branch} and origin's branch have diverged`, ctxOf);
  };

  if (!remote || isAncestor(git, remote, local)) {
    // Tried twice: one failed trial push is not enough to leave a branch.
    let message = '';
    for (let i = 0; i < 2; i++) {
      try {
        netGit(ctx).runTimeout(60_000, 'push', '--dry-run', '-q', 'origin', `HEAD:refs/heads/${branch}`);
        return found('ok', 'pushable', `${branch} can be pushed`, ctxOf);
      } catch (e) { message = (e as Error).message; }
    }
    keepError(ctx, 'push check: dry run', message);
    const why = `${gitReason(message)}; see ${ctx.log}/errors.log`;
    switch (pushFailureKind(message)) {
      case 'rejected': if (remote) return diverged(); break;
      // A new branch would fail the same way: the run keeps its branch.
      case 'unreachable': return found('unreachable', 'push-unreachable', `origin cannot be reached or does not accept this user for a push of ${branch} (${why})`, ctxOf);
      case 'branch-refused': return found('new-branch', 'branch-refused', `origin refuses pushes to ${branch} (${why})`, ctxOf);
      default: break;
    }
    return found('unknown', 'dry-run-failed', `a trial push of ${branch} failed (${why})`, ctxOf);
  }
  if (isAncestor(git, local, remote)) {
    if (opts.fresh && ownCommits(git, local, base).length === 0) {
      return found('new-branch', 'earlier-run', `origin's ${branch} holds an earlier run's work (${short(remote)}) and this run has no commits of its own`, ctxOf);
    }
    return found('fast-forward', 'behind', `${branch} is behind origin's branch`, ctxOf);
  }
  return diverged();
}

const inRebase = (git: Git): boolean => ['rebase-merge', 'rebase-apply'].some(n => {
  const p = (git.tryRun('rev-parse', '--git-path', n) || '').trim();
  return !!p && fs.existsSync(path.isAbsolute(p) ? p : path.join(git.root, p));
});

/** Tracked files with uncommitted changes (a rebase refuses to start with them). */
const trackedChanges = (git: Git): string[] => (git.tryRun('status', '--porcelain', '--untracked-files=no') || '').split('\n').filter(Boolean);

/** The branch before a rewrite, as Resolve conflicts keeps it: refs/sdlc-backup/<branch>/local (and remote). */
function backup(git: Git, branch: string, local: string, remote: string | null): void {
  git.run('update-ref', `refs/sdlc-backup/${branch}/local`, local);
  if (remote) git.run('update-ref', `refs/sdlc-backup/${branch}/remote`, remote);
}

/** After a fix rewrote the run's commits, the locked tests are found again by their messages and the lock moves to HEAD. */
function relock(ctx: Ctx): void {
  if (!ctx.lockSha && !ctx.redSha) return;
  ctx.origRedSha = ctx.git.findCommit([redPattern(ctx.slug)]);
  ctx.redSha = ctx.git.findCommit([redPattern(ctx.slug), repairPattern(ctx.slug)]) || ctx.origRedSha;
  ctx.lockSha = ctx.git.head();
}

/**
 * Makes <to> from origin's base (<upstream>, fetched just now) with the run's own commits: <to> starts where the run is and is
 * rebased onto <upstream>, each conflicting commit resolved as Resolve conflicts resolves it (documentation keeps both sides, code
 * goes to the resolver agent and a doubt to the reviewer panel). Uncommitted changes to tracked files are stashed for the rebase
 * and put back; untracked files stay. When that cannot be done safely the run stops: nothing is pushed, <to> is removed (it was
 * made here and never pushed), the old branch is checked out again as it was, and refs/sdlc-backup/<branch>/local names it.
 */
async function branchFromOriginBase(ctx: Ctx, to: string, upstream: string, resume: string): Promise<{ resolved: FileResolution[] }> {
  const git = ctx.git;
  const from = ctx.branch;
  const local = git.head();
  const baseName = ctx.config.git.base || 'main';
  git.run('update-ref', `refs/sdlc-backup/${from}/local`, local);
  git.run('checkout', '-q', '-b', to);
  const oldBase = (git.tryRun('merge-base', local, upstream) || '').trim();
  const resolved: FileResolution[] = [];
  const keep = (where: string, text: string): void => keepError(ctx, where, text);
  let reason = '';
  let detail = '';
  try {
    let started = '';
    // Without a common commit there is nothing of the run's own to carry: the branch is the base.
    const args = oldBase ? [upstream] : ['--onto', upstream, local];
    try { git.run('-c', 'core.editor=true', 'rebase', '--autostash', '-q', ...args); } catch (e) { started = (e as Error).message; }
    const r = await resolveRebaseStops({ git, upstream, oldBase: oldBase || local, docDirs: [ctx.config.backlogDir], resolveCode: resolverFor(ctx), resolved, out: l => ctx.out(l) });
    if (r.kind === 'stopped') {
      reason = r.reason;
      detail = [r.reason, r.conflict ? `commit ${r.conflict.commit.sha.slice(0, 7)} ${r.conflict.commit.subject}: ${r.conflict.doubt}` : '', started].filter(Boolean).join('\n');
    } else if (!isAncestor(git, upstream, 'HEAD')) {
      reason = `the rebase onto origin/${baseName} did not complete`;
      detail = `${reason}\n${started || '(git said nothing)'}`;
    }
  } catch (e) {
    reason = `the rebase onto origin/${baseName} failed`;
    detail = `${reason}\n${(e as Error).stack || (e as Error).message}`;
  }
  if (!reason) return { resolved };

  // Put everything back: no rebase left, the old branch checked out as it was, and the half-made new branch gone.
  keep('push check: new branch from the base', detail);
  abortAll(git, keep);
  let back = true;
  try { git.run('checkout', '-q', from); } catch (e) { keep(`push check: check out ${from} again`, (e as Error).message); back = false; }
  if (back && git.head() !== local) {
    try { git.run('reset', '-q', '--keep', local); } catch (e) { keep(`push check: put ${from} back`, (e as Error).message); back = false; }
  }
  if (back) {
    try { git.run('branch', '-q', '-D', to); } catch (e) { keep(`push check: remove ${to}`, (e as Error).message); }
  }
  appendRound(at(ctx, ctx.log), { kind: 'push-check', at: new Date().toISOString(), branch: from, finding: 'new-branch', action: 'new-branch-stopped', detail: reason });
  const where = back
    ? `${from} is checked out again, unchanged`
    : `${from} could not be checked out again, so nothing was discarded: ${to} is left as it is (never pushed); check out ${from} by hand (git rebase --abort first if a rebase is still going on)`;
  return stop(ctx, `ERROR: the push check could not make ${to} from origin/${baseName} with this run's commits: ${reason}. Nothing was pushed; ${where} (refs/sdlc-backup/${from}/local is ${local.slice(0, 7)}). The details are in ${ctx.log}/errors.log${resolved.length || reason.includes('conflict') ? ` and ${ctx.log}/resolve-conflicts-context.md` : ''}. Rebase ${from} onto origin/${baseName} by hand (or fix what the details name), then resume: ${resumeCommand(ctx.slug, resume)}`, 1);
}

/** One line of output and one row in the attempts log for every outcome. */
function report(ctx: Ctx, f: PushFinding, action: string, line: string): void {
  ctx.out(`Push check: ${line}`);
  appendRound(at(ctx, ctx.log), { kind: 'push-check', at: new Date().toISOString(), branch: ctx.branch, finding: f.reason, action, ...(f.text ? { detail: f.text } : {}) });
}

/**
 * Settles whether the run can push its branch, before Red tests (and when a push is refused later), by the ladder in
 * docs/pipeline-edge-cases.md: go on; fast-forward; push with a lease when origin holds the same commits from before a
 * rebase; rebase onto origin's branch and push; then Resolve conflicts (inline) when the branch conflicts with the base;
 * and when nothing of that applies, a new branch from the base with the run's own commits and its own pull request.
 * <resume>: the from key a stopped run resumes at. <fresh>: the run started at Spec or Plan.
 */
export async function ensurePushable(ctx: Ctx, opts: { resume: string; fresh: boolean }): Promise<void> {
  if (pushCheckSkipped(ctx.env)) {
    ctx.out(`Push check: skipped (SDLC_PUSH_CHECK=${ctx.env.SDLC_PUSH_CHECK})`);
    return;
  }
  ctx.status?.beginStep?.('push-check');
  const git = ctx.git;
  const branch = ctx.branch;
  const f = diagnosePush(ctx, { fresh: opts.fresh });
  // Why the branch cannot be kept, when a fix did not work (the run then goes on a new branch).
  let unknown: { kind: string; why: string } | null = null;

  switch (f.kind) {
    case 'ok':
      report(ctx, f, 'none', f.text);
      break;
    case 'unreachable':
      report(ctx, f, 'none', `${f.text}: going on unchanged`);
      return;
    case 'fast-forward':
      try {
        git.run('merge', '-q', '--ff-only', f.remote as string);
        relock(ctx);
        report(ctx, f, 'fast-forward', `${f.text}: fast-forwarded to ${short(f.remote)}`);
      } catch (e) {
        keepError(ctx, 'push check: fast-forward', (e as Error).message);
        unknown = { kind: 'push-refused', why: `${f.text}, and the fast-forward failed (${gitReason((e as Error).message)})` };
      }
      break;
    case 'same-commits': {
      backup(git, branch, f.local, f.remote);
      const p = leasePush(netGit(ctx), 'origin', branch, f.remote as string);
      if (p.ok) {
        try { git.run('branch', '-q', `--set-upstream-to=origin/${branch}`); } catch (e) {
          keepError(ctx, 'push check: set upstream', (e as Error).message);
          ctx.out(`Push check: could not set origin/${branch} as the upstream of ${branch} (see ${ctx.log}/errors.log)`);
        }
        report(ctx, f, 'lease-push', `${f.text}: pushed with a lease (origin had ${short(f.remote)}, now ${short(f.local)})`);
      } else {
        keepError(ctx, 'push check: lease push', p.message);
        unknown = { kind: 'push-refused', why: p.stale ? `${f.text}, but origin's branch moved meanwhile (the lease was stale)` : `${f.text}, but the push with a lease failed (${gitReason(p.message)})` };
      }
      break;
    }
    case 'diverged': {
      if (trackedChanges(git).length) {
        unknown = { kind: 'diverged', why: `${f.text}, and uncommitted changes to tracked files would block a rebase` };
        break;
      }
      backup(git, branch, f.local, f.remote);
      const clean = git.tryRun('-c', 'core.editor=true', 'rebase', '-q', f.remote as string) !== null && !inRebase(git);
      if (!clean) {
        abortAll(git, (where, text) => keepError(ctx, `push check: ${where}`, text));
        if (git.head() !== f.local) git.run('reset', '-q', '--hard', f.local);
        unknown = { kind: 'diverged', why: `${f.text}, and a rebase onto it stops on a conflict` };
        break;
      }
      try {
        netGit(ctx).runTimeout(120_000, 'push', '-q', '-u', 'origin', branch);
        relock(ctx);
        report(ctx, f, 'rebase-push', `${f.text}: rebased onto origin's branch (${short(f.remote)}) and pushed`);
      } catch (e) {
        keepError(ctx, 'push check: push after rebase', (e as Error).message);
        git.run('reset', '-q', '--hard', f.local);
        unknown = { kind: 'push-refused', why: `${f.text}; after a rebase onto it the push still failed (${gitReason((e as Error).message)})` };
      }
      break;
    }
    case 'new-branch':
    case 'unknown':
      unknown = { kind: f.kind === 'new-branch' ? f.reason : 'push-refused', why: f.text };
      break;
  }

  if (unknown) {
    if (moveSkipped(ctx.env)) {
      report(ctx, f, 'kept', `${unknown.why}; SDLC_MOVE_BRANCH=${ctx.env.SDLC_MOVE_BRANCH} keeps the run on ${branch}`);
      return;
    }
    // A new branch comes only from origin's base, fetched now: when it cannot be fetched, the run does not move.
    const baseName = ctx.config.git.base || 'main';
    const fetched = fetchBranch(ctx, baseName);
    const upstream = fetched === 'ok' ? shaOf(git, `refs/remotes/origin/${baseName}`) : null;
    if (!upstream) {
      const why = typeof fetched === 'object' ? `${gitReason(fetched.error)}; see ${ctx.log}/errors.log` : `origin has no ${baseName}`;
      if (typeof fetched === 'object') keepError(ctx, `push check: fetch ${baseName}`, fetched.error);
      report(ctx, f, 'no-base', `${unknown.why}; a new branch is made only from origin's ${baseName}, which could not be fetched (${why}): going on unchanged on ${branch}`);
      return;
    }
    const reason: MoveReason = { kind: unknown.kind, detail: f.pr || unknown.why };
    const to = nextRunBranch(git, ctx.config.git.branchPrefix, ctx.slug);
    const made = await branchFromOriginBase(ctx, to, upstream, opts.resume);
    recordMove(ctx, to, reason);
    relock(ctx);
    const files = [...new Set(made.resolved.map(r => r.file))];
    report(ctx, f, 'new-branch-from-base',
      `${unknown.why}: the run goes on on ${to}, made from origin/${baseName} (${short(upstream)}) with this run's own commits${files.length ? ` (conflicts resolved in ${files.join(', ')})` : ''}`);
    await openMovedPr(ctx);
    return;
  }

  // Pushable now. A branch that is on origin and conflicts with the base gets Resolve conflicts here, not at the end.
  const remoteNow = f.remote || null;
  if (!remoteNow || !f.base || isAncestor(git, f.base, 'HEAD')) return;
  if (trialMerge(git, git.head(), f.base) !== 'conflicts') return;
  const caller = ctx.status.stage;
  report(ctx, f, 'resolve-conflicts', `${branch} conflicts with ${ctx.config.git.base || 'main'}: Resolve conflicts runs now`);
  await resolveConflictsStage(ctx, { inline: { resume: opts.resume, caller } });
  ctx.status?.beginStep?.('push-check');
}
