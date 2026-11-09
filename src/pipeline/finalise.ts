// The Finalise stage: commit exactly the files this cycle changed, tick the backlog item, report what was skipped,
// and optionally push to origin and create a GitHub PR, recording the PR link in brief.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { spawnSync, trace } from '../trace.js';
import { has } from '../util.js';
import { changed, mirror, type Baseline } from '../changes/index.js';
import type { Git } from './git.js';

export interface FinaliseOptions {
  git: Git;
  slug: string;
  /** The item's folder, from the root. */
  docs: string;
  /** The baseline taken at the start of the cycle, from the root. */
  baseline: string;
  /** The backlog index, from the root. */
  backlog: string;
  maxBytes?: number;
  /** Copy keys added to a git-ignored .env into .env.example (finalise.envExample). */
  envExample?: boolean;
  createPr?: boolean;
  baseBranch?: string;
  out(line: string): void;
  err(line: string): void;
}

export interface FinaliseResult {
  committed: number;
  pr: string | null;
}

/** Parses the PR URL from brief.md frontmatter or body. */
export function getPrFromBrief(text: string): string | null {
  const fmM = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmM) {
    const prLine = fmM[1].match(/^pr:\s*(\S+)/im);
    if (prLine) return prLine[1].trim();
  }
  const bodyM = text.match(/^(?:PR|pr):\s*(https?:\/\/\S+)/im);
  return bodyM ? bodyM[1].trim() : null;
}

/** Inserts or updates the PR URL in brief.md frontmatter. */
export function recordPrInBrief(text: string, prUrl: string): string {
  if (/^---\r?\n([\s\S]*?)\r?\n---/.test(text)) {
    return text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, fm) => {
      if (/^pr:\s*.*$/im.test(fm)) {
        return `---\n${fm.replace(/^pr:\s*.*$/im, `pr: ${prUrl}`).trim()}\n---`;
      }
      return `---\n${fm.trim()}\npr: ${prUrl}\n---`;
    });
  }
  if (/^PR:\s*.*$/im.test(text)) {
    return text.replace(/^PR:\s*.*$/im, `PR: ${prUrl}`);
  }
  return `---\npr: ${prUrl}\n---\n\n${text.trimStart()}`;
}

/** Finds or creates a GitHub PR for the branch. */
export function createOrGetPr(cwd: string, branch: string, title: string, body: string, base?: string, opts: { draft?: boolean } = {}): string | null {
  // Check if PR already exists
  try {
    const view = spawnSync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { cwd, encoding: 'utf8' });
    if (view.status === 0 && view.stdout.trim().startsWith('http')) {
      return view.stdout.trim();
    }
  } catch { /* gh might not be installed or authenticated */ }

  try {
    const list = spawnSync('gh', ['pr', 'list', '--head', branch, '--json', 'url', '-q', '.[0].url'], { cwd, encoding: 'utf8' });
    if (list.status === 0 && list.stdout.trim().startsWith('http')) {
      return list.stdout.trim();
    }
  } catch { /* best effort */ }

  // Create PR
  try {
    const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body];
    if (base) args.push('--base', base);
    if (opts.draft) args.push('--draft');
    const create = spawnSync('gh', args, { cwd, encoding: 'utf8' });
    if (create.status === 0) {
      const match = (create.stdout + '\n' + create.stderr).match(/https?:\/\/[^\s]+/);
      if (match) {
        clearPrCache();
        return match[0].trim();
      }
    }
  } catch { /* best effort */ }

  return null;
}

/** The CI of a pull request: its checks are running, all passed, one failed, or it has none. */
export type CiState = 'in progress' | 'passed' | 'failed' | 'none';

/** Marks a draft PR ready for review (`gh pr ready`); true when gh succeeded. */
export function markPrReady(cwd: string, branchOrUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const r = spawnSync('gh', ['pr', 'ready', branchOrUrl], { cwd, encoding: 'utf8', env, timeout: 30_000 });
    clearPrCache();
    return r.status === 0;
  } catch { return false; }
}

