// The Resolve conflicts stage, after Finalise: fetch the base branch, rebase the run's branch onto it (a straight line, no
// merge commits), resolve conflicts commit by commit, verify, and push with --force-with-lease (never a bare --force).
// Documentation conflicts are resolved by keeping both sides; a code or test conflict goes to an agent, and any doubt
// stops the stage without pushing and offers a follow-up backlog item (<slug>-resolve-conflict-N) the user may add.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addBacklogItem, parseIndex } from '../backlog/index.js';
import { parseQuestions } from '../runs/view.js';
import { projectRoot } from '../runs/records.js';
import { withAnswerLines } from './questions.js';
import { at, stamp, stop, tick, type Ctx } from './context.js';
import { runAgent } from './agent.js';
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
  /** Conflicted code and test files, still with their markers. */
  files: string[];
  /** Documentation files of the same commit, already resolved by keeping both sides. */
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
  | { kind: 'stopped'; reason: string; offer: boolean; conflict?: ConflictReport; resolved: FileResolution[]; attempt?: string };

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
  /** Called once the stage has something to do (the branch is on the remote and the base was fetched). */
  onStart?: () => void;
  /** Resolves a stop on code or test files; without one, such a stop ends the stage. */
  resolveCode?: (c: CodeConflict) => Promise<CodeResolution>;
  /** The full check of the rebased branch; false stops the stage without pushing. */
  verify?: (o: { codeResolved: boolean }) => Promise<boolean>;
  /** Push attempts (a failed lease fetches, takes what arrived and tries again). Default 3. */
  maxPushes?: number;
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

/**
 * Brings <branch> up to date with <remote>/<base>: nothing to do when the branch already contains the base; otherwise a
 * rebase, conflicts resolved commit by commit, the check, and a push with the lease. Every stop leaves the local branch
 * where it was and the remote untouched (a rebased attempt is kept under refs/sdlc-attempt/<branch>).
 */
export async function resolveConflicts(o: ResolveOptions): Promise<ResolveOutcome> {
  const { git, branch, out } = o;
  const remote = o.remote || 'origin';
  const base = o.base || 'main';
  const docDirs = o.docDirs || [];
  const resolved: FileResolution[] = [];

  if (git.tryRun('remote', 'get-url', remote) === null) return { kind: 'skipped', reason: `no ${remote} remote: nothing to bring up to date` };
  if (git.tryRun('fetch', '-q', remote) === null) return { kind: 'stopped', reason: `git fetch ${remote} failed`, offer: false, resolved };
  const remoteRef = `refs/remotes/${remote}/${branch}`;
  let remoteSha = sha(git, remoteRef);
  if (!remoteSha) return { kind: 'skipped', reason: `${branch} is not on ${remote} (Finalise did not push it): nothing to bring up to date` };
  const upstream = sha(git, `refs/remotes/${remote}/${base}`);
  if (!upstream) return { kind: 'skipped', reason: `${remote}/${base} does not exist` };
  o.onStart?.();

  if (git.run('rev-parse', '--abbrev-ref', 'HEAD').trim() !== branch) git.run('checkout', '-q', branch);
  if (git.run('status', '--porcelain', '--untracked-files=no').trim()) {
    return { kind: 'stopped', reason: `${branch} has uncommitted changes: commit or discard them first`, offer: false, resolved };
  }
  // Commits pushed to the PR branch from elsewhere come first (a fast-forward); a branch that diverged is not rewritten.
  if (!isAncestor(git, remoteSha, 'HEAD')) {
    if (!isAncestor(git, 'HEAD', remoteSha)) {
      return { kind: 'stopped', reason: `${branch} and ${remote}/${branch} have diverged: reconcile them first`, offer: false, resolved };
    }
    git.run('merge', '-q', '--ff-only', remoteSha);
    out(`   fast-forwarded ${branch} to ${remote}/${branch} (${remoteSha.slice(0, 7)})`);
  }
  const before = git.head();
  if (isAncestor(git, upstream, before)) return { kind: 'up-to-date', upstream };

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
  const stopped = (reason: string, offer: boolean, conflict?: ConflictReport): ResolveOutcome =>
    ({ kind: 'stopped', reason, offer, conflict, resolved, attempt: restore() });

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
      const docs = files.filter(f => isDocFile(f, docDirs));
      const code = files.filter(f => !isDocFile(f, docDirs));
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
          resolved.push({ file: f, commit: commit.sha, kind: 'code', why });
          out(`   resolved ${f}: ${why}`);
        }
        codeResolved = true;
      }
      if (!advance()) return stopped(`git rebase --continue failed at ${commit.sha.slice(0, 7)}`, false);
    }

    if (o.verify && !(await o.verify({ codeResolved }))) {
      return stopped('the check failed on the rebased branch', true, undefined);
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
      if (o.verify && !(await o.verify({ codeResolved }))) return stopped('the check failed once the arrived commits were added', true, undefined);
      remoteSha = now;
    }
  } catch (e) {
    restore();
    throw e;
  }
}

