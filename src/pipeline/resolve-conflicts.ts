// The Resolve conflicts stage, after Finalise: fetch the base branch, rebase the run's branch onto it (a straight line, no
// merge commits), resolve conflicts commit by commit, verify, and push with --force-with-lease (never a bare --force).
// Documentation conflicts are resolved by keeping both sides; a code or test conflict goes to an agent, and any doubt
// stops the stage without pushing and offers a follow-up backlog item (<slug>-resolve-conflict-N) the user may add.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { addBacklogItem, parseIndex } from '../backlog/index.js';
import { parseQuestions } from '../runs/view.js';
import { projectRoot } from '../runs/records.js';
import { withAnswerLines } from './questions.js';
import { at, setAside, stamp, stop, tick, type AgentStage, type Ctx } from './context.js';
import { getPrFromBrief, getPrStatus } from './finalise.js';
import { promptValues, runAgent, runAudit, stageFlags, stageModelKey, stageNotes } from './agent.js';
import { renderPrompt } from './prompts.js';
import { runSuites } from '../runners/run.js';
import { integrationPass, targetTestFiles, testsPass } from './gates.js';
import { resumeCommand } from './hints.js';
import { redPattern, repairPattern, stage } from './stages.js';
import type { Git } from './git.js';

/** The stage's name, as the status file, the run page and the recovery hints show it. */
export const RESOLVE_STAGE = 'Resolve conflicts';

/** A documentation file: anything under docs/ or the backlog folder, or Markdown anywhere. Its conflicts need no stop. */
export function isDocFile(file: string, docDirs: string[] = []): boolean {
  if (/\.(md|mdx|markdown)$/i.test(file) || file.startsWith('docs/')) return true;
  return docDirs.some(d => {
    const dir = d.replace(/\/+$/, '');
    return dir !== '' && (file === dir || file.startsWith(`${dir}/`));
  });
}

/** Conflict markers left in a resolved file. */
const MARKERS = /^(<{7}|>{7})( |$)|^={7}$/m;

/** One file the stage resolved, and why. */
export interface FileResolution { file: string; commit: string; kind: 'docs' | 'code'; why: string }

/** A rebase stop on code or test files, for the resolver (the agent). */
export interface CodeConflict {
  /** 1 for the first stop on code, 2 for the next, ... */
  round: number;
  /** The branch commit being replayed onto the base. */
  commit: { sha: string; subject: string };
  /** Conflicted code and test files, and the documentation both sides changed the same lines of, still with their markers. */
  files: string[];
  /** Documentation files of the same commit, already resolved by keeping both sides (each side only added lines). */
  docs: string[];
  /** The base the branch is rebased onto, and where the branch had started from it. */
  upstream: string;
  oldBase: string;
}

/** The resolver's answer: safe (the files are resolved, with a reason per file), or a doubt that stops the stage. */
export interface CodeResolution { safe: boolean; files: Array<{ file: string; why: string }>; doubt?: string }

/** Why the stage stopped on a conflict, with both sides, for the report and the follow-up item. */
export interface ConflictReport {
  commit: { sha: string; subject: string };
  files: string[];
  doubt: string;
  /** Per file: the base's change since the branch started, and this commit's change. */
  sides: Array<{ file: string; base: string; task: string }>;
}

export type ResolveOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'up-to-date'; upstream: string }
  | { kind: 'pushed'; resolved: FileResolution[]; head: string; before: string; remoteBefore: string; pushes: number; arrived: string[] }
  /** `offer`: ask whether to add a follow-up item. `checkFailed`: the conflicts were resolved, but the check of the result failed (no follow-up is offered: a retry is the next step). */
  | { kind: 'stopped'; reason: string; offer: boolean; conflict?: ConflictReport; resolved: FileResolution[]; attempt?: string; checkFailed?: boolean };

export interface ResolveOptions {
  git: Git;
  branch: string;
  /** The base branch on the remote (default main). */
  base?: string;
  remote?: string;
  /** Folders whose files count as documentation, besides docs/ and Markdown (the backlog folder). */
  docDirs?: string[];
  /** Where the recovery record (shas before the rebase) is written. */
  recordFile?: string;
  /** Why there is nothing to do because the PR is already merged (after the fetch); null when it is not. */
  mergedReason?: () => string | null;
  /** Called once the stage has something to do (the branch is on the remote and the base was fetched). */
  onStart?: () => void;
  /** Resolves a stop on code or test files, and on documentation both sides edited the same lines of; without one, a code stop ends the stage. */
  resolveCode?: (c: CodeConflict) => Promise<CodeResolution>;
  /** The full check of the rebased branch; false stops the stage without pushing. */
  verify?: (o: { codeResolved: boolean }) => Promise<boolean>;
  /** Push attempts (a failed lease fetches, takes what arrived and tries again). Default 3. */
  maxPushes?: number;
  /**
   * The branch already holds the rebased result (a kept attempt the pipeline fixed up: see adoptAttempt) and the remote is still at
   * <remoteSha>: no rebase, no "diverged" stop; the check runs and the result is pushed with the lease.
   */
  adopted?: { remoteSha: string };
  out(line: string): void;
}

const clip = (text: string, max = 120): string => {
  const lines = text.replace(/\n+$/, '').split('\n');
  return lines.length > max ? `${lines.slice(0, max).join('\n')}\n... (${lines.length - max} more lines)` : lines.join('\n');
};

/** The git directory path of <name> (rebase-merge, CHERRY_PICK_HEAD, ...), worktree-aware. */
const gitPath = (git: Git, name: string): string => {
  const p = git.run('rev-parse', '--git-path', name).trim();
  return path.isAbsolute(p) ? p : path.join(git.root, p);
};
const inRebase = (git: Git): boolean => fs.existsSync(gitPath(git, 'rebase-merge')) || fs.existsSync(gitPath(git, 'rebase-apply'));
const inCherryPick = (git: Git): boolean => fs.existsSync(gitPath(git, 'CHERRY_PICK_HEAD'));
const sha = (git: Git, ref: string): string => (git.tryRun('rev-parse', '--verify', '-q', `${ref}^{commit}`) || '').trim();
const isAncestor = (git: Git, a: string, b: string): boolean => git.tryRun('merge-base', '--is-ancestor', a, b) !== null;
const conflicted = (git: Git): string[] => [...new Set(git.lines('diff', '--name-only', '--diff-filter=U'))];

/** The blob of <file> at index stage <n> (1 base, 2 ours, 3 theirs), or null when that side has none. */
function stageBlob(git: Git, n: number, file: string): string | null {
  return git.tryRun('show', `:${n}:${file}`);
}

/**
 * Resolves a conflicted documentation file by keeping both sides' content (git merge-file --union). A side that deleted
 * the file loses to the side that changed it: no change is dropped to make a conflict go away.
 */