/** One check of a PR's status rollup: a check run (status, conclusion, detailsUrl) or a commit status (state). */
export interface CheckRunStatus {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
}

export interface PrStatus {
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  number?: number;
  isDraft?: boolean;
  /** The raw checks of the PR (for matching them to a pushed commit). */
  statusCheckRollup?: CheckRunStatus[];
  /** The commit the PR's head is at (for matching checks to a pushed commit). */
  headRefOid?: string;
  /** From the PR's status checks (gh's statusCheckRollup); absent when the answer did not include them. */
  ci?: CiState;
  /** The names of the failing checks. */
  failing?: string[];
  /** Whether the branch merges into its base: 'conflicting' needs Resolve conflicts. Absent when the answer did not say. */
  conflicts?: 'none' | 'conflicting' | 'unknown';
}

const BAD_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const GOOD_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** GitHub's `mergeable` of a PR as the run page uses it. */
export function conflictsOf(mergeable: string): 'none' | 'conflicting' | 'unknown' {
  const m = mergeable.toUpperCase();
  return m === 'CONFLICTING' ? 'conflicting' : m === 'MERGEABLE' ? 'none' : 'unknown';
}

/** The CI state and the failing check names of gh's statusCheckRollup (check runs and commit statuses). Any failure is "failed", even while other checks still run. */
export function ciOf(rollup: unknown): { ci: CiState; failing: string[] } {
  const items = Array.isArray(rollup) ? rollup as Array<Record<string, unknown>> : [];
  if (!items.length) return { ci: 'none', failing: [] };
  const failing: string[] = [];
  let pending = false;
  for (const c of items) {
    const name = String(c.name || c.context || 'check');
    const done = c.status ? String(c.status).toUpperCase() === 'COMPLETED' : String(c.state || '').toUpperCase() !== 'PENDING' && String(c.state || '').toUpperCase() !== 'EXPECTED';
    const verdict = String((c.conclusion || c.state || '')).toUpperCase();
    if (!done) pending = true;
    else if (BAD_CONCLUSIONS.has(verdict)) failing.push(name);
    else if (!GOOD_CONCLUSIONS.has(verdict)) pending = true;
  }
  return { ci: failing.length ? 'failed' : pending ? 'in progress' : 'passed', failing: [...new Set(failing)] };
}

const PR_FIELDS = 'url,state,number,isDraft,statusCheckRollup,headRefOid,mergeable';

interface PrEntry { time: number; val: PrStatus | null; failed?: boolean }
const prCache = new Map<string, PrEntry>();
const inflight = new Map<string, Promise<PrStatus | null>>();
const PR_CACHE_TTL_MS = 60_000;
const PR_TIMEOUT_MS = 3000;
/** How often the web server asks GitHub again for a PR it already knows: once an hour (SDLC_PR_POLL_MS changes it). */
export const PR_POLL_MS = 3_600_000;

/** How a reader of the cache sees an entry: <ttlMs> is how long it counts as fresh; a failed refresh is tried again at once unless <retryFailed> is false. */
export interface PrReadOptions { ttlMs?: number; retryFailed?: boolean }

/** The web server's reading of the cache: a status is checked again only every hour, and a failed check waits as long. */
export function prPollOptions(env: NodeJS.ProcessEnv = process.env): PrReadOptions {
  const ms = Number(env.SDLC_PR_POLL_MS);
  return { ttlMs: Number.isFinite(ms) && ms > 0 ? ms : PR_POLL_MS, retryFailed: false };
}

/** Clears the in-memory PR cache (e.g. after creating or updating a PR). */
export function clearPrCache(): void {
  prCache.clear();
}

const prKey = (cwd: string, branchOrUrl: string): string => `${cwd}::${branchOrUrl.trim()}`;

