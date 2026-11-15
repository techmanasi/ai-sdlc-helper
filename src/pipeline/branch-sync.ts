// The branch sync: before every stage, the run's branch is brought into a known state against GitHub, and no work is lost.
// Uncommitted work, local commits and GitHub's commits are all kept, or the run stops and names where each one is.
// Cases (local / remote / tree): see docs/backlog/branch-sync-every-stage/brief.md. Never a bare force push, never a merge commit.
import fs from 'node:fs';
import path from 'node:path';
import { FROM_STAGES, at, stop, type Ctx, type From } from './context.js';
import { keepError } from './errors.js';
import { resumeCommand, syncLines, toFromStage } from './hints.js';
import { appendRound } from './observe.js';
import { gitReason } from './ci.js';
import { patchRecord, registryDir } from '../runs/records.js';
import { moveSkipped, nextRunBranchOrStop, recordMove, setRecordBranch, type MoveReason } from './branch-move.js';
import {
  backup, branchFromOriginBase, endedPr, fetchBranch, inRebase, isAncestor, netGit, ownCommits, relock, shaOf, short,
  type PushFinding,
} from './push-check.js';
import { abortAll, leasePush, resolveRebaseStops, resolverFor, type CodeConflict, type FileResolution, type ModeNotes } from './resolve-conflicts.js';

const log = (ctx: Ctx, line: string): void => ctx.out(`Branch sync: ${line}`);
const keep = (ctx: Ctx, where: string, text: string): void => keepError(ctx, `branch sync: ${where}`, text);
const cleanMessage = (e: unknown): string => (e as Error).message;

/** Sync's own rows in the attempts log: one per outcome that changed something. */
function record(ctx: Ctx, action: string, detail?: string): void {
  try { appendRound(at(ctx, ctx.log), { kind: 'push-check', at: new Date().toISOString(), branch: ctx.branch, finding: 'branch-sync', action, ...(detail ? { detail } : {}) }); } catch (e) { keep(ctx, 'attempts log', cleanMessage(e)); }
}

const refExists = (ctx: Ctx, ref: string): boolean => ctx.git.tryRun('rev-parse', '--verify', '-q', ref) !== null;

/** Decision 7: a rebase, merge or cherry-pick left in progress is aborted first, and said so. */
function abortStuck(ctx: Ctx): void {
  const git = ctx.git;
  const busy: string[] = [];
  if (inRebase(git)) busy.push('rebase');
  if (refExists(ctx, 'MERGE_HEAD')) busy.push('merge');
  if (refExists(ctx, 'CHERRY_PICK_HEAD')) busy.push('cherry-pick');
  if (!busy.length) return;
  const onError = (where: string, text: string): void => keep(ctx, where, text);
  abortAll(git, onError);
  if (refExists(ctx, 'MERGE_HEAD')) {
    try { git.run('merge', '--abort'); } catch (e) { onError('merge --abort', cleanMessage(e)); }
  }
  const text = `a ${busy.join(' and a ')} was in progress and was aborted first`;
  keep(ctx, 'abort', text);
  log(ctx, text);
  record(ctx, 'aborted', busy.join(','));
}

/** The branch HEAD is on, or '' when detached. */
const currentBranch = (ctx: Ctx): string => (ctx.git.tryRun('symbolic-ref', '--short', '-q', 'HEAD') || '').trim();

/** A detached HEAD is re-attached when it equals or is ahead of the branch; otherwise the run stops and names the sha. */
function reattach(ctx: Ctx, resume: From): void {
  if (currentBranch(ctx)) return;
  const git = ctx.git;
  const head = git.head();
  const tip = shaOf(git, `refs/heads/${ctx.branch}`);
  if (tip && head !== tip && !isAncestor(git, tip, head)) {
    stop(ctx, `ERROR: HEAD is detached at ${short(head)}, which is not ahead of ${ctx.branch} (${short(tip)}). Nothing was changed. Check out the branch you want (git switch ${ctx.branch}, or git branch <name> ${short(head)} to keep these commits) and resume: ${resumeCommand(ctx.slug, resume)}`, 1, resume);
  }
  try { git.run('checkout', '-q', '-B', ctx.branch, head); } catch (e) {
    keep(ctx, 'reattach HEAD', cleanMessage(e));
    stop(ctx, `ERROR: HEAD is detached at ${short(head)} and could not be attached to ${ctx.branch} (${gitReason(cleanMessage(e))}). Details: ${ctx.log}/errors.log. Resume: ${resumeCommand(ctx.slug, resume)}`, 1, resume);
  }
  log(ctx, `HEAD was detached at ${short(head)}: attached to ${ctx.branch}`);
  record(ctx, 'reattached', short(head));
}

