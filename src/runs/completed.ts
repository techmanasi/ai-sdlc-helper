// Completed tasks: query completed tasks from the backlog and git, derive commits and diffs
// directly from git for resilience across machines where local run records do not exist.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '../trace.js';
import { backlogItems, parseBrief, parseIndex } from '../backlog/index.js';
import { readRecord, type RunRecord } from './records.js';
import { cleanMainBrief } from '../pipeline/pr-link.js';
import { liveBranch, liveBriefPr, pickBase, runWorktree, type RunContext } from './index.js';
import { keepError } from '../pipeline/errors.js';
import { createOrGetPr, fetchPrComments, getPrFromBrief, getPrStatus, getPrStatusAsync, prPollOptions, recordPrInBrief, type PrStatus } from '../pipeline/finalise.js';

export interface CompletedTask {
  slug: string;
  title: string;
  type: string | null;
  priority: string | null;
  branch: string;
  base: string;
  pr: string | null;
  prState?: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  archived: boolean;
  date: string | null;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface FileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface CompletedTaskDetail extends CompletedTask {
  brief: string;
  commits: CommitInfo[];
  files: FileChange[];
  diffStat: string;
  prComments?: string | null;
}

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 });

/** Checks if an index line is in the ## Archive section of index.md. */
export function isArchivedInIndex(indexText: string, slug: string): boolean {
  const lines = indexText.split(/\r?\n/);
  let inArchive = false;
  for (const line of lines) {
    if (/^##\s+Archive/i.test(line)) {
      inArchive = true;
      continue;
    }
    if (inArchive && line.includes(`\`${slug}\``)) {
      return true;
    }
  }
  return false;
}

/** What the Completed list needs to know of a slug before it asks GitHub: the PR key is the brief's PR, else the branch. */
function completedSlugsOf(ctx: RunContext) {
  const indexFile = path.join(ctx.root, ctx.backlogDir, 'index.md');
  const indexText = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  const entries = parseIndex(indexText);
  const completedSlugs = new Set<string>();
  for (const entry of entries) {
    if (entry.marker.toLowerCase() === 'x' || isArchivedInIndex(indexText, entry.slug)) completedSlugs.add(entry.slug);
  }
  let recordNames: string[] = [];
  try { recordNames = fs.readdirSync(ctx.reg); } catch { /* no local records */ }
  for (const name of recordNames) {
    if (name.endsWith('.json')) {
      const slug = name.slice(0, -5);
      const rec = readRecord(ctx.reg, slug);
      if (rec && rec.exit_code === '0') completedSlugs.add(slug);
    }
  }
  return { indexText, entries, completedSlugs };
}

/** The PR key of each completed slug (the brief's PR link, else the branch), for fetching all the statuses at once. */
function completedPrKeys(ctx: RunContext): string[] {
  const { completedSlugs } = completedSlugsOf(ctx);
  const keys: string[] = [];
  for (const slug of completedSlugs) {
    const rec = readRecord(ctx.reg, slug);
    const briefFile = path.join(ctx.root, ctx.backlogDir, slug, 'brief.md');
    const pr = getPrFromBrief(fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : '');
    keys.push(pr || (rec && rec.branch) || `${ctx.branchPrefix}${slug}`);
  }
  return keys;
}

/** Lists all completed tasks in the project (asks GitHub for each PR, one after another: for the CLI and tests). */
export function listCompletedTasks(ctx: RunContext): CompletedTask[] {
  return completedTasks(ctx, key => getPrStatus(ctx.root, key, ctx.env));
}

/** Runs <fn> over <items> with at most <limit> at a time. */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The web server's version of listCompletedTasks: the PR statuses come from the cache (stale-while-revalidate) or, for
 * the ones never read, from asynchronous gh calls, four at a time, so the event loop is never blocked.
 */
export async function listCompletedTasksAsync(ctx: RunContext): Promise<CompletedTask[]> {
  const known = new Map<string, PrStatus | null>();
  await pooled([...new Set(completedPrKeys(ctx))], 4, async key => { known.set(key, (await getPrStatusAsync(ctx.root, key, ctx.env, prPollOptions(ctx.env))).status); });
  return completedTasks(ctx, key => known.get(key) ?? null);
}

/**
 * A run with its own worktree whose pull request <mergedPr> is merged: the link linkPrEverywhere wrote into the main checkout's
 * brief is taken out again (see cleanMainBrief). A failure is kept in the run worktree's errors.log, or in the run registry's
 * (<git dir>/sdlc-runs/errors.log) once the worktree is gone, and said on stderr: this path has no run output.
 */