function parsePr(stdout: string): PrStatus | null {
  try {
    const data = JSON.parse(stdout.trim());
    if (data && data.url) {
      return {
        url: data.url,
        state: (data.state || 'OPEN').toUpperCase() as 'OPEN' | 'MERGED' | 'CLOSED',
        number: typeof data.number === 'number' ? data.number : undefined,
        ...(Array.isArray(data.statusCheckRollup) ? ciOf(data.statusCheckRollup) : {}),
        ...(typeof data.mergeable === 'string' ? { conflicts: conflictsOf(data.mergeable) } : {}),
        ...(typeof data.isDraft === 'boolean' ? { isDraft: data.isDraft } : {}),
        ...(Array.isArray(data.statusCheckRollup) ? { statusCheckRollup: data.statusCheckRollup } : {}),
        ...(typeof data.headRefOid === 'string' ? { headRefOid: data.headRefOid } : {}),
      };
    }
  } catch { /* best effort */ }
  return null;
}

/** Queries live GitHub PR status using gh CLI with in-memory TTL caching. Blocks: for the pipeline and the CLI, not the web server. */
export function getPrStatus(
  cwd: string,
  branchOrUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): PrStatus | null {
  if (!branchOrUrl || !branchOrUrl.trim()) return null;
  const key = prKey(cwd, branchOrUrl);
  const now = Date.now();
  const hit = prCache.get(key);
  if (hit && now - hit.time < PR_CACHE_TTL_MS) {
    return hit.val;
  }

  let result: PrStatus | null = null;
  try {
    const view = spawnSync('gh', ['pr', 'view', branchOrUrl, '--json', PR_FIELDS], {
      cwd, encoding: 'utf8', env, timeout: PR_TIMEOUT_MS,
    });
    if (view.status === 0 && view.stdout.trim()) result = parsePr(view.stdout);
  } catch { /* best effort */ }

  const entry = { time: now, val: result };
  prCache.set(key, entry);
  if (result) prCache.set(prKey(cwd, result.url), entry);
  return result;
}

/** A PR status as the web server serves it: the last known value, how old it is, and whether the last refresh failed. */
export interface PrRead {
  status: PrStatus | null;
  /** Milliseconds since the value was read from GitHub; null when there is none yet. */
  ageMs: number | null;
  /** The value is older than the cache time, or the last refresh failed. */
  stale: boolean;
  /** Nothing is known yet; a refresh is running. */
  pending: boolean;
  /** The last check failed (the value, if any, is from an earlier one). */
  failed?: boolean;
}

type PrListener = (e: { cwd: string; branchOrUrl: string; status: PrStatus | null }) => void;
const prListeners = new Set<PrListener>();

/** Calls <fn> whenever a background refresh changes a PR status (or learns one for the first time). Returns the unsubscribe. */
export function onPrStatusChange(fn: PrListener): () => void {
  prListeners.add(fn);
  return () => { prListeners.delete(fn); };
}

/** One asynchronous gh call per key at a time; a failure keeps the old value and marks it stale. */
function refreshPrStatus(cwd: string, branchOrUrl: string, env: NodeJS.ProcessEnv): Promise<PrStatus | null> {
  const key = prKey(cwd, branchOrUrl);
  const running = inflight.get(key);
  if (running) return running;
  const t0 = performance.now();
  const p = new Promise<PrStatus | null>(resolve => {
    execFile('gh', ['pr', 'view', branchOrUrl, '--json', PR_FIELDS], { cwd, env, encoding: 'utf8', timeout: PR_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : -1) : 0;
      trace({ action: 'spawn:gh', why: 'pr', ms: Math.round((performance.now() - t0) * 1000) / 1000, code });
      const before = prCache.get(key);
      let status: PrStatus | null;
      // "no pull requests found" is GitHub's answer for a branch without a PR, not a failed check.
      const none = Boolean(err) && /no pull requests found/i.test(String(stderr || ''));
      if (none) {
        status = null;
        prCache.set(key, { time: Date.now(), val: null });
      } else if (err) {
        status = before ? before.val : null;
        prCache.set(key, { time: Date.now(), val: status, failed: true });
      } else {
        status = stdout.trim() ? parsePr(stdout) : null;
        const entry = { time: Date.now(), val: status };
        prCache.set(key, entry);
        // The same PR asked for by its link (a brief that now records it) is the same answer.
        if (status) prCache.set(prKey(cwd, status.url), entry);
      }
      inflight.delete(key);
      if ((!err || none) && (!before || JSON.stringify(before.val) !== JSON.stringify(status))) {
        for (const fn of prListeners) { try { fn({ cwd, branchOrUrl, status }); } catch { /* a listener must not break the refresh */ } }
      }
      resolve(status);
    });
  });
  inflight.set(key, p);
  return p;
}