/** The worktree path that has <branch> checked out, when it is not this one. */
function checkedOutElsewhere(ctx: Ctx, branch: string): string | null {
  const text = ctx.git.tryRun('worktree', 'list', '--porcelain') || '';
  let dir = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice(9).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) {
      let a = dir; let b = ctx.git.root;
      try { a = fs.realpathSync(dir); b = fs.realpathSync(ctx.git.root); } catch { /* compare as given */ }
      if (a !== b) return dir;
    }
  }
  return null;
}

const baseOf = (ctx: Ctx): string => ctx.config.git.base || 'main';

/** A run branch's remote counterpart belongs to the task when it adds nothing to the base, or any commit names the task. */
function remoteBelongs(ctx: Ctx, remote: string, base: string | null): boolean {
  if (!base) return true;
  const mb = (ctx.git.tryRun('merge-base', remote, base) || '').trim();
  if (!mb) return false;
  const subjects = ctx.git.lines('log', '--format=%s', `${mb}..${remote}`);
  if (!subjects.length) return true;
  const named = new RegExp(`\\(${ctx.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`);
  if (subjects.some(s => named.test(s))) return true;
  return ctx.git.lines('log', '--format=', '--name-only', `${mb}..${remote}`).some(f => f.startsWith(`${ctx.docs}/`));
}

/** A new `<slug>_<n>` branch made from <from> (a ref or sha), with the run's bookkeeping. */
function moveTo(ctx: Ctx, resume: From, from: string, reason: MoveReason): string {
  const to = nextRunBranchOrStop(ctx, resume);
  ctx.git.run('checkout', '-q', '-b', to, from);
  recordMove(ctx, to, reason);
  record(ctx, 'new-branch', `${reason.kind}: ${to}`);
  return to;
}

// ---------------------------------------------------------------------------------------------------------------------
// The stash: uncommitted work saved by a unique message, never found by index.

export interface StashInfo { sha: string; ref: string; message: string; stage: string; at: string }

const stamped = (): string => new Date().toISOString().replace(/[:.]/g, '-');
/** The uncommitted paths outside the run's log folder (git refuses an excluded pathspec that is ignored, so stash names these). */
function dirtyPaths(ctx: Ctx): string[] {
  const out = ctx.git.tryRun('status', '--porcelain', '-z', '--untracked-files=all', '--', '.', `:(exclude)${ctx.log}`) || '';
  const parts = out.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') i++;   // a rename lists its old path next
  }
  return paths;
}

/** Saves the uncommitted work (untracked files too; not the run's log folder, not ignored files). Null when there is none. */
function saveStash(ctx: Ctx, madeBy: string): StashInfo | null {
  const paths = dirtyPaths(ctx);
  if (!paths.length) return null;
  const git = ctx.git;
  const time = stamped();
  const message = `sdlc:${ctx.slug}:${madeBy}:${time}`;
  git.run('stash', 'push', '-u', '-m', message, '--', ...paths);
  const row = git.lines('stash', 'list', '--format=%H%x09%gs').map(l => l.split('\t')).find(([, s]) => (s || '').endsWith(message));
  if (!row) {
    keep(ctx, 'stash', `git stash push reported no error, but no stash with the message ${message} exists`);
    return null;
  }
  const info: StashInfo = { sha: row[0], ref: `refs/sdlc/stash/${ctx.slug}/${time}`, message, stage: madeBy, at: time };
  git.run('update-ref', info.ref, info.sha);
  try { patchRecord(registryDir(ctx.root), ctx.slug, { stash: info }); } catch (e) { keep(ctx, 'run record: stash', cleanMessage(e)); }
  record(ctx, 'stash-saved', `${short(info.sha)} ${message}`);
  log(ctx, `your uncommitted changes are saved in the stash ${short(info.sha)} (${info.ref})`);
  return info;
}