/** The report of an outcome, one line per file (written to <log>/resolve-conflicts.md and printed). */
export function outcomeLines(r: ResolveOutcome, remote = 'origin', branch = ''): string[] {
  switch (r.kind) {
    case 'skipped': return [`Skipped: ${r.reason}.`];
    case 'up-to-date': return [`Nothing to resolve: ${branch || 'the branch'} already contains ${r.upstream.slice(0, 7)}.`];
    case 'pushed': return [
      `Rebased ${r.before.slice(0, 7)} to ${r.head.slice(0, 7)} and pushed to ${remote}/${branch} with --force-with-lease (lease ${r.remoteBefore.slice(0, 7)}${r.pushes > 1 ? `, ${r.pushes} attempts` : ''}).`,
      ...(r.resolved.length ? r.resolved.map(f => `- ${f.file} (${f.kind}, commit ${f.commit.slice(0, 7)}): ${f.why}`) : ['- no conflicts: the commits replayed cleanly']),
      ...(r.arrived.length ? [`Also took ${r.arrived.length} commit(s) pushed meanwhile: ${r.arrived.map(c => c.slice(0, 7)).join(', ')}.`] : []),
    ];
    default: return [
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
    `### Q1: Add the follow-up backlog item \`${newSlug}\`?`,
    `Resolve conflicts stopped without pushing (see ${ctx.log}/resolve-conflicts.md). The draft brief, with the conflict, both sides' intent and the open question, is ${ctx.log}/${FOLLOW_UP}. Answer yes to add it to ${ctx.backlog}; anything else adds nothing and leaves the conflict to you.`,
    '',
    '**Suggested:** no (read the report first; nothing is added without your yes)',
    '',
    '**Answer:**', '',
  ].join('\n'));
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
    stop(ctx, `No follow-up item added. Resolve the conflict by hand, or resume at Resolve conflicts to try again: ${resumeCommand(ctx.slug, 'resolve-conflicts')}`, 1);
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
    onStart: () => { stage(ctx, RESOLVE_STAGE); ctx.status.attempt = '1/1'; ctx.status.write(); },
    resolveCode: async c => {
      writeContext(ctx, c);
      const report = at(ctx, `${ctx.log}/resolve-conflicts-report.md`);
      fs.rmSync(report, { force: true });
      await runAgent(ctx, `resolve-conflicts-${c.round}`, 'resolve-conflicts');
      return parseResolverReport(fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '');
    },
    verify: () => fullCheck(ctx),
  });
  const lines = outcomeLines(result, 'origin', ctx.branch);
  if (result.kind === 'skipped') {
    // No stage ran: a run started here stays at the stage it had (Finalise).
    if (!ctx.status.stage) ctx.status.stage = ctx.priorStage || '';
    ctx.out(`${RESOLVE_STAGE}: ${lines[0]}`);
    return;
  }
  fs.writeFileSync(at(ctx, `${ctx.log}/resolve-conflicts.md`), `# ${RESOLVE_STAGE} (${stamp()})\n\n${lines.join('\n')}\n`);
  for (const l of lines) ctx.out(l);
  if (result.kind === 'pushed') {
    // The rebase rewrote the red-tests commit (and the Test repair one): later resumes find them by their messages.
    ctx.origRedSha = ctx.git.findCommit([redPattern(ctx.slug)]);
    ctx.redSha = ctx.git.findCommit([redPattern(ctx.slug), repairPattern(ctx.slug)]) || ctx.origRedSha;
    ctx.lockSha = ctx.git.head();
    if (ctx.redSha) ctx.out(`   tests commit is now ${ctx.redSha.slice(0, 7)}`);
  }
  if (result.kind !== 'stopped') return;
  if (!result.offer) stop(ctx, `${RESOLVE_STAGE} stopped: ${result.reason}. Resume when fixed: ${resumeCommand(ctx.slug, 'resolve-conflicts')}`, 1);
  let record: { before: string; remoteSha: string; oldBase?: string; upstream?: string } | undefined;
  try { record = JSON.parse(fs.readFileSync(recordFile, 'utf8')); } catch { record = undefined; }
  const merged = record?.oldBase && record.upstream ? mergedTasks(ctx.git, record.oldBase, record.upstream, ctx.config.backlogDir) : [];
  const newSlug = nextFollowUpSlug([projectRoot(ctx.root, ctx.env), ctx.root], ctx.config.backlogDir, ctx.slug);
  fs.writeFileSync(at(ctx, `${ctx.log}/${FOLLOW_UP}`), followUpBrief({ slug: ctx.slug, newSlug, docs: ctx.docs, base, reason: result.reason, conflict: result.conflict, merged, record }));
  askFollowUp(ctx, newSlug);
  stop(ctx, `PAUSED: ${RESOLVE_STAGE} did not push (${result.reason}). Answer yes in ${ctx.docs}/questions.md to add the follow-up item ${newSlug}, then resume: ${resumeCommand(ctx.slug, 'resolve-conflicts')}`, 2);
}