function readEntry(e: PrEntry | undefined, now: number, o: PrReadOptions = {}): PrRead {
  if (!e) return { status: null, ageMs: null, stale: false, pending: true };
  const ageMs = now - e.time;
  // A merged PR does not change again: it is not asked for twice.
  if (e.val && e.val.state === 'MERGED' && !e.failed) return { status: e.val, ageMs, stale: false, pending: false };
  const stale = (e.failed && o.retryFailed !== false) || ageMs >= (o.ttlMs ?? PR_CACHE_TTL_MS);
  return { status: e.val, ageMs, stale, pending: false, ...(e.failed ? { failed: true } : {}) };
}

/**
 * The PR status without waiting: the cached value at once (with its age), and a refresh in the background when it is
 * older than the cache time. With nothing cached it answers pending and starts the refresh. Never blocks the event loop.
 */
export function getPrStatusCached(cwd: string, branchOrUrl: string, env: NodeJS.ProcessEnv = process.env, o: PrReadOptions = {}): PrRead {
  if (!branchOrUrl || !branchOrUrl.trim()) return { status: null, ageMs: null, stale: false, pending: false };
  const e = prCache.get(prKey(cwd, branchOrUrl));
  const r = readEntry(e, Date.now(), o);
  if (!e || r.stale) void refreshPrStatus(cwd, branchOrUrl, env);
  return r;
}

/**
 * Like getPrStatusCached, but with nothing cached it waits for the first answer (asynchronously, so other requests and
 * streams keep running). A cached value, however old, is returned at once.
 */
export async function getPrStatusAsync(cwd: string, branchOrUrl: string, env: NodeJS.ProcessEnv = process.env, o: PrReadOptions = {}): Promise<PrRead> {
  if (!branchOrUrl || !branchOrUrl.trim()) return { status: null, ageMs: null, stale: false, pending: false };
  const e = prCache.get(prKey(cwd, branchOrUrl));
  if (e) return getPrStatusCached(cwd, branchOrUrl, env, o);
  await refreshPrStatus(cwd, branchOrUrl, env);
  return readEntry(prCache.get(prKey(cwd, branchOrUrl)), Date.now(), o);
}

/** Asks GitHub now, whatever the cache holds (the user pressed "Sync PR status"), and answers the new status. */
export async function syncPrStatus(cwd: string, branchOrUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<PrRead> {
  if (!branchOrUrl || !branchOrUrl.trim()) return { status: null, ageMs: null, stale: false, pending: false };
  await refreshPrStatus(cwd, branchOrUrl, env);
  return readEntry(prCache.get(prKey(cwd, branchOrUrl)), Date.now(), prPollOptions(env));
}

export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  diffHunk?: string;
}

/** True for a pr-comments.md that says it holds no comments ("Total comments: 0"): the sync writes one even when the PR has none. */
export function prCommentsEmpty(markdown: string): boolean {
  return /^Total comments: 0\s*$/m.test(markdown);
}