/** After the stash was applied: the entry (found by its sha) and the ref go, and the record forgets it. */
function dropStash(ctx: Ctx, s: StashInfo): void {
  const git = ctx.git;
  const rows = git.lines('stash', 'list', '--format=%H');
  const i = rows.findIndex(h => h.trim() === s.sha);
  if (i >= 0) { try { git.run('stash', 'drop', '-q', `stash@{${i}}`); } catch (e) { keep(ctx, 'stash drop', cleanMessage(e)); } }
  try { git.run('update-ref', '-d', s.ref); } catch (e) { keep(ctx, 'stash ref', cleanMessage(e)); }
  try { patchRecord(registryDir(ctx.root), ctx.slug, { stash: undefined }); } catch (e) { keep(ctx, 'run record: stash', cleanMessage(e)); }
}

const unmerged = (ctx: Ctx): string[] => ctx.git.lines('diff', '--name-only', '--diff-filter=U');
const hasMarkers = (ctx: Ctx, f: string): boolean => {
  try { return /^(<{7}|>{7}) /m.test(fs.readFileSync(path.join(ctx.git.root, f), 'utf8')); } catch { return false; }
};

/** The tree as before the failed apply: tracked changes reset, and the untracked files the stash held removed. The stash stays. */
function restoreClean(ctx: Ctx, s: StashInfo): void {
  const git = ctx.git;
  try { git.run('reset', '-q', '--hard', 'HEAD'); } catch (e) { keep(ctx, 'clean tree', cleanMessage(e)); }
  for (const f of git.lines('ls-tree', '-r', '--name-only', `${s.sha}^3`)) {
    try { fs.rmSync(path.join(git.root, f), { force: true }); } catch (e) { keep(ctx, `remove ${f}`, cleanMessage(e)); }
  }
}

/** What the stash-mode resolver is told: who saved the work, the stage being started, and what GitHub changed in the same files. */
function stashNotes(ctx: Ctx, s: StashInfo, started: string, files: string[], incoming: string): ModeNotes {
  const commits = incoming ? ctx.git.lines('log', '--format=%h %an: %s', incoming, '--', ...files) : [];
  return {
    lines: [
      '## The saved work',
      `- Saved by: ${s.stage}`, `- Stage being started: ${started}`, `- Stash: ${s.sha} (${s.message})`, '',
      '## Incoming commits that touch the same files',
      ...(commits.length ? commits.map(c => `- ${c}`) : ['- (none found)']),
    ],
  };
}

/**
 * Puts the saved work back. Clean: done. Conflicted: the stash-mode resolver tries first; a DOUBT or a failed check keeps the
 * stash, restores a clean tree and stops naming the sha. <incoming> is a range start (the HEAD before the update) or ''.
 */