export function cleanMergedRunBrief(ctx: RunContext, slug: string, rec: Partial<RunRecord> | null, mergedPr: string): void {
  const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  // A run in the main checkout itself has no copy there to clean.
  if (!rec?.worktree || real(rec.worktree) === real(ctx.root)) return;
  const wt = runWorktree(ctx, slug);
  const where = wt ? { root: wt, log: path.join(ctx.backlogDir, slug, 'logs') } : { root: ctx.reg, log: '' };
  cleanMainBrief({
    root: ctx.root, rel: path.join(ctx.backlogDir, slug, 'brief.md'), mergedPr, env: ctx.env,
    keepError: (w, t) => keepError(where, w, t),
    out: l => { process.stderr.write(`${l}\n`); },
  });
}

function completedTasks(ctx: RunContext, prOf: (key: string) => PrStatus | null): CompletedTask[] {
  const { indexText, entries, completedSlugs } = completedSlugsOf(ctx);
  const items = backlogItems({ root: ctx.root, backlogDir: ctx.backlogDir, branchPrefix: ctx.branchPrefix });
  const itemMap = new Map((items ? items.items : []).map(i => [i.slug, i]));

  const defaultBase = pickBase(ctx) || 'main';
  const out: CompletedTask[] = [];

  for (const slug of completedSlugs) {
    const item = itemMap.get(slug);
    const entry = entries.find(e => e.slug === slug);
    const rec = readRecord(ctx.reg, slug);
    const docsDir = path.join(ctx.root, ctx.backlogDir, slug);
    const briefFile = path.join(docsDir, 'brief.md');
    const briefText = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : '';
    let pr = getPrFromBrief(briefText);
    const briefMeta = parseBrief({ root: ctx.root, backlogDir: ctx.backlogDir }, slug);
    const branch = (rec && rec.branch) || `${ctx.branchPrefix}${slug}`;
    const base = (rec && rec.base) || defaultBase;
    const archived = isArchivedInIndex(indexText, slug);

    // Query live PR status
    const prStatus = prOf(pr || branch);
    if (!pr && prStatus?.url) {
      pr = prStatus.url;
      // A run with a worktree gets its link on the PR branch (when the PR is created); the main checkout stays unedited.
      if (!runWorktree(ctx, slug)) try {
        const updated = recordPrInBrief(briefText, pr);
        fs.writeFileSync(briefFile, updated);
      } catch (e) {
        // The list still shows the link; the brief that could not take it says why in the task's errors.log.
        keepError({ root: ctx.root, log: path.join(ctx.backlogDir, slug, 'logs') }, 'completed tasks: link pull request in the brief', `${briefFile}: ${(e as Error).message}`);
      }
    }

    const prState = prStatus ? prStatus.state : null;
    if (prStatus?.state === 'MERGED') cleanMergedRunBrief(ctx, slug, rec, prStatus.url);
    const isMarkedDoneInIndex = entry && (entry.marker.toLowerCase() === 'x' || isArchivedInIndex(indexText, slug));

    // RULE: A task with a PR is only completed once the PR is MERGED into base.
    // If GitHub reports the PR as OPEN or CLOSED (not merged), it is not completed.
    if (pr && prStatus && prStatus.state !== 'MERGED') {
      continue;
    }
    // If a PR exists but cannot be checked (e.g. offline/mock in tests), only accept if explicitly marked in index.md
    if (pr && !prStatus && !isMarkedDoneInIndex) {
      continue;
    }

    // Derive date
    let date = (rec && (rec.finished || rec.started)) || null;
    if (!date) {
      const r = git(ctx.root, ['log', '-1', '--format=%cI', branch], ctx.env);
      if (r.status === 0 && r.stdout.trim()) date = r.stdout.trim();
    }

    out.push({
      slug,
      title: item ? item.title : slug,
      type: (item && item.type) || briefMeta.type,
      priority: (item && item.priority) || briefMeta.priority,
      branch,
      base,
      pr,
      prState,
      archived,
      date,
    });
  }

  // Sort: most recent first
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

/** Resolves the git branch ref: checks local branch, then origin remote branch. */
function resolveGitRef(root: string, branch: string, env: NodeJS.ProcessEnv): string {
  if (git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], env).status === 0) {
    return branch;
  }
  if (git(root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`], env).status === 0) {
    return `origin/${branch}`;
  }
  return branch;
}

/** Returns full details for a completed task directly from git and brief files (asks GitHub synchronously: for the CLI and tests). */
export function getCompletedTaskDetail(ctx: RunContext, slug: string): CompletedTaskDetail {
  return completedDetail(ctx, slug, key => getPrStatus(ctx.root, key, ctx.env));
}

/** The web server's version of getCompletedTaskDetail: the PR status comes from the cache or an asynchronous gh call. */
export async function getCompletedTaskDetailAsync(ctx: RunContext, slug: string): Promise<CompletedTaskDetail> {
  const rec = readRecord(ctx.reg, slug);
  const briefFile = path.join(ctx.root, ctx.backlogDir, slug, 'brief.md');
  const pr = getPrFromBrief(fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : '');
  const key = pr || (rec && rec.branch) || `${ctx.branchPrefix}${slug}`;
  const status = (await getPrStatusAsync(ctx.root, key, ctx.env, prPollOptions(ctx.env))).status;
  return completedDetail(ctx, slug, k => (k === key ? status : null));
}

function completedDetail(ctx: RunContext, slug: string, prOf: (key: string) => PrStatus | null): CompletedTaskDetail {
  const indexFile = path.join(ctx.root, ctx.backlogDir, 'index.md');
  const indexText = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  const items = backlogItems({ root: ctx.root, backlogDir: ctx.backlogDir, branchPrefix: ctx.branchPrefix });
  const item = (items ? items.items : []).find(i => i.slug === slug);
  const rec = readRecord(ctx.reg, slug);
  const docsDir = path.join(ctx.root, ctx.backlogDir, slug);
  const briefFile = path.join(docsDir, 'brief.md');
  const briefText = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : '';
  let pr = getPrFromBrief(briefText);
  const briefMeta = parseBrief({ root: ctx.root, backlogDir: ctx.backlogDir }, slug);
  const defaultBase = pickBase(ctx) || 'main';
  const branch = (rec && rec.branch) || `${ctx.branchPrefix}${slug}`;
  const base = (rec && rec.base) || defaultBase;
  const archived = isArchivedInIndex(indexText, slug);

  // If no PR in brief.md, the branch's PR (when the project has a remote) gives both the link and the state.
  let branchStatus: PrStatus | null = null;
  if (!pr) {
    try {
      const v = git(ctx.root, ['config', '--get', 'remote.origin.url'], ctx.env);
      if (v.status === 0) {
        branchStatus = prOf(branch);
        if (branchStatus && branchStatus.url.startsWith('http')) pr = branchStatus.url;
      }
    } catch { /* ignore */ }
  }

  // Derive git info: commits, diffStat, and changed files
  const ref = resolveGitRef(ctx.root, branch, ctx.env);
  const commits: CommitInfo[] = [];
  const files: FileChange[] = [];
  let diffStat = '';
  let date = (rec && (rec.finished || rec.started)) || null;

  // Commits between base and ref
  const logRes = git(ctx.root, ['log', '--format=%H%x09%an%x09%cI%x09%s', `${base}..${ref}`], ctx.env);
  if (logRes.status === 0 && logRes.stdout.trim()) {
    for (const line of logRes.stdout.trim().split('\n')) {
      const [sha, author, cdate, ...rest] = line.split('\t');
      if (sha) commits.push({ sha, author: author || '', date: cdate || '', message: rest.join('\t') });
    }
    if (!date && commits[0]?.date) date = commits[0].date;
  }

  // Changed files
  const nameRes = git(ctx.root, ['diff', '--name-status', `${base}...${ref}`], ctx.env);
  const numRes = git(ctx.root, ['diff', '--numstat', `${base}...${ref}`], ctx.env);
  const statRes = git(ctx.root, ['diff', '--stat', `${base}...${ref}`], ctx.env);

  if (statRes.status === 0) diffStat = statRes.stdout.trim();

  const numMap = new Map<string, { additions: number; deletions: number }>();
  if (numRes.status === 0 && numRes.stdout.trim()) {
    for (const line of numRes.stdout.trim().split('\n')) {
      const [add, del, filePath] = line.split(/\s+/);
      if (filePath) numMap.set(filePath, { additions: parseInt(add, 10) || 0, deletions: parseInt(del, 10) || 0 });
    }
  }

  if (nameRes.status === 0 && nameRes.stdout.trim()) {
    for (const line of nameRes.stdout.trim().split('\n')) {
      const [status, ...pParts] = line.split(/\s+/);
      const filePath = pParts.join(' ');
      if (filePath) {
        const stats = numMap.get(filePath) || { additions: 0, deletions: 0 };
        files.push({ path: filePath, status: status || 'M', additions: stats.additions, deletions: stats.deletions });
      }
    }
  }

  const prCommentsFile = path.join(docsDir, 'pr-comments.md');
  const prComments = fs.existsSync(prCommentsFile) ? fs.readFileSync(prCommentsFile, 'utf8') : null;
  const prStatus = branchStatus && pr === branchStatus.url ? branchStatus : prOf(pr || branch);

  return {
    slug,
    title: item ? item.title : slug,
    type: (item && item.type) || briefMeta.type,
    priority: (item && item.priority) || briefMeta.priority,
    branch,
    base,
    pr: pr || prStatus?.url || null,
    prState: prStatus ? prStatus.state : null,
    archived,
    date,
    brief: briefText,
    commits,
    files,
    diffStat,
    prComments,
  };
}

/** Fetches discussion comments and inline diff comments from GitHub and saves them to pr-comments.md. */
export function syncPrComments(
  ctx: RunContext,
  slug: string,
): { ok: boolean; pr?: string | null; markdown: string; count: number; err?: string[] } {
  const docsDir = path.join(ctx.root, ctx.backlogDir, slug);
  const briefFile = path.join(docsDir, 'brief.md');
  const briefText = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : '';
  // A run that moved to a new branch: its worktree's brief holds the new link, and its branch is the one it is on now.
  const pr = liveBriefPr(ctx, slug, getPrFromBrief) || getPrFromBrief(briefText);
  const branch = liveBranch(ctx, slug);

  const target = pr || branch;
  const res = fetchPrComments(ctx.root, target, ctx.env);
  if (!res.ok) {
    return { ok: false, markdown: '', count: 0, err: res.err };
  }

  // Save to pr-comments.md in docsDir
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'pr-comments.md'), res.markdown);

  // If worktree exists, also write there
  const worktree = runWorktree(ctx, slug);
  if (worktree) {
    const wtDocs = path.join(worktree, ctx.backlogDir, slug);
    fs.mkdirSync(wtDocs, { recursive: true });
    fs.writeFileSync(path.join(wtDocs, 'pr-comments.md'), res.markdown);
  }

  return { ok: true, pr: res.pr, markdown: res.markdown, count: res.comments.length };
}

/** Creates a PR for a completed task that does not have one yet. */
export function createPrForCompleted(
  ctx: RunContext,
  slug: string,
): { ok: boolean; pr: string | null; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const rec = readRecord(ctx.reg, slug);
  const branch = (rec && rec.branch) || `${ctx.branchPrefix}${slug}`;
  const base = (rec && rec.base) || pickBase(ctx) || 'main';
  const docsDir = path.join(ctx.root, ctx.backlogDir, slug);
  const briefFile = path.join(docsDir, 'brief.md');
  const briefText = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : '';

  // Push branch to origin
  out.push(`Pushing branch ${branch} to origin...`);
  const pushRes = git(ctx.root, ['push', '-u', 'origin', branch], ctx.env);
  if (pushRes.status !== 0) {
    err.push(`Push warning: ${pushRes.stderr.trim()}`);
  } else {
    out.push(`Pushed ${branch} to origin.`);
  }

  // Create PR
  const title = `feat(${slug}): implement task`;
  const body = `Completed SDLC implementation for \`${slug}\`.\n\n${briefText.slice(0, 500)}`;
  const prUrl = createOrGetPr(ctx.root, branch, title, body, base);

  if (!prUrl) {
    err.push('Failed to create PR with gh CLI. Ensure gh is installed and authenticated.');
    return { ok: false, pr: null, out, err };
  }

  out.push(`PR created: ${prUrl}`);

  // Record the PR in brief.md on the PR branch only: in the run's worktree, where that branch is checked out (the main
  // checkout is touched only when it is the one on the branch), never as a stray edit in the main checkout.
  const briefRel = path.join(ctx.backlogDir, slug, 'brief.md');
  const wt = runWorktree(ctx, slug);
  // The link is committed to the PR branch and pushed at once, so no checkout is left with an uncommitted brief.
  let committed = false;
  for (const dir of [ctx.root, wt]) {
    if (!dir || git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.env).stdout.trim() !== branch) continue;
    const file = path.join(dir, briefRel);
    if (!fs.existsSync(file)) continue;
    fs.writeFileSync(file, recordPrInBrief(fs.readFileSync(file, 'utf8'), prUrl));
    git(dir, ['add', '--', briefRel], ctx.env);
    const c = git(dir, ['commit', '-q', '-m', `chore(${slug}): link pull request`, '--', briefRel], ctx.env);
    if (c.status !== 0) { err.push(`Could not commit the PR link: ${c.stderr.trim()}`); continue; }
    const push = git(dir, ['push', 'origin', branch], ctx.env);
    if (push.status !== 0) err.push(`Push warning (PR link): ${push.stderr.trim()}`);
    else { out.push('Committed the PR link in brief.md and pushed it to the branch.'); committed = true; }
    break;
  }
  if (!committed) out.push('The PR link was not committed: no checkout has the PR branch.');

  return { ok: true, pr: prUrl, out, err };
}