/** Fetches discussion comments, reviews, and inline diff comments from GitHub. */
export function fetchPrComments(
  cwd: string,
  branchOrUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; pr: string | null; state: string | null; comments: PrComment[]; markdown: string; err?: string[] } {
  const err: string[] = [];
  const status = getPrStatus(cwd, branchOrUrl, env);
  if (!status) {
    err.push(`No PR found for ${branchOrUrl}`);
    return { ok: false, pr: null, state: null, comments: [], markdown: '', err };
  }

  const comments: PrComment[] = [];

  // 1. Fetch reviews and discussion comments via gh pr view
  try {
    const view = spawnSync('gh', ['pr', 'view', branchOrUrl, '--json', 'comments,reviews'], {
      cwd, encoding: 'utf8', env, timeout: 8000,
    });
    if (view.status === 0 && view.stdout.trim()) {
      const data = JSON.parse(view.stdout.trim());
      if (Array.isArray(data.reviews)) {
        for (const rev of data.reviews) {
          if (rev.body && rev.body.trim()) {
            comments.push({
              author: rev.author?.login || 'reviewer',
              body: rev.body.trim(),
              createdAt: rev.submittedAt || '',
            });
          }
        }
      }
      if (Array.isArray(data.comments)) {
        for (const c of data.comments) {
          if (c.body && c.body.trim()) {
            comments.push({
              author: c.author?.login || 'commenter',
              body: c.body.trim(),
              createdAt: c.createdAt || '',
            });
          }
        }
      }
    }
  } catch { /* best effort */ }

  // 2. Fetch inline review comments if PR number is available
  if (status.number) {
    try {
      const apiRes = spawnSync('gh', ['api', `repos/:owner/:repo/pulls/${status.number}/comments`], {
        cwd, encoding: 'utf8', env, timeout: 8000,
      });
      if (apiRes.status === 0 && apiRes.stdout.trim()) {
        const list = JSON.parse(apiRes.stdout.trim());
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item.body && item.body.trim()) {
              comments.push({
                author: item.user?.login || 'reviewer',
                body: item.body.trim(),
                createdAt: item.created_at || '',
                path: item.path,
                line: item.line || item.original_line,
                diffHunk: item.diff_hunk,
              });
            }
          }
        }
      }
    } catch { /* best effort */ }
  }

  // 3. Format into a structured markdown document
  const mdLines: string[] = [
    '# Pull Request Review Comments',
    '',
    `PR: ${status.url}`,
    `State: ${status.state}`,
    `Total comments: ${comments.length}`,
    '',
  ];

  if (comments.length === 0) {
    mdLines.push('No review comments found on this pull request.');
  } else {
    const inline = comments.filter(c => c.path);
    const general = comments.filter(c => !c.path);

    if (inline.length > 0) {
      mdLines.push('## Inline Review Comments', '');
      for (const c of inline) {
        mdLines.push(`### @${c.author} on \`${c.path}${c.line ? `:${c.line}` : ''}\``);
        if (c.diffHunk) {
          mdLines.push('```diff', c.diffHunk, '```');
        }
        mdLines.push('', c.body, '');
      }
    }

    if (general.length > 0) {
      mdLines.push('## Discussion & Review Comments', '');
      for (const c of general) {
        mdLines.push(`### @${c.author} (${c.createdAt.split('T')[0] || 'review'})`, '', c.body, '');
      }
    }
  }

  const markdown = mdLines.join('\n');
  return { ok: true, pr: status.url, state: status.state, comments, markdown };
}

/**
 * Commits the cycle's files (compared with the baseline) in one feat commit and ticks the backlog item in its own. The
 * developer's own earlier changes, secrets, editor and agent configuration, generated and large files are skipped and
 * listed in <docs>/logs/finalise-skipped.md. Nothing to commit and a slug missing from the backlog are warnings.
 * When createPr is enabled, pushes the branch to origin, creates a GitHub PR if needed, and links it in brief.md.
 * If a PR is created or open, the backlog item is only marked completed [x] once the PR is merged into base.
 * Returns the finalise result (committed count and PR URL).
 */