async function reapply(ctx: Ctx, s: StashInfo, o: { started: string; resume: From; incoming: string }): Promise<void> {
  const git = ctx.git;
  const interrupted = FROM_STAGES.indexOf(toFromStage(ctx.priorStage || '') as From);
  if (interrupted >= 0 && FROM_STAGES.indexOf(o.resume) < interrupted) {
    // Restarting earlier than the interrupted stage: that work may not belong to the stage now starting. Keep it, say where.
    record(ctx, 'stash-parked', short(s.sha));
    ctx.out(syncLines.stashParked(s.sha, s.ref, s.stage, o.resume));
    return;
  }
  let applied = true;
  try { git.run('stash', 'apply', s.sha); } catch (e) { applied = false; keep(ctx, 'stash apply', cleanMessage(e)); }
  if (applied) {
    dropStash(ctx, s);
    record(ctx, 'stash-applied', short(s.sha));
    log(ctx, `your saved changes are back in the working tree`);
    return;
  }
  const files = unmerged(ctx);
  const why = (m: string): never => {
    restoreClean(ctx, s);
    keep(ctx, 'stash reapply', m);
    record(ctx, 'stash-kept', short(s.sha));
    return stop(ctx, syncLines.stashKept(s.sha, s.ref, s.stage, m), 1, o.resume);
  };
  if (!files.length) return why('git stash apply failed and left no conflicted file to resolve');
  const conflict: CodeConflict = {
    round: 1, commit: { sha: s.sha, subject: s.message }, files, docs: [],
    upstream: git.head(), oldBase: (git.tryRun('rev-parse', `${s.sha}^1`) || '').trim() || git.head(),
  };
  const notes = stashNotes(ctx, s, o.started, files, o.incoming ? `${o.incoming}..HEAD` : '');
  let r;
  try { r = await resolverFor(ctx, 'stash', notes)(conflict); } catch (e) { keep(ctx, 'stash resolver', cleanMessage(e)); return why(`the resolver failed (${cleanMessage(e)})`); }
  if (!r.safe) return why(`the resolver was not sure${r.doubt ? `: ${r.doubt}` : ''}`);
  const left = files.filter(f => hasMarkers(ctx, f));
  if (left.length) return why(`conflict markers are left in ${left.join(', ')}`);
  try {
    git.run('add', '--', ...files);
    git.run('reset', '-q');
  } catch (e) { return why(`the resolved files could not be put back (${cleanMessage(e)})`); }
  dropStash(ctx, s);
  record(ctx, 'stash-resolved', files.join(','));
  log(ctx, `the saved changes conflicted with GitHub's commits in ${files.join(', ')}; the resolver combined them`);
}

// ---------------------------------------------------------------------------------------------------------------------

/** The tree changes made by the update (HEAD before to HEAD now): locked tests stop the run, a changed spec or plan warns. */
function checkIncoming(ctx: Ctx, before: string, resume: From): void {
  const git = ctx.git;
  const now = git.head();
  if (now === before) return;
  const hadLock = !!(ctx.lockSha || ctx.redSha || ctx.origRedSha);
  relock(ctx);
  const idx = FROM_STAGES.indexOf(resume);
  const changed = git.lines('diff', '--name-only', before, now);
  if (hadLock && idx >= FROM_STAGES.indexOf('implement') && ctx.origRedSha) {
    const specs = ctx.layout?.testPathspecs || [];
    const locked = new Set(git.lines('diff-tree', '--no-commit-id', '--name-only', '-r', ctx.origRedSha, '--', ...specs));
    const hit = changed.filter(f => locked.has(f));
    if (hit.length) {
      keep(ctx, 'locked tests changed', `files: ${hit.join(', ')}`);
      record(ctx, 'tests-changed', hit.join(','));
      stop(ctx, syncLines.testsChanged(hit), 1, 'implement');
    }
  }
  for (const [kind, key, from] of [['Spec', 'specs', 1], ['Plan', 'plan', 2]] as const) {
    if (idx < from) continue;
    const files = changed.filter(f => f.startsWith(`${ctx.docs}/`) && path.basename(f).startsWith(`${key}-`));
    if (files.length) {
      ctx.out(syncLines.docsChanged(kind, files));
      record(ctx, `${kind.toLowerCase()}-changed`, files.join(','));
    }
  }
}

