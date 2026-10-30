// Completed tasks: query completed tasks from the backlog and git, derive commits and diffs
// directly from git for resilience across machines where local run records do not exist.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { backlogItems, parseBrief, parseIndex } from '../backlog/index.js';
import { readRecord } from './records.js';
import { pickBase, runWorktree, type RunContext } from './index.js';
import { createOrGetPr, fetchPrComments, getPrFromBrief, getPrStatus, recordPrInBrief } from '../pipeline/finalise.js';

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

/** Lists all completed tasks in the project. */
export function listCompletedTasks(ctx: RunContext): CompletedTask[] {
  const indexFile = path.join(ctx.root, ctx.backlogDir, 'index.md');
  const indexText = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  const entries = parseIndex(indexText);
  const items = backlogItems({ root: ctx.root, backlogDir: ctx.backlogDir, branchPrefix: ctx.branchPrefix });
  const itemMap = new Map((items ? items.items : []).map(i => [i.slug, i]));

  const completedSlugs = new Set<string>();
  for (const entry of entries) {
    if (entry.marker.toLowerCase() === 'x' || isArchivedInIndex(indexText, entry.slug)) {
      completedSlugs.add(entry.slug);
    }
  }

  // Also check run records for done runs
  let recordNames: string[] = [];
  try { recordNames = fs.readdirSync(ctx.reg); } catch { /* no local records */ }
  for (const name of recordNames) {
    if (name.endsWith('.json')) {
      const slug = name.slice(0, -5);
      const rec = readRecord(ctx.reg, slug);
      if (rec && rec.exit_code === '0') completedSlugs.add(slug);
    }
  }

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
    const prStatus = getPrStatus(ctx.root, pr || branch, ctx.env);
    if (!pr && prStatus?.url) {
      pr = prStatus.url;
      try {
        const updated = recordPrInBrief(briefText, pr);
        fs.writeFileSync(briefFile, updated);
      } catch { /* best effort */ }
    }

    const prState = prStatus ? prStatus.state : null;
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

/** Returns full details for a completed task directly from git and brief files. */
export function getCompletedTaskDetail(ctx: RunContext, slug: string): CompletedTaskDetail {
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

  // If no PR in brief.md, check via gh pr view/list
  if (!pr) {
    try {
      const v = git(ctx.root, ['config', '--get', 'remote.origin.url'], ctx.env);
      if (v.status === 0) {
        const ghView = spawnSync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { cwd: ctx.root, encoding: 'utf8' });
        if (ghView.status === 0 && ghView.stdout.trim().startsWith('http')) {
          pr = ghView.stdout.trim();
        }
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
  const prStatus = getPrStatus(ctx.root, pr || branch, ctx.env);

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
  const pr = getPrFromBrief(briefText);
  const rec = readRecord(ctx.reg, slug);
  const branch = (rec && rec.branch) || `${ctx.branchPrefix}${slug}`;

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

  // Record PR in brief.md
  if (fs.existsSync(briefFile)) {
    const updated = recordPrInBrief(fs.readFileSync(briefFile, 'utf8'), prUrl);
    fs.writeFileSync(briefFile, updated);
    const briefRel = path.relative(ctx.root, briefFile);
    const curBranch = git(ctx.root, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.env).stdout.trim();
    if (curBranch === branch) {
      git(ctx.root, ['add', '--', briefRel], ctx.env);
      git(ctx.root, ['commit', '-q', '-m', `chore(${slug}): link pull request`, '--', briefRel], ctx.env);
      git(ctx.root, ['push', 'origin', branch], ctx.env);
      out.push('Updated brief.md and committed PR link to branch.');
    } else {
      out.push('Updated brief.md with PR link.');
    }
  }

  return { ok: true, pr: prUrl, out, err };
}