export function finalise(o: FinaliseOptions): FinaliseResult {
  const root = o.git.root;
  const opts = { root, maxBytes: o.maxBytes };
  const log = `${o.docs}/logs`;
  fs.mkdirSync(path.join(root, log), { recursive: true });
  const logIgnore = path.join(root, log, '.gitignore');
  if (!fs.existsSync(logIgnore)) fs.writeFileSync(logIgnore, '*\n');
  const branch = o.git.run('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const baselineFile = path.join(root, o.baseline);
  if (o.envExample !== false) mirror(baselineFile, opts, line => o.err(line));
  const { include, skipped } = changed(baselineFile, opts);
  const base: Baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const backlogDirty = has(base.files, o.backlog);

  if (!include.length) o.out('WARNING: nothing to commit');
  else {
    o.git.run('add', '-A', '--', ...include);
    o.git.run('commit', '-q', '-m', `feat(${o.slug}): implement per ${o.docs}/specs-1.md`, '-m', include.slice(0, 50).join('\n'), '--', ...include);
  }

  const lines = skipped.map(s => `- ${s.path}: ${s.reason}`);
  const skippedFile = path.join(root, log, 'finalise-skipped.md');
  fs.writeFileSync(skippedFile, lines.map(l => `${l}\n`).join(''));

  if (lines.length) { o.out('Skipped:'); for (const l of lines) o.out(l); }
  o.out('');
  o.out(`DONE: ${o.slug} on ${branch}. Committed ${include.length} file(s), skipped ${lines.length} (see ${log}/finalise-skipped.md).`);

  let prUrl: string | null = null;
  const briefFile = path.join(root, o.docs, 'brief.md');
  const briefText = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : '';
  prUrl = getPrFromBrief(briefText);

  if (o.createPr) {
    o.out('Pushing branch to origin and checking/creating PR...');
    try {
      o.git.run('push', '-u', 'origin', branch);
    } catch (e) {
      o.err(`WARNING: git push to origin failed: ${(e as Error).message}`);
    }

    if (!prUrl) {
      const title = `feat(${o.slug}): implement per ${o.docs}/specs-1.md`;
      const body = `Automated finalisation for \`${o.slug}\`.\n\nSpecs: \`${o.docs}/specs-1.md\``;
      prUrl = createOrGetPr(root, branch, title, body, o.baseBranch);
    }

    if (prUrl) {
      o.out(`Pull Request: ${prUrl}`);
      // Record PR in brief.md
      if (fs.existsSync(briefFile)) {
        const updatedBrief = recordPrInBrief(fs.readFileSync(briefFile, 'utf8'), prUrl);
        fs.writeFileSync(briefFile, updatedBrief);
        const briefRel = path.relative(root, briefFile);
        try {
          o.git.run('add', '--', briefRel);
          o.git.run('commit', '-q', '-m', `chore(${o.slug}): link pull request`, '--', briefRel);
          try { o.git.run('push', 'origin', branch); } catch { /* best effort */ }
        } catch { /* if nothing to commit */ }
      }
    } else {
      o.err('WARNING: could not create or detect PR (ensure gh is installed and authenticated)');
    }
  }

  // Backlog marking: If a PR exists or was created, check whether it is merged.
  // The task is only ticked [x] once the PR is merged into base (or if no PR is used).
  const prStatus = prUrl ? getPrStatus(root, prUrl) : null;
  const isPrMerged = prStatus ? prStatus.state === 'MERGED' : false;
  const shouldTickDone = !prUrl || isPrMerged;

  const backlogFile = path.join(root, o.backlog);
  const item = `- [ ] \`${o.slug}\``;
  const text = fs.existsSync(backlogFile) ? fs.readFileSync(backlogFile, 'utf8') : null;
  if (text !== null && text.split('\n').some(l => l.startsWith(item))) {
    if (shouldTickDone) {
      fs.writeFileSync(backlogFile, text.split('\n').map(l => (l.startsWith(item) ? `- [x] ${l.slice(6)}` : l)).join('\n'));
      if (backlogDirty) o.out(`WARNING: ${o.backlog} had local changes before the run; ticked ${o.slug} but not committed`);
      else {
        o.git.run('add', '--', o.backlog);
        o.git.run('commit', '-q', '-m', `chore(backlog): mark ${o.slug} done`, '--', o.backlog);
      }
    } else {
      o.out(`PR created (${prUrl}). Backlog item will be marked completed once the PR is merged into main.`);
    }
  } else if (shouldTickDone) {
    o.out(`WARNING: ${o.slug} not found in ${o.backlog}; not ticked`);
  }

  return { committed: include.length, pr: prUrl };
}

export interface CiReport {
  ok: boolean;
  ci: CiState;
  failing: string[];
  /** A few distinct error lines, for the run page. */
  summary: string[];
  /** What the Implement agent is given: the failing checks and the error lines of their logs. */
  markdown: string;
  err?: string[];
}

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const ERROR_LINE = /\berror\b|\bfail(?:ed|ure|ing)?\b|✖|✗|×|AssertionError|expected .* to |TS\d{4}|no-[a-z-]+|exit code/i;

/** The message of a `gh run view --log-failed` line (job, step and timestamp dropped), with the step it ran in. */
function logMessage(line: string): { step: string; message: string } | null {
  const m = /^[^\t]*\t([^\t]*)\t\s*\S*\d{2}:\d{2}:\d{2}[.\dZ]*\s?(.*)$/.exec(line.replace(ANSI_RE, ''));
  if (!m) return null;
  return { step: m[1].trim(), message: m[2].replace(/^##\[(?:error|group|endgroup)\]/, '').trim() };
}

/** The failing checks of a PR and the error lines of their logs (asks GitHub: waits for gh). */
export function ciFailureReport(cwd: string, branchOrUrl: string, env: NodeJS.ProcessEnv = process.env): CiReport {
  const none: CiReport = { ok: false, ci: 'none', failing: [], summary: [], markdown: '' };
  const view = spawnSync('gh', ['pr', 'view', branchOrUrl, '--json', 'url,statusCheckRollup'], { cwd, encoding: 'utf8', env, timeout: 15_000 });
  if (view.status !== 0 || !view.stdout.trim()) return { ...none, err: [`could not read the checks of ${branchOrUrl}`] };
  let data: { url?: string; statusCheckRollup?: Array<Record<string, unknown>> };
  try { data = JSON.parse(view.stdout.trim()); } catch { return { ...none, err: ['gh answered something that is not JSON'] }; }
  const { ci, failing } = ciOf(data.statusCheckRollup);
  if (ci !== 'failed') return { ok: true, ci, failing: [], summary: [], markdown: '' };

  const runs = new Set<string>();
  for (const c of data.statusCheckRollup || []) {
    const bad = BAD_CONCLUSIONS.has(String(c.conclusion || c.state || '').toUpperCase());
    const m = bad ? /\/actions\/runs\/(\d+)/.exec(String(c.detailsUrl || c.targetUrl || '')) : null;
    if (m) runs.add(m[1]);
  }
  const seen = new Set<string>();
  const blocks: string[] = [];
  const summary: string[] = [];
  for (const id of runs) {
    const logs = spawnSync('gh', ['run', 'view', id, '--log-failed'], { cwd, encoding: 'utf8', env, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    const lines = (logs.stdout || '').split('\n').map(logMessage).filter((l): l is { step: string; message: string } => l !== null && l.message !== '');
    const picked = lines.filter(l => ERROR_LINE.test(l.message));
    const use = (picked.length ? picked : lines.slice(-30));
    const out: string[] = [];
    let step = '';
    for (const l of use) {
      const key = `${l.step}|${l.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (l.step !== step) { out.push(`[${l.step}]`); step = l.step; }
      out.push(l.message.slice(0, 300));
      if (summary.length < 6 && !summary.includes(l.message.slice(0, 200))) summary.push(l.message.slice(0, 200));
      if (out.length >= 80) break;
    }
    if (out.length) blocks.push(`### Run ${id}\n\n\`\`\`\n${out.join('\n')}\n\`\`\``);
  }
  const markdown = [
    '# CI failure of the pull request',
    '',
    data.url ? `Pull request: ${data.url}` : '',
    `Failing checks: ${failing.join(', ')}`,
    '',
    blocks.length ? blocks.join('\n\n') : 'The logs of the failing checks could not be read; run the same checks locally (the project\'s lint, typecheck and tests) to reproduce them.',
    '',
  ].join('\n');
  return { ok: true, ci, failing, summary, markdown };
}

/** The error lines of a ci-failure.md (what is inside its code blocks, without the `[step]` headers), at most <max>. */
export function ciSummaryOf(markdown: string, max = 6): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) { inside = !inside; continue; }
    if (inside && line.trim() && !/^\[.*\]$/.test(line.trim()) && out.length < max) out.push(line.trim().slice(0, 200));
  }
  return out;
}