/** Incoming commits (sha, author, subject, files), the pipeline's apart from people's, and the local ones not on GitHub. */
function branchNotes(ctx: Ctx, local: string, remote: string, mb: string): ModeNotes {
  const git = ctx.git;
  const rows = (range: string): Array<{ sha: string; who: string; subject: string; files: string[] }> =>
    git.lines('log', '--reverse', '--format=%H%x09%an%x09%s', range).map(l => {
      const [sha, who, ...rest] = l.split('\t');
      return { sha, who, subject: rest.join('\t'), files: git.lines('diff-tree', '--no-commit-id', '--name-only', '-r', sha) };
    });
  const incoming = rows(`${mb}..${remote}`);
  const mine = rows(`${mb}..${local}`);
  const pipeline = (s: string): boolean => /^\[[a-z-]+\] /.test(s);
  const fmt = (c: { sha: string; who: string; subject: string; files: string[] }): string => `- ${c.sha.slice(0, 7)} ${c.who}: ${c.subject} (${c.files.join(', ') || 'no files'})`;
  const area = (title: string, list: typeof incoming): string[] => [title, ...(list.length ? list.map(fmt) : ['- (none)'])];
  return {
    lines: [
      '## Incoming commits from GitHub', ...area('### Written by the pipeline', incoming.filter(c => pipeline(c.subject))),
      ...area('### Written by people', incoming.filter(c => !pipeline(c.subject))), '',
      '## Local commits not on GitHub', ...(mine.length ? mine.map(c => `${fmt(c)}; kept so that this task's work is not lost`) : ['- (none)']),
    ],
  };
}

/** Moves a deleted, merged, or closed branch's run onto a new one made from origin's base. */
async function moveFromBase(ctx: Ctx, resume: From, reason: MoveReason, why: string): Promise<void> {
  const base = baseOf(ctx);
  if (moveSkipped(ctx.env)) { log(ctx, `${why}; SDLC_MOVE_BRANCH=${ctx.env.SDLC_MOVE_BRANCH} keeps the run on ${ctx.branch}`); return; }
  const fetched = fetchBranch(ctx, base);
  const upstream = fetched === 'ok' ? shaOf(ctx.git, `refs/remotes/origin/${base}`) : null;
  if (!upstream) {
    if (typeof fetched === 'object') keep(ctx, `fetch ${base}`, fetched.error);
    log(ctx, `${why}; a new branch is made only from origin's ${base}, which could not be fetched: going on unchanged on ${ctx.branch}`);
    return;
  }
  const to = nextRunBranchOrStop(ctx, resume);
  const made = await branchFromOriginBase(ctx, to, upstream, resume);
  recordMove(ctx, to, reason);
  relock(ctx);
  const files = [...new Set(made.resolved.map((r: FileResolution) => r.file))];
  log(ctx, `${why}: the run goes on on ${to}, made from origin/${base} (${short(upstream)}) with this run's own commits${files.length ? ` (conflicts resolved in ${files.join(', ')})` : ''}`);
  record(ctx, 'new-branch', `${reason.kind}: ${to}`);
}

/**
 * Brings the run's branch into a known state before a stage. <caller> is the stage about to start; <resume> the from key a
 * stopped run resumes at. Offline (origin cannot be reached) the run goes on with a warning: no rebase, no lease push.
 */