export function keepBoth(git: Git, file: string): void {
  const base = stageBlob(git, 1, file);
  const ours = stageBlob(git, 2, file);
  const theirs = stageBlob(git, 3, file);
  const abs = path.join(git.root, file);
  if (ours === null && theirs === null) { git.run('rm', '-q', '--cached', '--ignore-unmatch', '--', file); return; }
  let text: string;
  if (ours === null || theirs === null) text = (ours ?? theirs) as string;
  else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-union-'));
    try {
      const f = (name: string, t: string) => { const p = path.join(tmp, name); fs.writeFileSync(p, t); return p; };
      const o = f('ours', ours);
      const b = f('base', base ?? '');
      const t = f('theirs', theirs);
      text = git.run('merge-file', '-p', '--union', o, b, t);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  git.run('add', '--', file);
}

/**
 * Whether a conflicted documentation file needs an agent: both sides changed the same lines of the base (or both made the file),
 * so keeping both would repeat content or break the document's structure. Two sides that each only added lines are safe to keep.
 */
export function needsJudgment(git: Git, file: string): boolean {
  const base = stageBlob(git, 1, file);
  const ours = stageBlob(git, 2, file);
  const theirs = stageBlob(git, 3, file);
  if (ours === null || theirs === null) return false;
  if (base === null) return ours !== theirs;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-diff3-'));
  try {
    const f = (name: string, t: string) => { const p = path.join(tmp, name); fs.writeFileSync(p, t); return p; };
    // merge-file exits with the number of conflicts, so its output is read whatever the status.
    const text = spawnSync('git', ['merge-file', '-p', '--diff3', f('ours', ours), f('base', base), f('theirs', theirs)], { cwd: git.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
    for (const m of text.matchAll(/^\|{7}[^\n]*\n([\s\S]*?)^={7}$/gm)) if (m[1].trim()) return true;
    return false;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** The pushes this stage makes: only --force-with-lease=<branch>:<sha>, never a bare --force. */
export function leasePush(git: Git, remote: string, branch: string, lease: string): { ok: boolean; stale: boolean; message: string } {
  try {
    git.run('push', '-q', `--force-with-lease=${branch}:${lease}`, remote, `${branch}:refs/heads/${branch}`);
    return { ok: true, stale: false, message: '' };
  } catch (e) {
    const message = (e as Error).message;
    return { ok: false, stale: /stale info|\[rejected\]|fetch first|non-fast-forward/i.test(message), message };
  }
}

/** 'clean' or 'conflicts' from a merge of <theirs> into <ours> that touches no checkout; 'unknown' when git cannot say. */
function trialMerge(git: Git, ours: string, theirs: string): 'clean' | 'conflicts' | 'unknown' {
  try {
    git.run('merge-tree', '--write-tree', ours, theirs);
    return 'clean';
  } catch (e) {
    return (e as { status?: number }).status === 1 ? 'conflicts' : 'unknown';
  }
}

/**
 * Brings <branch> up to date with <remote>/<base>: nothing to do when the branch already contains the base; otherwise a
 * rebase, conflicts resolved commit by commit, the check, and a push with the lease. Every stop leaves the local branch
 * where it was and the remote untouched (a rebased attempt is kept under refs/sdlc-attempt/<branch>).
 */
async function resolveConflictsOnCleanTree(o: ResolveOptions): Promise<ResolveOutcome> {
  const { git, branch, out } = o;
  const remote = o.remote || 'origin';
  const base = o.base || 'main';
  const docDirs = o.docDirs || [];
  const resolved: FileResolution[] = [];

  if (git.tryRun('remote', 'get-url', remote) === null) return { kind: 'skipped', reason: `no ${remote} remote: nothing to bring up to date` };
  if (git.tryRun('fetch', '-q', remote) === null) return { kind: 'stopped', reason: `git fetch ${remote} failed`, offer: false, resolved };
  const merged = o.mergedReason?.();
  if (merged) return { kind: 'skipped', reason: merged };
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  let remoteSha = sha(git, remoteRef);
  if (!remoteSha) return { kind: 'skipped', reason: `${branch} is not on ${remote} (Finalise did not push it): nothing to bring up to date` };
  const upstream = sha(git, `refs/remotes/${remote}/${base}`);
  if (!upstream) return { kind: 'skipped', reason: `${remote}/${base} does not exist` };
  const adopted = Boolean(o.adopted && o.adopted.remoteSha === remoteSha && isAncestor(git, upstream, 'HEAD'));
  // Someone may have resolved it already (or main moved without touching the task): a trial merge in the object store
  // shows whether any conflict is left. Without git's merge-tree --write-tree the stage goes on as before.
  if (!adopted && !isAncestor(git, upstream, remoteSha) && trialMerge(git, remoteSha, upstream) === 'clean') {
    return { kind: 'skipped', reason: `${branch} has no conflicts with ${remote}/${base}: nothing to resolve` };
  }
  o.onStart?.();

  if (git.run('rev-parse', '--abbrev-ref', 'HEAD').trim() !== branch) git.run('checkout', '-q', branch);
  if (git.run('status', '--porcelain', '--untracked-files=no').trim()) {
    return { kind: 'stopped', reason: `${branch} has uncommitted changes: commit or discard them first`, offer: false, resolved };
  }
  // Commits pushed to the PR branch from elsewhere come first (a fast-forward); a branch that diverged is not rewritten.
  if (!adopted && !isAncestor(git, remoteSha, 'HEAD')) {
    if (!isAncestor(git, 'HEAD', remoteSha)) {
      return { kind: 'stopped', reason: `${branch} and ${remote}/${branch} have diverged: reconcile them first`, offer: false, resolved };
    }
    git.run('merge', '-q', '--ff-only', remoteSha);
    out(`   fast-forwarded ${branch} to ${remote}/${branch} (${remoteSha.slice(0, 7)})`);
  }
  const before = git.head();
  if (!adopted && isAncestor(git, upstream, before)) return { kind: 'up-to-date', upstream };
  if (adopted) out(`   the branch already holds the merged result: checking it and pushing it with the lease`);

  // Recovery point: both shas, as refs and in the record, before anything is rewritten.
  const oldBase = git.run('merge-base', before, upstream).trim();
  git.run('update-ref', `refs/sdlc-backup/${branch}/local`, before);
  git.run('update-ref', `refs/sdlc-backup/${branch}/remote`, remoteSha);
  const record = { branch, before, remoteSha, upstream, oldBase, at: stamp() };
  if (o.recordFile) fs.writeFileSync(o.recordFile, `${JSON.stringify(record, null, 2)}\n`);
  out(`   rebasing ${branch} (${before.slice(0, 7)}) onto ${remote}/${base} (${upstream.slice(0, 7)}); recovery refs refs/sdlc-backup/${branch}/{local,remote}`);

  const restore = (): string | undefined => {
    if (inRebase(git)) git.tryRun('rebase', '--abort');
    if (inCherryPick(git)) git.tryRun('cherry-pick', '--abort');
    const now = git.head();
    if (now === before) return undefined;
    git.run('update-ref', `refs/sdlc-attempt/${branch}`, now);
    git.run('reset', '-q', '--hard', before);
    return `refs/sdlc-attempt/${branch}`;
  };
  const stopped = (reason: string, offer: boolean, conflict?: ConflictReport, checkFailed?: boolean): ResolveOutcome =>
    ({ kind: 'stopped', reason, offer, conflict, resolved, attempt: restore(), ...(checkFailed ? { checkFailed } : {}) });

  let codeResolved = false;
  try {
    // A rebase that stops on a conflict "fails"; the loop below works through each stop.
    git.tryRun('-c', 'core.editor=true', 'rebase', upstream);
    let round = 0;
    while (inRebase(git)) {
      const files = conflicted(git);
      const head = sha(git, 'REBASE_HEAD');
      const commit = { sha: head, subject: head ? git.run('log', '-1', '--format=%s', head).trim() : '' };
      // Past <commit>: the rebase finished, or stopped at a later commit (whose conflicts the next round takes).
      const moved = () => !inRebase(git) || sha(git, 'REBASE_HEAD') !== commit.sha;
      // --continue; a commit the resolution made empty (its change is already in the base) is skipped.
      const advance = (): boolean => {
        git.tryRun('-c', 'core.editor=true', 'rebase', '--continue');
        if (moved()) return true;
        if (conflicted(git).length) return false;
        git.tryRun('rebase', '--skip');
        return moved();
      };
      if (!files.length) {
        if (!advance()) return stopped(`the rebase stopped at ${commit.sha.slice(0, 7)} without a conflict and could not continue`, false);
        continue;
      }
      // Documentation: two sides that only added lines keep both; the same lines changed on both sides go to the resolver, which
      // keeps each document's meaning, structure and formatting (without a resolver, both sides are kept as before).
      const docFiles = files.filter(f => isDocFile(f, docDirs));
      const judged = o.resolveCode ? docFiles.filter(f => needsJudgment(git, f)) : [];
      const docs = docFiles.filter(f => !judged.includes(f));
      const code = [...files.filter(f => !isDocFile(f, docDirs)), ...judged];
      for (const f of docs) {
        keepBoth(git, f);
        resolved.push({ file: f, commit: commit.sha, kind: 'docs', why: 'documentation: kept both sides\' content' });
        out(`   resolved ${f} (documentation, kept both sides)`);
      }
      if (code.length) {
        round += 1;
        const sides = code.map(f => ({
          file: f,
          base: clip(git.tryRun('diff', oldBase, upstream, '--', f) || ''),
          task: clip(git.tryRun('show', '--format=', commit.sha, '--', f) || ''),
        }));
        const report = (doubt: string): ConflictReport => ({ commit, files: code, doubt, sides });
        if (!o.resolveCode) return stopped(`code conflict in ${code.join(', ')}`, true, report('no resolver for code conflicts'));
        const r = await o.resolveCode({ round, commit, files: code, docs, upstream, oldBase });
        if (!inRebase(git) || sha(git, 'REBASE_HEAD') !== commit.sha) {
          return stopped('the resolver changed the rebase itself (it must only edit the conflicted files)', true, report('the rebase was moved by the resolver'));
        }
        if (!r.safe) return stopped(`the conflict in ${code.join(', ')} could break this task or the merged work`, true, report(r.doubt || 'the resolver was not sure'));
        const left = code.filter(f => fs.existsSync(path.join(git.root, f)) && MARKERS.test(fs.readFileSync(path.join(git.root, f), 'utf8')));
        if (left.length) return stopped(`conflict markers left in ${left.join(', ')}`, true, report('the resolution left conflict markers'));
        for (const f of code) {
          if (fs.existsSync(path.join(git.root, f))) git.run('add', '--', f);
          else git.run('rm', '-q', '--cached', '--ignore-unmatch', '--', f);
          const why = r.files.find(x => x.file === f)?.why || 'resolved by the agent (no reason given)';
          resolved.push({ file: f, commit: commit.sha, kind: isDocFile(f, docDirs) ? 'docs' : 'code', why });
          out(`   resolved ${f}: ${why}`);
        }
        codeResolved = true;
      }
      if (!advance()) return stopped(`git rebase --continue failed at ${commit.sha.slice(0, 7)}`, false);
    }

    if (o.verify && !(await o.verify({ codeResolved }))) {
      return stopped('the check failed on the rebased branch', false, undefined, true);
    }

    // Push with the lease; when it fails someone pushed meanwhile: take what arrived, check again, push again.
    const arrived: string[] = [];
    const maxPushes = o.maxPushes ?? 3;
    for (let pushes = 1; ; pushes++) {
      const p = leasePush(git, remote, branch, remoteSha);
      if (p.ok) return { kind: 'pushed', resolved, head: git.head(), before, remoteBefore: record.remoteSha, pushes, arrived };
      if (!p.stale) return stopped(`git push failed: ${p.message}`, false);
      if (pushes >= maxPushes) return stopped(`the lease failed ${pushes} times: ${remote}/${branch} keeps moving`, false);
      if (git.tryRun('fetch', '-q', remote) === null) return stopped(`git fetch ${remote} failed after the lease failed`, false);
      const now = sha(git, remoteRef);
      if (!now) return stopped(`${remote}/${branch} was deleted meanwhile`, false);
      if (!isAncestor(git, remoteSha, now)) return stopped(`${remote}/${branch} was rewritten by someone else meanwhile`, false);
      const fresh = git.lines('rev-list', '--reverse', `${remoteSha}..${now}`);
      out(`   the lease failed: ${fresh.length} commit(s) arrived on ${remote}/${branch}; taking them onto the rebased branch`);
      for (const c of fresh) {
        if (git.run('rev-list', '--parents', '-n', '1', c).trim().split(' ').length > 2) {
          return stopped(`a merge commit (${c.slice(0, 7)}) arrived on ${remote}/${branch}: it cannot be replayed safely`, false);
        }
        if (git.tryRun('cherry-pick', c) === null) {
          if (conflicted(git).length || git.tryRun('cherry-pick', '--skip') === null) {
            return stopped(`the commit ${c.slice(0, 7)} that arrived on ${remote}/${branch} conflicts with the rebased branch`, true, undefined);
          }
        }
        arrived.push(c);
      }
      if (o.verify && !(await o.verify({ codeResolved }))) return stopped('the check failed once the arrived commits were added', false, undefined, true);
      remoteSha = now;
    }
  } catch (e) {
    restore();
    throw e;
  }
}

/** Finalise stamps `pr: <url>` into the brief and leaves it uncommitted: that is the pipeline's own change, not the user's. */
const isBriefOnly = (git: Git): string[] | null => {
  const dirty = git.run('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean);
  const files = dirty.map((l) => l.slice(3).trim());
  return dirty.length && dirty.every((l) => l[0] === ' ' && l[1] === 'M') && files.every((f) => path.basename(f) === 'brief.md') ? files : null;
};

/**
 * resolveConflictsOnCleanTree, after setting aside the pipeline's own uncommitted brief header (the PR link) and putting it back
 * on every exit. Any other uncommitted change still stops the stage.
 */
export async function resolveConflicts(o: ResolveOptions): Promise<ResolveOutcome> {
  const files = o.git.tryRun('rev-parse', '--git-dir') === null ? null : isBriefOnly(o.git);
  if (!files) return resolveConflictsOnCleanTree(o);
  const saved = files.map((f) => ({ f, text: fs.readFileSync(path.join(o.git.root, f), 'utf8') }));
  o.git.run('checkout', '--', ...files);
  try {
    return await resolveConflictsOnCleanTree(o);
  } finally {
    for (const { f, text } of saved) {
      const file = path.join(o.git.root, f);
      const header = /^---\n[\s\S]*?\n---\n/.exec(text)?.[0];
      // Put the header back on whatever the brief is now; a brief that was rewritten meanwhile keeps its own text.
      if (header && fs.existsSync(file)) {
        const now = fs.readFileSync(file, 'utf8');
        if (!now.startsWith('---\n')) fs.writeFileSync(file, `${header}\n${now.replace(/^\n+/, '')}`);
      }
    }
  }
}

/** What the check printed when it failed: the log it is in, the counts, and the tests that failed. */
export interface CheckFailure { log: string; passed?: number; failed?: number; names: string[]; /** The test run produced no report: it was stopped or crashed, so no test was judged. */ didNotRun?: boolean;
  /** The failing test files run on the base branch alone: they "fail" there too (not the merge's doing) or "passes". Unset when not run. */
  baseline?: 'fails' | 'passes' }

/** Reads the counts and the failing tests from a tests.log (its first line is "<name> (<runner>): N passed, M failed, …"; each failure is a "  FAIL  <test>" line). */
export function parseTestsLog(text: string, log: string): CheckFailure {
  const m = /(\d+) passed, (\d+) failed/.exec(text.split('\n', 1)[0] || '');
  const names = [...text.matchAll(/^\s+FAIL\s+(.+)$/gm)].map(x => x[1].trim());
  const didNotRun = Boolean(m) && Number(m![1]) === 0 && Number(m![2]) === 0 && (/\b[1-9]\d* file errors?\b/.test(text.split('\n', 1)[0]) || /no report/.test(text));
  return { log, ...(m ? { passed: Number(m[1]), failed: Number(m[2]) } : {}), names: [...new Set(names)], ...(didNotRun ? { didNotRun } : {}) };
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * A stop in plain words, for the top of the report, the run's output and the question: what happened, whether anything changed,
 * why it stopped and what to do. A stop never pushes and puts the branch back, so "nothing changed" is always true.
 */
export function plainStop(r: Extract<ResolveOutcome, { kind: 'stopped' }>, check?: CheckFailure): string[] {
  const fixed = r.resolved.length ? `Fixed the conflicts in ${plural(r.resolved.length, 'file')}` : 'No conflicting file was fixed yet';
  const untouched = 'Is anything changed? No: your pull request on GitHub and your branch are exactly as they were.';
  if (r.checkFailed && check?.didNotRun) {
    return [
      `What happened: ${fixed}, but the test run itself did not finish (it produced no report). Nothing was pushed.`,
      untouched,
      'Why it stopped: the tests were stopped or crashed before they could say anything, so nothing says the merge is wrong. This is usually a machine problem (another process killed it, or it ran out of memory or time).',
      `What you can do: press Resolve conflicts to try again, preferably while nothing else is running. ${check.log} shows what the test run printed.`,
    ];
  }
  if (r.checkFailed) {
    const tests = check?.failed
      ? `: ${plural(check.failed, 'test')} failed${check.passed !== undefined ? `, ${check.passed} passed` : ''}${check.names.length ? ` (${check.names.slice(0, 3).join('; ')}${check.names.length > 3 ? '; …' : ''})` : ''}`
      : '';
    const log = check?.log || 'the test log';
    if (check?.baseline === 'fails') {
      return [
        `What happened: ${fixed}, then the test check failed${tests}. Nothing was pushed.`,
        untouched,
        'Why it stopped: the same tests also fail on the base branch without your changes, so the merge did not cause them.',
        `What you can do: have them fixed on the base branch (or skipped there) first, then press Resolve conflicts again. ${log} shows the failures.`,
      ];
    }
    return [
      `What happened: ${fixed}, then the test check failed${tests}. Nothing was pushed.`,
      untouched,
      check?.baseline === 'passes'
        ? 'Why it stopped: those tests pass on the base branch alone, so the combination of the two sets of changes breaks them.'
        : 'Why it stopped: a test failed once both sets of changes were together. It may be a real clash between them, or a one-off failure.',
      `What you can do: ${r.attempt ? 'press Fix with Implement to let the agent repair the merged result (Test repair and Review still apply), ' : ''}press Resolve conflicts to try again, open ${log}, or fix it by hand.`,
    ];
  }
  if (r.conflict) {
    return [
      `What happened: the agent was not sure how to combine the changes in ${r.conflict.files.join(', ')}: ${r.conflict.doubt}. Nothing was pushed.`,
      untouched,
      'Why it stopped: it asks rather than risk breaking either side.',
      'What you can do: answer the question (yes adds a follow-up task that describes the conflict), or fix the conflict by hand and press Resolve conflicts again.',
    ];
  }
  return [
    `What happened: ${r.reason.charAt(0).toUpperCase()}${r.reason.slice(1)}. Nothing was pushed.`,
    untouched,
    'What you can do: fix that, then press Resolve conflicts again.',
  ];
}

/** The report of an outcome (written to <log>/resolve-conflicts.md and printed): a stop leads with plain words, the details follow. */
export function outcomeLines(r: ResolveOutcome, remote = 'origin', branch = '', check?: CheckFailure): string[] {
  switch (r.kind) {
    case 'skipped': return [`Skipped: ${r.reason}.`];
    case 'up-to-date': return [`Nothing to resolve: ${branch || 'the branch'} already contains ${r.upstream.slice(0, 7)}.`];
    case 'pushed': return [
      `Rebased ${r.before.slice(0, 7)} to ${r.head.slice(0, 7)} and pushed to ${remote}/${branch} with --force-with-lease (lease ${r.remoteBefore.slice(0, 7)}${r.pushes > 1 ? `, ${r.pushes} attempts` : ''}).`,
      ...(r.resolved.length ? r.resolved.map(f => `- ${f.file} (${f.kind}, commit ${f.commit.slice(0, 7)}): ${f.why}`) : ['- no conflicts: the commits replayed cleanly']),
      ...(r.arrived.length ? [`Also took ${r.arrived.length} commit(s) pushed meanwhile: ${r.arrived.map(c => c.slice(0, 7)).join(', ')}.`] : []),
    ];
    default: return [
      ...plainStop(r, check),
      '',
      'Details:',
      `Stopped without pushing: ${r.reason}.`,
      ...r.resolved.map(f => `- resolved before the stop: ${f.file} (${f.kind}): ${f.why}`),
      ...(r.conflict ? [`Conflict at ${r.conflict.commit.sha.slice(0, 7)} ${r.conflict.commit.subject}: ${r.conflict.files.join(', ')}`, `Doubt: ${r.conflict.doubt}`] : []),
      ...(r.attempt ? [`The rebased attempt is kept at ${r.attempt}; the branch is back where it was.`] : []),
    ];
  }
}

// ---- Follow-up backlog item: <slug>-resolve-conflict-N, added only with the user's yes ----

/**
 * The next free follow-up slug: <slug>-resolve-conflict-<N>, N one above the highest number any of <roots>' backlog
 * (index entries or item folders) already uses, starting at 1.
 */
export function nextFollowUpSlug(roots: string[], backlogDir: string, slug: string): string {
  const re = new RegExp(`^${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-resolve-conflict-(\\d+)$`);
  let max = 0;
  const see = (name: string) => { const m = re.exec(name); if (m) max = Math.max(max, Number(m[1])); };
  for (const root of new Set(roots)) {
    const dir = path.join(root, backlogDir);
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) see(e.name); } catch { /* no backlog here */ }
    try { for (const e of parseIndex(fs.readFileSync(path.join(dir, 'index.md'), 'utf8'))) see(e.slug); } catch { /* no index */ }
  }
  return `${slug}-resolve-conflict-${max + 1}`;
}

/** The follow-up item's brief: the conflict, both sides' intent and the open question. */
export function followUpBrief(o: {
  slug: string; newSlug: string; docs: string; base: string; reason: string; conflict?: ConflictReport;
  merged: Array<{ sha: string; subject: string; docs: string[] }>; record?: { before: string; remoteSha: string };
}): string {
  const c = o.conflict;
  return [
    `# ${o.newSlug}`, '', 'Type: bug', 'Priority: P2 (normal)', '',
    '## Problem',
    `Resolve conflicts for \`${o.slug}\` stopped without pushing: ${o.reason}.`, '',
    '## The conflict',
    ...(c ? [`- Commit being replayed: ${c.commit.sha.slice(0, 7)} ${c.commit.subject}`, ...c.files.map(f => `- ${f}`)] : ['- The rebase itself was clean; the check of the rebased branch failed (see the run\'s logs/tests.log).']),
    '',
    `## This task's intent (\`${o.slug}\`)`,
    `Read ${o.docs}/brief.md, ${o.docs}/specs-1.md and ${o.docs}/plan-1.md.`,
    ...(c ? c.sides.flatMap(s => [`### ${s.file}: this task's change`, '```diff', s.task || '(none)', '```']) : []),
    '',
    `## The merged work's intent (merged into ${o.base} since the branch started)`,
    ...(o.merged.length ? o.merged.map(m => `- ${m.sha.slice(0, 7)} ${m.subject}${m.docs.length ? ` (${m.docs.join(', ')})` : ''}`) : ['- (none found)']),
    ...(c ? c.sides.flatMap(s => [`### ${s.file}: ${o.base}'s change`, '```diff', s.base || '(none)', '```']) : []),
    '',
    '## Open question',
    c ? c.doubt : 'Which behaviour breaks once both sides are combined, and how should it be reconciled?',
    '',
    '## Recovery',
    ...(o.record ? [`- Branch tip before the rebase: ${o.record.before}`, `- Remote branch before the rebase: ${o.record.remoteSha}`] : []),
    '',
  ].join('\n');
}

/** The tasks merged into the base since the branch started: commit subjects, with their backlog documents when they have some. */
export function mergedTasks(git: Git, oldBase: string, upstream: string, backlogDir: string): Array<{ sha: string; subject: string; docs: string[] }> {
  const rows = (git.tryRun('log', '--format=%H%x09%s', `${oldBase}..${upstream}`) || '').split('\n').filter(Boolean);
  return rows.map(row => {
    const [sha, ...rest] = row.split('\t');
    const subject = rest.join('\t');
    const items = new Set<string>();
    const scope = /^[a-z]+\(([a-z0-9][a-z0-9-]*)\)!?:/.exec(subject);
    if (scope) items.add(scope[1]);
    for (const f of (git.tryRun('show', '--name-only', '--format=', sha, '--', backlogDir) || '').split('\n').filter(Boolean)) {
      const m = new RegExp(`^${backlogDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/`).exec(f);
      if (m) items.add(m[1]);
    }
    const docs: string[] = [];
    for (const it of items) {
      for (const name of ['brief.md', 'specs-1.md', 'plan-1.md']) {
        const p = `${backlogDir}/${it}/${name}`;
        if (git.tryRun('cat-file', '-e', `${upstream}:${p}`) !== null) docs.push(p);
      }
    }
    return { sha, subject, docs };
  });
}

// ---- The stage ----

const FOLLOW_UP = 'resolve-conflict-followup.md';

/** SDLC_RESOLVE_CONFLICTS=0 (or false/off/skip) skips the stage after Finalise. */
export const resolveSkipped = (env: NodeJS.ProcessEnv): boolean => /^(0|false|off|no|skip)$/i.test(env.SDLC_RESOLVE_CONFLICTS || '');

/** The agent's report (<log>/resolve-conflicts-report.md): "FILE: <path> :: <why>" lines, "VERDICT: SAFE|DOUBT", "DOUBT: <text>". */
export function parseResolverReport(text: string): CodeResolution {
  const files: CodeResolution['files'] = [];
  let verdict = '';
  const doubts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const f = /^FILE:\s*(.+?)\s*::\s*(.+)$/.exec(line.trim());
    if (f) files.push({ file: f[1], why: f[2] });
    const v = /^VERDICT:\s*(SAFE|DOUBT)\s*$/.exec(line.trim());
    if (v) verdict = v[1];
    const d = /^DOUBT:\s*(.+)$/.exec(line.trim());
    if (d) doubts.push(d[1]);
  }
  const safe = verdict === 'SAFE' && doubts.length === 0;
  return { safe, files, doubt: safe ? undefined : (doubts.join(' ') || (verdict ? 'the resolver doubts the resolution' : 'the resolver wrote no verdict')) };
}

/**
 * After a failed check: do the failing test files also fail on the base branch alone? (The branch is checked out at the base for
 * the run and back again; the run's logs are not touched.) The answer is written to <log>/baseline-check.json.
 */
function baselineCheck(ctx: Ctx, base: string, branch: string): void {
  const file = at(ctx, `${ctx.log}/baseline-check.json`);
  fs.rmSync(file, { force: true });
  const check = checkFailure(ctx);
  const files = failingTestFiles(check.names, f => fs.existsSync(at(ctx, f)));
  const upstream = ctx.git.tryRun('rev-parse', '--verify', '-q', `refs/remotes/origin/${base}`)?.trim();
  if (!files.length || !upstream || check.didNotRun) return;
  ctx.out(`   checking whether ${plural(files.length, 'failing test file')} also fail${files.length === 1 ? 's' : ''} on ${base} alone`);
  let passedOnBase: boolean | undefined;
  try {
    ctx.git.run('checkout', '-q', '--detach', upstream);
    const r = runSuites(ctx.config, { root: ctx.root, files, env: ctx.env });
    passedOnBase = !('error' in r) && r.merged.ok;
  } catch { passedOnBase = undefined; } finally {
    ctx.git.run('checkout', '-q', branch);
  }
  if (passedOnBase === undefined) return;
  fs.writeFileSync(file, `${JSON.stringify({ files, upstream, passedOnBase, at: stamp() }, null, 2)}\n`);
  ctx.out(`   on ${base} alone: ${passedOnBase ? 'they pass, so the merge breaks them' : 'they fail too, so the merge did not cause them'}`);
}

/** The failed check of the rebased branch, as its log shows it (the unit tests' log, or the integration suite's). */
function checkFailure(ctx: Ctx): CheckFailure {
  const log = ctx.failLog || `${ctx.log}/tests.log`;
  let out: CheckFailure;
  try { out = parseTestsLog(fs.readFileSync(at(ctx, log), 'utf8'), log); } catch { out = { log, names: [] }; }
  try {
    const b = JSON.parse(fs.readFileSync(at(ctx, `${ctx.log}/baseline-check.json`), 'utf8')) as { passedOnBase?: boolean };
    if (typeof b.passedOnBase === 'boolean') out.baseline = b.passedOnBase ? 'passes' : 'fails';
  } catch { /* the baseline was not run */ }
  return out;
}

/** The full check of the rebased branch: every suite and the integration suite (with tests.fullSuite "ci", the task's tests here and the rest in CI). */
async function fullCheck(ctx: Ctx): Promise<boolean> {
  await tick();
  const ciOnly = (ctx.config.tests as { fullSuite?: string } | undefined)?.fullSuite === 'ci';
  const targets = ciOnly ? targetTestFiles(ctx) : [];
  if (ciOnly) ctx.out('   tests.fullSuite is "ci": the task\'s tests run here, the full suite in CI on the pushed branch');
  const unit = testsPass(ctx, ciOnly && targets.length ? { targetFiles: targets, onlyTargets: true } : {});
  await tick();
  if (!unit) { ctx.failLog = `${ctx.log}/tests.log`; return false; }
  if (!(await integrationPass(ctx))) { ctx.failLog = `${ctx.log}/integration.log`; return false; }
  return true;
}

// ---- Fixing the merged result: Implement on the kept attempt ----

/** What the pipeline writes when it takes the kept attempt as the branch (<log>/merge-fix.json): the push later checks the remote is unchanged. */
export interface MergeFix { attempt: string; before: string; remoteSha: string; upstream: string; at: string }

export type AdoptResult = (MergeFix & { ok: true }) | { ok: false; reason: string };

/**
 * Makes the kept attempt (refs/sdlc-attempt/<branch>, the rebased branch whose check failed) the branch, so the Implement stage
 * can repair it. Only when nothing has moved since: the branch is still where the stage left it and has no uncommitted changes.
 * The remote is not touched; the old tip stays at refs/sdlc-backup/<branch>/local.
 */
export function adoptAttempt(git: Git, branch: string, recordFile: string): AdoptResult {
  const attempt = sha(git, `refs/sdlc-attempt/${branch}`);
  if (!attempt) return { ok: false, reason: `there is no kept attempt for ${branch}: press Resolve conflicts first` };
  let record: { before?: string; remoteSha?: string; upstream?: string } = {};
  try { record = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { /* no record */ }
  if (!record.before || !record.remoteSha || !record.upstream) return { ok: false, reason: `the record of the last attempt (${path.basename(recordFile)}) is missing: press Resolve conflicts again` };
  if (git.head() !== record.before) return { ok: false, reason: `${branch} has moved since the attempt was made: press Resolve conflicts again` };
  if (git.run('status', '--porcelain', '--untracked-files=no').trim()) return { ok: false, reason: `${branch} has uncommitted changes: commit or discard them first` };
  git.run('reset', '-q', '--hard', attempt);
  return { ok: true, attempt, before: record.before, remoteSha: record.remoteSha, upstream: record.upstream, at: stamp() };
}

/** The test files named by failing tests ("<file> :: <test>"), keeping the ones that exist. */
export function failingTestFiles(names: string[], exists: (file: string) => boolean): string[] {
  return [...new Set(names.map(n => n.split(' :: ')[0].trim()).filter(f => f && exists(f)))];
}

/** The input Implement gets after a merge: what failed, with the log's tail and what was merged. Written to <docs>/merge-failure.md. */
export function mergeFailureText(o: {
  slug: string; base: string; check: CheckFailure; logTail: string; merged: Array<{ sha: string; subject: string }>;
}): string {
  const c = o.check;
  return [
    `# ${o.slug}: the merged branch fails its checks`, '',
    `The branch was brought up to date with ${o.base}: the conflicts are resolved, but the check of the result failed${c.passed !== undefined ? ` (${c.passed} passed, ${c.failed ?? 0} failed)` : ''}.`,
    ...(c.baseline === 'passes' ? ['The same tests pass on the base branch alone, so the merge caused the failure.'] : []),
    '',
    '## Failing',
    ...(c.names.length ? c.names.map(n => `- ${n}`) : [`- (no test named: see ${c.log})`]),
    '',
    `## Output (the end of ${c.log})`, '```', o.logTail.trim() || '(empty)', '```', '',
    `## Merged into ${o.base} since the branch started`,
    ...(o.merged.length ? o.merged.map(m => `- ${m.sha.slice(0, 7)} ${m.subject}`) : ['- (none found)']),
    '',
  ].join('\n');
}

// ---- Independent review of a resolution the agent doubts ----

/** The reviewers, each with its own agent and model (so their mistakes differ). The first SDLC_RESOLVE_REVIEWERS of them review (3 by default). */
export const REVIEWERS = ['resolve-review-1', 'resolve-review-2', 'resolve-review-3', 'resolve-review-4', 'resolve-review-5'] as const;
export const DEFAULT_REVIEWERS = 3;

/** How many reviewers judge a doubt: SDLC_RESOLVE_REVIEWERS, 0 to 5 (3 when unset or not a number). 0 leaves a doubt to the developer. */
export function reviewerCount(env: NodeJS.ProcessEnv): number {
  const v = (env.SDLC_RESOLVE_REVIEWERS || '').trim();
  if (!/^\d+$/.test(v)) return DEFAULT_REVIEWERS;
  return Math.min(REVIEWERS.length, Number(v));
}

/** SDLC_RESOLVE_REVIEW=0 (or false/off/no/skip), or no reviewers, leaves a doubt to the developer, as before the reviewers existed. */
export const reviewSkipped = (env: NodeJS.ProcessEnv): boolean => /^(0|false|off|no|skip)$/i.test(env.SDLC_RESOLVE_REVIEW || '') || reviewerCount(env) === 0;

/** The reviewers (1-based) that share an agent and model, by "<agent>:<model>": independent opinions need different ones. */
export function sharedReviewers(keys: string[]): Array<{ model: string; reviewers: number[] }> {
  const by = new Map<string, number[]>();
  keys.forEach((k, i) => by.set(k, [...(by.get(k) || []), i + 1]));
  return [...by].filter(([, n]) => n.length > 1).map(([model, reviewers]) => ({ model, reviewers }));
}

/** The same, in words for the output and the report; empty when every reviewer has its own agent and model. */
export function sharedReviewersText(keys: string[]): string {
  return sharedReviewers(keys).map(g => `reviewers ${g.reviewers.join(' and ')} use the same model (${g.model})`).join('; ');
}

/** A reviewer's last "VERDICT: SAFE" or "VERDICT: UNSAFE" line; anything else (no verdict, a failed agent) counts as UNSAFE. */
export function reviewVerdict(text: string): 'SAFE' | 'UNSAFE' {
  const last = [...text.matchAll(/^\s*VERDICT:\s*(SAFE|UNSAFE)\b/gim)].pop();
  return last && last[1].toUpperCase() === 'SAFE' ? 'SAFE' : 'UNSAFE';
}

/** The rule: the doubt is overridden only when all <count> reviewers say SAFE. */
export const unanimouslySafe = (verdicts: string[], count: number): boolean => count > 0 && verdicts.length === count && verdicts.every(v => v === 'SAFE');

/**
 * The agent doubted its resolution: the reviewers (read-only, 3 by default) judge it independently (in parallel, none sees another's answer).
 * All of them SAFE: the resolution goes on to the full check and the push. Otherwise the judge agent writes one plain conclusion
 * and the doubt stays, now with the opinions, for the developer. The opinions are kept in <log>/resolve-review.md.
 */
async function reviewDoubt(ctx: Ctx, c: CodeConflict, r: CodeResolution): Promise<CodeResolution> {
  const count = reviewerCount(ctx.env);
  const panel = REVIEWERS.slice(0, count);
  const shared = sharedReviewersText(panel.map(st => stageModelKey(ctx, st)));
  if (shared) {
    // Reviewers on the same model make the same mistakes: their agreement would prove little, so none is asked.
    const msg = `Independent review was not run: ${shared}. Give each reviewer its own agent or model, or lower the number of reviewers.`;
    ctx.out(`   ${msg}`);
    fs.writeFileSync(at(ctx, `${ctx.log}/resolve-review.md`), `# Independent review of the resolution of ${c.files.join(', ')} (${stamp()})\n\n${msg}\n`);
    return { ...r, safe: false, doubt: `${r.doubt || 'the resolver was not sure'} ${msg}` };
  }
  ctx.out(`   the agent is not sure: ${plural(count, 'independent reviewer')} judge${count === 1 ? 's' : ''} the resolution`);
  ctx.status.agent = 'resolve-review';
  ctx.status.agentStarted = stamp();
  ctx.status.write();
  const run = async (stage: AgentStage, name: string, promptName: string): Promise<{ rc: number; text: string }> => {
    const prompt = renderPrompt(promptName, promptValues(ctx), ctx.guide, ctx.promptsDir, stageNotes(ctx, stage));
    const rc = await runAudit(ctx, prompt, stageFlags(ctx, stage), { stage, name });
    const file = at(ctx, `${ctx.log}/${name}.log`);
    return { rc, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
  };
  const opinions = await Promise.all(panel.map(async (stage, i) => {
    const o = await run(stage, `${stage}-${c.round}`, 'resolve-review');
    const verdict = o.rc === 0 ? reviewVerdict(o.text) : 'UNSAFE';
    ctx.out(`   reviewer ${i + 1} (${stage}): ${o.rc === 0 ? verdict : `UNSAFE (the agent failed, exit ${o.rc})`}`);
    return { stage, verdict, text: o.rc === 0 ? o.text.trim() : `(the reviewer failed with exit ${o.rc})` };
  }));
  const verdicts = opinions.map(o => o.verdict);
  const safeCount = verdicts.filter(v => v === 'SAFE').length;
  const all = unanimouslySafe(verdicts, count);

  let conclusion = '';
  if (!all) {
    fs.writeFileSync(at(ctx, `${ctx.log}/resolve-review-input.md`), [
      `# The reviewers' opinions on the resolution of ${c.files.join(', ')}`, '',
      `The agent's doubt: ${r.doubt || '(none given)'}`, '',
      ...opinions.flatMap((o, i) => [`## Reviewer ${i + 1} (${o.stage}): ${o.verdict}`, '', o.text, '']),
    ].join('\n'));
    const j = await run('resolve-judge', `resolve-judge-${c.round}`, 'resolve-judge');
    conclusion = j.rc === 0 ? j.text.trim().slice(0, 1500) : '';
  }
  fs.writeFileSync(at(ctx, `${ctx.log}/resolve-review.md`), [
    `# Independent review of the resolution of ${c.files.join(', ')} (${stamp()})`, '',
    `The agent's doubt: ${r.doubt || '(none given)'}`, '',
    `Result: ${safeCount} of ${count} reviewers found it safe. ${all ? 'The doubt is overridden: the check and the push go on.' : 'The doubt stays: nothing is pushed.'}`, '',
    ...(conclusion ? ['## Conclusion', '', conclusion, ''] : []),
    ...opinions.flatMap((o, i) => [`## Reviewer ${i + 1} (${o.stage}): ${o.verdict}`, '', o.text, '']),
  ].join('\n'));
  if (all) {
    ctx.out(`   ${count === 1 ? 'the reviewer' : `all ${count} reviewers`} found it safe: the doubt is overridden (${ctx.log}/resolve-review.md)`);
    const note = `the agent doubted this; ${count === 1 ? 'the independent reviewer' : `all ${count} independent reviewers`} found it safe`;
    return { safe: true, files: c.files.map(f => ({ file: f, why: `${r.files.find(x => x.file === f)?.why || 'resolved by the agent'} (${note})` })) };
  }
  ctx.out(`   ${safeCount} of ${count} reviewers found it safe: the doubt stays (${ctx.log}/resolve-review.md)`);
  return { ...r, safe: false, doubt: `${r.doubt || 'the resolver was not sure'} Independent review: ${safeCount} of ${count} reviewers found it safe.${conclusion ? ` ${conclusion.replace(/\s*\n\s*/g, ' ')}` : ''}` };
}

/** Writes what the agent needs for one stop: the commit, the files, both sides, the task's and the merged tasks' documents. */
function writeContext(ctx: Ctx, c: CodeConflict): void {
  const g = ctx.git;
  const merged = mergedTasks(g, c.oldBase, c.upstream, ctx.config.backlogDir);
  const lines = [
    `# Conflict ${c.round} while rebasing ${ctx.branch}`, '',
    `Commit being replayed (this task's side): ${c.commit.sha} ${c.commit.subject}`,
    `Rebased onto: ${c.upstream} (the base). The branch had started from ${c.oldBase}.`, '',
    '## Conflicted files (resolve these)', ...c.files.map(f => `- ${f}`), '',
    ...(c.docs.length ? ['## Documentation in the same commit, already resolved by keeping both sides', ...c.docs.map(f => `- ${f}`), ''] : []),
    `## This task's commitments`, `- ${ctx.docs}/brief.md`, `- ${ctx.docs}/specs-1.md`, `- ${ctx.docs}/plan-1.md`, '',
    '## Tasks merged into the base since the branch started',
    ...(merged.length ? merged.map(m => `- ${m.sha.slice(0, 7)} ${m.subject}${m.docs.length ? `: read ${m.docs.join(', ')}` : ''}`) : ['- (none found)']), '',
  ];
  for (const f of c.files) {
    lines.push(`## ${f}`, '', "### The base's change since the branch started", '```diff', clip(g.tryRun('diff', c.oldBase, c.upstream, '--', f) || '(none)', 300), '```', '',
      "### This task's change in the commit being replayed", '```diff', clip(g.tryRun('show', '--format=', c.commit.sha, '--', f) || '(none)', 300), '```', '');
  }
  fs.writeFileSync(at(ctx, `${ctx.log}/resolve-conflicts-context.md`), `${lines.join('\n')}\n`);
}

/** The follow-up question in questions.md: a yes adds the item, anything else (the suggestion included) does not. */
function askFollowUp(ctx: Ctx, newSlug: string): void {
  const file = at(ctx, `${ctx.docs}/questions.md`);
  fs.writeFileSync(file, [
    `# Questions for ${ctx.slug}`, '',
    `### Q1: Add a follow-up task for this conflict (\`${newSlug}\`)?`,
    `The agent could not safely combine this branch with the latest ${ctx.config.git.base || 'main'}. Nothing was pushed and your pull request is unchanged. What happened is in ${ctx.log}/resolve-conflicts.md; the draft task is ${ctx.log}/${FOLLOW_UP}. Answer yes to add the task to ${ctx.backlog}; anything else adds nothing and leaves the conflict to you.`,
    '',
    '**Suggested:** no (read the report first; nothing is added without your yes)',
    '',
    '**Answer:**', '',
  ].join('\n'));
}

/** The plain lines at the top of the last attempt's report (the first line of an older report): what it found, before its details. */
function lastReportHeadline(ctx: Ctx): string[] {
  let text = '';
  try { text = fs.readFileSync(at(ctx, `${ctx.log}/resolve-conflicts.md`), 'utf8'); } catch { return []; }
  const lines = text.split('\n').slice(1).filter(l => l.trim());
  const end = lines.findIndex(l => /^Details:/.test(l));
  return (end >= 0 ? lines.slice(0, end) : lines.slice(0, 1)).map(l => `   ${l}`);
}

/** A resumed stage with the follow-up question answered: yes adds the item (the run is done), no leaves it to the user. */
function answerFollowUp(ctx: Ctx): void {
  const qFile = at(ctx, `${ctx.docs}/questions.md`);
  const draft = at(ctx, `${ctx.log}/${FOLLOW_UP}`);
  const q = parseQuestions(withAnswerLines(fs.readFileSync(qFile, 'utf8')))[0];
  if (!q || !q.answer.trim()) stop(ctx, `PAUSED: answer the follow-up question in ${ctx.docs}/questions.md (yes adds the item), then resume: ${resumeCommand(ctx.slug, 'resolve-conflicts')}`, 2);
  fs.rmSync(qFile);
  if (!/^(yes|y|add)\b/i.test(q.answer.trim())) {
    fs.rmSync(draft, { force: true });
    // Say again what the last attempt found: the answer alone ("no") leaves the user with nothing to go on.
    for (const l of lastReportHeadline(ctx)) ctx.out(l);
    stop(ctx, `You answered no, so no follow-up task was added. Your pull request and branch are unchanged. Press Resolve conflicts to try again (it starts from the latest ${ctx.config.git.base || 'main'}), or fix the conflict by hand: ${resumeCommand(ctx.slug, 'resolve-conflicts')}`, 2);
  }
  const main = projectRoot(ctx.root, ctx.env);
  const newSlug = nextFollowUpSlug([main, ctx.root], ctx.config.backlogDir, ctx.slug);
  const text = fs.readFileSync(draft, 'utf8').replace(/^# .*$/m, `# ${newSlug}`);
  addBacklogItem({ root: main, backlogDir: ctx.config.backlogDir }, {
    slug: newSlug, type: 'bug', title: `resolve the conflict between ${ctx.slug} and the work merged into ${ctx.config.git.base || 'main'}`, brief: text,
  });
  fs.rmSync(draft, { force: true });
  ctx.out(`Added the follow-up item ${newSlug} to ${path.join(main, ctx.config.backlogDir, 'index.md')} (not committed).`);
}

/** Set when the PR is merged: GitHub says so, or the task's red-tests commit is in <base> (a squash keeps its message). */
function mergedReason(ctx: Ctx, base: string): string | null {
  const briefFile = at(ctx, `${ctx.docs}/brief.md`);
  const url = fs.existsSync(briefFile) ? getPrFromBrief(fs.readFileSync(briefFile, 'utf8')) : null;
  const pr = getPrStatus(ctx.root, url || ctx.branch, ctx.env);
  if (pr?.state === 'MERGED') return `the pull request is already merged (${pr.url}): nothing to resolve`;
  for (const ref of [`origin/${base}`, base]) {
    if (ctx.git.tryRun('log', ref, '-1', '--format=%h', `--grep=^test(${ctx.slug}): add failing tests`)?.trim()) {
      return `${ctx.slug} is already merged into ${base}: nothing to resolve`;
    }
  }
  return null;
}

/** <log>/merge-fix.json when the branch holds an adopted attempt that is not pushed yet: what the lease push checks the remote against. */
function readMergeFix(ctx: Ctx): { remoteSha: string } | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(at(ctx, `${ctx.log}/merge-fix.json`), 'utf8')) as Partial<MergeFix>;
    return m.remoteSha ? { remoteSha: m.remoteSha } : undefined;
  } catch { return undefined; }
}

/**
 * SDLC_ON_ATTEMPT=1 with FROM=implement ("Fix with Implement"): the kept attempt becomes the branch, and the failure it ended with
 * becomes Implement's input (<docs>/merge-failure.md). Implement, Test repair, Review and Finalise then run as usual, and the Resolve
 * conflicts stage that ends the run checks the result and pushes it with the lease. Runs before the run sets the old logs aside.
 */
export function adoptKeptAttempt(ctx: Ctx): void {
  if (ctx.fromN !== 4) stop(ctx, 'ERROR: SDLC_ON_ATTEMPT=1 works only with FROM=implement');
  const base = ctx.config.git.base || 'main';
  const adoption = adoptAttempt(ctx.git, ctx.branch, at(ctx, `${ctx.log}/resolve-conflicts.json`));
  if ('reason' in adoption) return stop(ctx, `ERROR: cannot fix the merged result: ${adoption.reason}`);
  const a = adoption;
  const check = checkFailure(ctx);
  let logTail = '';
  try { logTail = fs.readFileSync(at(ctx, check.log), 'utf8').split('\n').slice(-80).join('\n'); } catch { /* no log */ }
  const merged = mergedTasks(ctx.git, ctx.git.tryRun('merge-base', a.before, a.upstream)?.trim() || a.before, a.upstream, ctx.config.backlogDir);
  fs.writeFileSync(at(ctx, `${ctx.docs}/merge-failure.md`), mergeFailureText({ slug: ctx.slug, base, check, logTail, merged: merged.map(m => ({ sha: m.sha, subject: m.subject })) }));
  fs.writeFileSync(at(ctx, `${ctx.log}/merge-fix.json`), `${JSON.stringify(a, null, 2)}\n`);
  ctx.out(`   the kept merged result is now ${ctx.branch} (${a.attempt.slice(0, 7)}; the old tip stays at refs/sdlc-backup/${ctx.branch}/local): Implement repairs it with ${ctx.docs}/merge-failure.md`);
}

/**
 * Resolve conflicts: after Finalise (or started by hand on a finished run), brings the PR branch up to date with the base.
 * Skipped without a stage of its own when there is no remote branch, or with SDLC_RESOLVE_CONFLICTS=0.
 */
export async function resolveConflictsStage(ctx: Ctx): Promise<void> {
  if (resolveSkipped(ctx.env)) {
    if (!ctx.status.stage) ctx.status.stage = ctx.priorStage || '';
    ctx.out(`${RESOLVE_STAGE}: skipped (SDLC_RESOLVE_CONFLICTS=${ctx.env.SDLC_RESOLVE_CONFLICTS})`);
    return;
  }
  if (!reviewSkipped(ctx.env)) {
    const shared = sharedReviewersText(REVIEWERS.slice(0, reviewerCount(ctx.env)).map(st => stageModelKey(ctx, st)));
    if (shared) ctx.out(`   WARNING: ${shared}; if the agent doubts a resolution, no reviewer will be asked. Give each its own agent or model.`);
  }
  const questions = at(ctx, `${ctx.docs}/questions.md`);
  if (ctx.from === 'resolve-conflicts' && fs.existsSync(at(ctx, `${ctx.log}/${FOLLOW_UP}`)) && fs.existsSync(questions)) {
    stage(ctx, RESOLVE_STAGE);
    answerFollowUp(ctx);
    return;
  }
  const base = ctx.config.git.base || 'main';
  const recordFile = at(ctx, `${ctx.log}/resolve-conflicts.json`);
  const result = await resolveConflicts({
    git: ctx.git, branch: ctx.branch, base, docDirs: [ctx.config.backlogDir], recordFile, out: l => ctx.out(l),
    mergedReason: () => mergedReason(ctx, base),
    onStart: () => { stage(ctx, RESOLVE_STAGE); ctx.status.attempt = '1/1'; ctx.status.write(); },
    resolveCode: async c => {
      writeContext(ctx, c);
      const report = at(ctx, `${ctx.log}/resolve-conflicts-report.md`);
      fs.rmSync(report, { force: true });
      await runAgent(ctx, `resolve-conflicts-${c.round}`, 'resolve-conflicts');
      const text = fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '';
      const r = parseResolverReport(text);
      // Only a stated doubt is reviewed: a missing report or verdict means the agent did not finish.
      return !r.safe && /^\s*VERDICT:\s*DOUBT/im.test(text) && !reviewSkipped(ctx.env) ? reviewDoubt(ctx, c, r) : r;
    },
    verify: async () => {
      const ok = await fullCheck(ctx);
      if (!ok) baselineCheck(ctx, base, ctx.branch);
      return ok;
    },
    adopted: readMergeFix(ctx),
  });
  const check = result.kind === 'stopped' && result.checkFailed ? checkFailure(ctx) : undefined;
  const lines = outcomeLines(result, 'origin', ctx.branch, check);
  if (result.kind === 'skipped') {
    // No stage ran: a run started here stays at the stage it had (Finalise).
    if (!ctx.status.stage) ctx.status.stage = ctx.priorStage || '';
    ctx.out(`${RESOLVE_STAGE}: ${lines[0]}`);
    return;
  }
  fs.writeFileSync(at(ctx, `${ctx.log}/resolve-conflicts.md`), `# ${RESOLVE_STAGE} (${stamp()})\n\n${lines.join('\n')}\n`);
  for (const l of lines) ctx.out(l);
  if (result.kind === 'pushed') {
    setAside(ctx, [`${ctx.log}/merge-fix.json`]);
    // The rebase rewrote the red-tests commit (and the Test repair one): later resumes find them by their messages.
    ctx.origRedSha = ctx.git.findCommit([redPattern(ctx.slug)]);
    ctx.redSha = ctx.git.findCommit([redPattern(ctx.slug), repairPattern(ctx.slug)]) || ctx.origRedSha;
    ctx.lockSha = ctx.git.head();
    if (ctx.redSha) ctx.out(`   tests commit is now ${ctx.redSha.slice(0, 7)}`);
  }
  if (result.kind !== 'stopped') return;
  if (!result.offer) {
    const next = result.checkFailed ? 'Press Resolve conflicts to try again' : 'Resume when fixed';
    stop(ctx, `${RESOLVE_STAGE} stopped, nothing pushed: ${result.reason}. ${next}: ${resumeCommand(ctx.slug, 'resolve-conflicts')}`, 1);
  }
  let record: { before: string; remoteSha: string; oldBase?: string; upstream?: string } | undefined;
  try { record = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { record = undefined; }
  const merged = record?.oldBase && record.upstream ? mergedTasks(ctx.git, record.oldBase, record.upstream, ctx.config.backlogDir) : [];
  const newSlug = nextFollowUpSlug([projectRoot(ctx.root, ctx.env), ctx.root], ctx.config.backlogDir, ctx.slug);
  fs.writeFileSync(at(ctx, `${ctx.log}/${FOLLOW_UP}`), followUpBrief({ slug: ctx.slug, newSlug, docs: ctx.docs, base, reason: result.reason, conflict: result.conflict, merged, record }));
  askFollowUp(ctx, newSlug);
  stop(ctx, `PAUSED: ${RESOLVE_STAGE} did not push (${result.reason}). Answer yes in ${ctx.docs}/questions.md to add the follow-up item ${newSlug}, then resume: ${resumeCommand(ctx.slug, 'resolve-conflicts')}`, 2);
}