export async function syncBranch(ctx: Ctx, opts: { caller: string; resume: From }): Promise<void> {
  const git = ctx.git;
  const { resume } = opts;
  abortStuck(ctx);
  reattach(ctx, resume);

  const hasOrigin = git.tryRun('remote', 'get-url', 'origin') !== null;
  const base = baseOf(ctx);
  let branch = ctx.branch;
  const localTip = (): string | null => shaOf(git, `refs/heads/${branch}`);

  if (!hasOrigin) {
    git.checkoutBranch(branch);
    setRecordBranch(ctx, branch);
    return;
  }

  const fetched = fetchBranch(ctx, branch);
  if (typeof fetched === 'object') {
    keep(ctx, 'fetch', fetched.error);
    if (!ctx.offline) ctx.out(syncLines.offline(`${gitReason(fetched.error)}; see ${ctx.log}/errors.log`));
    ctx.offline = true;
    record(ctx, 'offline', gitReason(fetched.error));
    git.checkoutBranch(branch);
    setRecordBranch(ctx, branch);
    return;
  }
  ctx.offline = false;
  const baseFetch = fetchBranch(ctx, base);
  const baseRef = (baseFetch === 'ok' ? shaOf(git, `refs/remotes/origin/${base}`) : null) || shaOf(git, `refs/heads/${base}`);
  const remote = fetched === 'ok' ? shaOf(git, `refs/remotes/origin/${branch}`) : null;
  const tip = localTip();
  const hasUpstream = tip !== null && (git.tryRun('config', '--get', `branch.${branch}.remote`) || '').trim() !== '';

  // The pull request of the branch ended: merged refuses (nothing to continue), closed moves the run to a new branch.
  const ended = endedPr(ctx, true);
  if (ended && !tip && !remote && ended.state === 'MERGED') {
    stop(ctx, `ERROR: the pull request of ${branch} is already merged (${ended.url}); the branch has nothing left to run. Nothing was changed.`, 5, resume);
  }

  // --- No local branch: A (nothing on GitHub), B (GitHub's copy is the task's), C (it is somebody else's).
  if (!tip) {
    if (remote) {
      if (ended) {
        moveTo(ctx, resume, baseRef || `origin/${branch}`, { kind: ended.state === 'MERGED' ? 'pr-merged' : 'pr-closed', detail: ended.url });
        branch = ctx.branch;
      } else if (remoteBelongs(ctx, remote, baseRef)) {
        git.run('checkout', '-q', '-b', branch, '--track', `origin/${branch}`);
        log(ctx, `${branch} made from origin/${branch} (${short(remote)}), which holds this task's commits`);
        record(ctx, 'tracking', short(remote));
      } else {
        moveTo(ctx, resume, baseRef || `origin/${branch}`, { kind: 'foreign-branch', detail: `origin/${branch} holds no commit of this task` });
        branch = ctx.branch;
      }
    } else if (ended) {
      moveTo(ctx, resume, baseRef || 'HEAD', { kind: 'pr-closed', detail: ended.url });
      branch = ctx.branch;
    } else if (baseRef) {
      git.run('checkout', '-q', '-b', branch, baseRef);
      log(ctx, `${branch} made from ${short(baseRef)} (origin/${base})`);
      record(ctx, 'created', short(baseRef));
    } else {
      git.checkoutBranch(branch);
    }
    setRecordBranch(ctx, ctx.branch);
    pushEmpty(ctx, baseRef);
    return;
  }

  // --- A local branch: a branch another worktree has checked out is not touched; the run goes on a new one from its tip.
  const elsewhere = checkedOutElsewhere(ctx, branch);
  if (elsewhere) {
    const to = nextRunBranchOrStop(ctx, resume);
    git.run('checkout', '-q', '-b', to, tip);
    recordMove(ctx, to, { kind: 'checked-out-elsewhere', detail: elsewhere });
    record(ctx, 'new-branch', `checked-out-elsewhere: ${to}`);
    return;
  }
  if (currentBranch(ctx) !== branch) git.checkoutBranch(branch);

  // C again: a fresh local branch (never pushed, nothing beyond the base) next to somebody else's branch of the same name.
  if (remote && !hasUpstream && !ended && baseRef && !ownCommits(git, tip, baseRef).length && !remoteBelongs(ctx, remote, baseRef)) {
    moveTo(ctx, resume, baseRef, { kind: 'foreign-branch', detail: `origin/${branch} holds no commit of this task` });
    setRecordBranch(ctx, ctx.branch);
    pushEmpty(ctx, baseRef);
    return;
  }

  // E: it was pushed (upstream or a PR) but GitHub no longer has it, or its pull request ended: a new branch from the base.
  if ((!remote && hasUpstream && fetched === 'absent') || ended) {
    const reason: MoveReason = ended
      ? { kind: ended.state === 'MERGED' ? 'pr-merged' : 'pr-closed', detail: ended.url }
      : { kind: 'branch-deleted', detail: `origin/${branch} no longer exists` };
    const stash = saveStash(ctx, ctx.priorStage || opts.caller);
    await moveFromBase(ctx, resume, reason, ended ? `the pull request of ${branch} is ${ended.state === 'MERGED' ? 'merged' : 'closed'} (${ended.url})` : `${branch} was pushed before, and GitHub no longer has it`);
    if (stash) await reapply(ctx, stash, { started: opts.caller, resume, incoming: '' });
    setRecordBranch(ctx, ctx.branch);
    return;
  }

  const before = git.head();
  if (!remote) {
    // D: never pushed. Continue; a branch with nothing beyond the base is pushed at once.
    setRecordBranch(ctx, branch);
    pushEmpty(ctx, baseRef);
    return;
  }
  if (remote === before) { setRecordBranch(ctx, branch); return; }                       // F
  if (isAncestor(git, remote, before)) { setRecordBranch(ctx, branch); return; }         // J: ahead of GitHub

  const dirty = dirtyPaths(ctx).length > 0;
  if (isAncestor(git, before, remote)) {
    // G, H: behind. A fast-forward keeps an uncommitted tree when git allows it; I: when it refuses, stash, ff, reapply.
    try {
      git.run('merge', '-q', '--ff-only', remote);
      log(ctx, `${branch} was behind GitHub: fast-forwarded to ${short(remote)}`);
      record(ctx, 'fast-forward', short(remote));
    } catch (e) {
      if (!dirty) {
        keep(ctx, 'fast-forward', cleanMessage(e));
        stop(ctx, `ERROR: ${branch} is behind origin's branch (${short(remote)}) and the fast-forward failed (${gitReason(cleanMessage(e))}). Nothing was changed. Details: ${ctx.log}/errors.log. Resume: ${resumeCommand(ctx.slug, resume)}`, 1, resume);
      }
      const stash = saveStash(ctx, ctx.priorStage || opts.caller);
      try { git.run('merge', '-q', '--ff-only', remote); } catch (e2) {
        keep(ctx, 'fast-forward after stash', cleanMessage(e2));
        if (stash) await reapply(ctx, stash, { started: opts.caller, resume, incoming: '' });
        stop(ctx, `ERROR: ${branch} is behind origin's branch and the fast-forward failed even with the changes stashed (${gitReason(cleanMessage(e2))}). Details: ${ctx.log}/errors.log. Resume: ${resumeCommand(ctx.slug, resume)}`, 1, resume);
      }
      log(ctx, `${branch} was behind GitHub: fast-forwarded to ${short(remote)} with your changes stashed meanwhile`);
      record(ctx, 'fast-forward-stash', short(remote));
      if (stash) await reapply(ctx, stash, { started: opts.caller, resume, incoming: before });
    }
    checkIncoming(ctx, before, resume);
    setRecordBranch(ctx, branch);
    return;
  }

  // Diverged. K: the same patches (a rebase on one side only): a backup and a lease push.
  const cherry = git.lines('cherry', before, remote).map(l => l.trim()).filter(Boolean);
  const finding = (reason: string, text: string): PushFinding => ({ kind: reason === 'same-commits' ? 'same-commits' : 'diverged', reason, text, local: before, remote, base: baseRef });
  if (cherry.length && cherry.every(l => l.startsWith('-'))) {
    if (ctx.offline) { setRecordBranch(ctx, branch); return; }
    const f = finding('same-commits', 'origin holds the same commits from before a rebase');
    backup(git, branch, before, remote);
    const p = leasePush(netGit(ctx), 'origin', branch, remote);
    if (!p.ok) {
      keep(ctx, 'lease push', p.message);
      stop(ctx, `ERROR: ${f.text}, but the push with a lease failed (${p.stale ? "origin's branch moved meanwhile" : gitReason(p.message)}). Nothing was changed; refs/sdlc-backup/${branch}/local is ${short(before)}. Resume: ${resumeCommand(ctx.slug, resume)}`, 1, resume);
    }
    try { git.run('branch', '-q', `--set-upstream-to=origin/${branch}`); } catch (e) { keep(ctx, 'set upstream', cleanMessage(e)); }
    log(ctx, `${f.text}: pushed with a lease (origin had ${short(remote)}, now ${short(before)})`);
    record(ctx, 'lease-push', short(remote));
    setRecordBranch(ctx, branch);
    return;
  }

  // L, M: a backup, then a rebase onto GitHub's branch (never a merge commit); a dirty tree is stashed first.
  const mb = (git.tryRun('merge-base', before, remote) || '').trim();
  backup(git, branch, before, remote);
  const stash = dirty ? saveStash(ctx, ctx.priorStage || opts.caller) : null;
  const put = (): void => {
    abortAll(git, (where, text) => keep(ctx, where, text));
    try { git.run('reset', '-q', '--hard', before); } catch (e) { keep(ctx, 'reset to the old tip', cleanMessage(e)); }
  };
  const failed = async (reason: string): Promise<never> => {
    keep(ctx, 'diverged rebase stopped', reason);
    put();
    if (stash) await reapply(ctx, stash, { started: opts.caller, resume, incoming: '' });
    return stop(ctx, `ERROR: ${branch} and origin's branch have diverged and ${reason}. Nothing was lost: ${branch} is back at ${short(before)}${stash ? ' with your uncommitted changes' : ''}, GitHub's copy is ${short(remote)}, and refs/sdlc-backup/${branch}/local and /remote name both. Details: ${ctx.log}/errors.log. Rebase by hand (git pull --rebase origin ${branch}), then resume: ${resumeCommand(ctx.slug, resume)}`, 1, resume);
  };
  if (ctx.offline) { setRecordBranch(ctx, branch); return; }
  const pulled = netGit(ctx).tryRun('-c', 'core.editor=true', 'pull', '--rebase', 'origin', branch);
  if (pulled === null && inRebase(git)) {
    const resolved: FileResolution[] = [];
    let r;
    try {
      r = await resolveRebaseStops({
        git, upstream: remote, oldBase: mb, docDirs: [ctx.config.backlogDir], resolved, out: l => ctx.out(l),
        resolveCode: resolverFor(ctx, 'branch-sync', branchNotes(ctx, before, remote, mb)),
        onStep: (k, d) => ctx.status?.beginStep?.(k, d),
      });
    } catch (e) { keep(ctx, 'rebase resolver', cleanMessage(e)); return failed(`the resolver failed (${cleanMessage(e)})`); }
    if (r.kind !== 'done') return failed(`the rebase stops: ${r.reason}`);
  } else if (pulled === null) {
    keep(ctx, 'pull --rebase', 'git pull --rebase origin ' + branch + ' failed');
    return failed('the rebase onto it failed');
  }
  const p = leasePush(netGit(ctx), 'origin', branch, remote);
  if (!p.ok) {
    keep(ctx, 'push after rebase', p.message);
    return failed(`the push after the rebase failed (${p.stale ? "origin's branch moved meanwhile" : gitReason(p.message)})`);
  }
  try { git.run('branch', '-q', `--set-upstream-to=origin/${branch}`); } catch (e) { keep(ctx, 'set upstream', cleanMessage(e)); }
  log(ctx, `${branch} and origin's branch had diverged: rebased onto GitHub's ${short(remote)} and pushed with a lease`);
  record(ctx, 'rebase-push', `${short(before)} -> ${short(git.head())} on ${short(remote)}`);
  if (stash) await reapply(ctx, stash, { started: opts.caller, resume, incoming: remote });
  checkIncoming(ctx, before, resume);
  setRecordBranch(ctx, branch);
}

/** A never-pushed branch with no commit beyond the base is pushed at once (so its name is taken on GitHub). A failure is not fatal. */
function pushEmpty(ctx: Ctx, baseRef: string | null): void {
  if (ctx.offline || !baseRef) return;
  const git = ctx.git;
  const branch = currentBranch(ctx);
  if (!branch || ownCommits(git, git.head(), baseRef).length) return;
  if (shaOf(git, `refs/remotes/origin/${branch}`)) return;
  try {
    netGit(ctx).runTimeout(60_000, 'push', '-q', '-u', 'origin', branch);
    log(ctx, `${branch} has nothing beyond the base: pushed at once`);
    record(ctx, 'pushed-empty', branch);
  } catch (e) { keep(ctx, 'push of the new branch', cleanMessage(e)); }
}
