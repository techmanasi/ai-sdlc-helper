// The Finalise stage: commit exactly the files this cycle changed, tick the backlog item, report what was skipped,
// and optionally push to origin and create a GitHub PR, recording the PR link in brief.md.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { execFileAsync, spawnSync, trace } from '../trace.js';
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
  /** Keeps the whole text of a failure (the pipeline's logs/errors.log); without it, only the one-line warning is printed. */
  keepError?(where: string, text: string): void;
  /** Records a new pull request's link wherever the brief is kept (the pipeline's linkPrEverywhere); without it, in the brief here. */
  linkPr?(url: string): void;
}

export interface FinaliseResult {
  committed: number;
  pr: string | null;
  /** The pull request is merged already. */
  merged?: boolean;
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

/** Takes every PR link out of brief.md: the front-matter lines (and the block, when that leaves it empty) and the body lines. */
export function clearPrInBrief(text: string): string {
  let out = text;
  const m = out.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m && /^pr:\s*\S+/im.test(m[1])) {
    const rest = m[1].split(/\r?\n/).filter(l => !/^pr:\s*/i.test(l)).join('\n').trim();
    const tail = out.slice(m[0].length);
    out = rest ? `---\n${rest}\n---${tail}` : tail.replace(/^\s*\n/, '');
  }
  return out.replace(/^(?:PR|pr):\s*https?:\/\/\S+[ \t]*(?:\r?\n|$)/gim, '');
}

/** What findOrCreatePr came to: the pull request's link, or why there is none (gh's own words and exit code). */
export type PrOpened = { url: string; error?: undefined } | { url: null; error: string };

/** gh's answer as one text for errors.log: the command, its exit code (or why it did not run), and what it printed. */
function ghFailure(what: string, r: { status: number | null; stdout?: unknown; stderr?: unknown; error?: Error }): string {
  const how = r.error ? `could not run: ${r.error.message}` : `exited with ${r.status === null ? 'no code (killed or timed out)' : r.status}`;
  const printed = [String(r.stderr ?? '').trim(), String(r.stdout ?? '').trim()].filter(Boolean).join('\n');
  return `${what} ${how}: ${printed || '(no output)'}`;
}

/** ghFailure for an asynchronous call: a program that did not start, a call stopped at its timeout, or gh's exit code. */
function ghError(what: string, err: Error, stdout: unknown, stderr: unknown, timeoutMs: number): string {
  const e = err as Error & { code?: unknown; killed?: boolean };
  if (typeof e.code === 'string') return ghFailure(what, { status: null, stdout, stderr, error: err });
  if (e.killed) return `${ghFailure(what, { status: null, stdout, stderr })} (stopped after ${timeoutMs} ms)`;
  return ghFailure(what, { status: typeof e.code === 'number' ? e.code : null, stdout, stderr });
}

/** Finds or creates a GitHub PR for the branch; when there is none and gh cannot open one, says why in gh's own words. */
export function findOrCreatePr(cwd: string, branch: string, title: string, body: string, base?: string, opts: { draft?: boolean } = {}): PrOpened {
  // Is there one already? A failed view or list means "none found": the create below says what is wrong, if anything.
  try {
    const view = spawnSync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { cwd, encoding: 'utf8' });
    if (view.status === 0 && view.stdout.trim().startsWith('http')) {
      return { url: view.stdout.trim() };
    }
  } catch { /* a probe: gh might not be installed or authenticated, and the create says so */ }

  try {
    const list = spawnSync('gh', ['pr', 'list', '--head', branch, '--json', 'url', '-q', '.[0].url'], { cwd, encoding: 'utf8' });
    if (list.status === 0 && list.stdout.trim().startsWith('http')) {
      return { url: list.stdout.trim() };
    }
  } catch { /* a probe, as above */ }

  const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body];
  if (base) args.push('--base', base);
  if (opts.draft) args.push('--draft');
  try {
    const create = spawnSync('gh', args, { cwd, encoding: 'utf8' });
    if (create.status === 0) {
      const match = (create.stdout + '\n' + create.stderr).match(/https?:\/\/[^\s]+/);
      if (match) {
        clearPrCache();
        return { url: match[0].trim() };
      }
      return { url: null, error: ghFailure('gh pr create printed no pull request link;', create) };
    }
    return { url: null, error: ghFailure('gh pr create', create) };
  } catch (e) {
    return { url: null, error: `gh pr create could not run: ${(e as Error).message}` };
  }
}

/** Finds or creates a GitHub PR for the branch: its link, or null (findOrCreatePr also says why). */
export function createOrGetPr(cwd: string, branch: string, title: string, body: string, base?: string, opts: { draft?: boolean } = {}): string | null {
  return findOrCreatePr(cwd, branch, title, body, base, opts).url;
}

/** The first line of a failure text, for the one line of output that points at errors.log. */
export const firstLine = (text: string): string => (String(text).trim().split('\n').find(l => l.trim()) || '').trim().slice(0, 200);

/** The CI of a pull request: its checks are running, all passed, one failed, or it has none. */
export type CiState = 'in progress' | 'passed' | 'failed' | 'none';

/** Marks a draft PR ready for review (`gh pr ready`); true when gh succeeded. */
export function markPrReady(cwd: string, branchOrUrl: string, env: NodeJS.ProcessEnv = process.env, onError?: (text: string) => void): boolean {
  try {
    const r = spawnSync('gh', ['pr', 'ready', branchOrUrl], { cwd, encoding: 'utf8', env, timeout: 30_000 });
    clearPrCache();
    if (r.status !== 0) onError?.(ghFailure('gh pr ready', r));
    return r.status === 0;
  } catch (e) {
    onError?.(`gh pr ready could not run: ${(e as Error).message}`);
    return false;
  }
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

interface PrEntry { time: number; val: PrStatus | null; failed?: boolean; error?: string }
const prCache = new Map<string, PrEntry>();
const inflight = new Map<string, Promise<PrStatus | null>>();
const PR_CACHE_TTL_MS = 60_000;
const PR_TIMEOUT_MS = 3000;
/** How long one gh call may take: SDLC_PR_TIMEOUT_MS, else 3 s. A `gh pr list` of many PRs gets more (see prefetchPrStatuses). */
const prTimeout = (env: NodeJS.ProcessEnv): number => { const ms = Number(env.SDLC_PR_TIMEOUT_MS); return Number.isFinite(ms) && ms > 0 ? ms : PR_TIMEOUT_MS; };
/** How often the web server asks GitHub again for a PR it already knows: once an hour (SDLC_PR_POLL_MS changes it). */
export const PR_POLL_MS = 3_600_000;

/**
 * How a reader of the cache sees an entry: <ttlMs> is how long it counts as fresh; a failed refresh is tried again at
 * once unless <retryFailed> is false. <onError> gets gh's whole message when a refresh this read started (or joined) fails.
 */
export interface PrReadOptions { ttlMs?: number; retryFailed?: boolean; onError?: (message: string) => void }

/** The web server's reading of the cache: a status is checked again only every hour, and a failed check waits as long. */
export function prPollOptions(env: NodeJS.ProcessEnv = process.env): PrReadOptions {
  const ms = Number(env.SDLC_PR_POLL_MS);
  return { ttlMs: Number.isFinite(ms) && ms > 0 ? ms : PR_POLL_MS, retryFailed: false };
}

/** Clears the in-memory PR cache (e.g. after creating or updating a PR). */
export function clearPrCache(): void {
  // A cleared cache must not come back from the file at the next start.
  for (const f of prFiles.values()) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
  prCache.clear();
}

/** The file of statuses beside the run records. Not *.json: every *.json there is a run record. */
export const PR_STATUS_FILE = 'pr-status.cache';
const prFiles = new Map<string, string>();

/** What a process restart does to the statuses: the memory is gone, the files stay. For tests. */
export function forgetPrStatuses(): void {
  prCache.clear();
  inflight.clear();
  prFiles.clear();
}

/** Keeps the statuses of <cwd> in <file> too: read once now (what a restart finds), written after every answer from GitHub. */
export function keepPrStatusIn(cwd: string, file: string): void {
  if (prFiles.get(cwd) === file) return;
  prFiles.set(cwd, file);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; entries?: unknown };
    if (!data || data.version !== 1 || !data.entries || typeof data.entries !== 'object') return;
    for (const [key, e] of Object.entries(data.entries as Record<string, PrEntry>)) {
      if (!e || typeof e.time !== 'number' || (e.val !== null && typeof e.val !== 'object')) continue;
      const k = prKey(cwd, key);
      if (!prCache.has(k)) prCache.set(k, { time: e.time, val: e.val, ...(e.failed ? { failed: true, ...(typeof e.error === 'string' ? { error: e.error } : {}) } : {}) });
    }
  } catch { /* a missing or broken file is the same as no file */ }
}

function savePrStatuses(cwd: string): void {
  const file = prFiles.get(cwd);
  if (!file) return;
  try {
    const prefix = `${cwd}::`;
    const entries: Record<string, PrEntry> = {};
    for (const [k, e] of prCache) if (k.startsWith(prefix)) entries[k.slice(prefix.length)] = e;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    fs.renameSync(tmp, file);
  } catch { /* a status that cannot be saved must not break a refresh */ }
}

const prKey = (cwd: string, branchOrUrl: string): string => `${cwd}::${branchOrUrl.trim()}`;

function parsePr(stdout: string): PrStatus | null {
  try {
    return prOfData(JSON.parse(stdout.trim()));
  } catch { /* best effort */ }
  return null;
}

/** One PR of gh's JSON (`pr view` or one item of `pr list`, same fields) as a PrStatus. */
function prOfData(data: Record<string, unknown> | null): PrStatus | null {
  {
    if (data && typeof data.url === 'string' && data.url) {
      return {
        url: data.url,
        state: String(data.state || 'OPEN').toUpperCase() as 'OPEN' | 'MERGED' | 'CLOSED',
        number: typeof data.number === 'number' ? data.number : undefined,
        ...(Array.isArray(data.statusCheckRollup) ? ciOf(data.statusCheckRollup) : {}),
        ...(typeof data.mergeable === 'string' ? { conflicts: conflictsOf(data.mergeable) } : {}),
        ...(typeof data.isDraft === 'boolean' ? { isDraft: data.isDraft } : {}),
        ...(Array.isArray(data.statusCheckRollup) ? { statusCheckRollup: data.statusCheckRollup as CheckRunStatus[] } : {}),
        ...(typeof data.headRefOid === 'string' ? { headRefOid: data.headRefOid } : {}),
      };
    }
  }
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
  /** gh's whole message for that failed check. */
  error?: string;
}

type PrListener = (e: { cwd: string; branchOrUrl: string; status: PrStatus | null }) => void;
const prListeners = new Set<PrListener>();

/** Calls <fn> whenever a background refresh changes a PR status (or learns one for the first time). Returns the unsubscribe. */
export function onPrStatusChange(fn: PrListener): () => void {
  prListeners.add(fn);
  return () => { prListeners.delete(fn); };
}

/** Who waits for the failure of a running refresh, per key: every reader that started or joined it. */
const failureWaiters = new Map<string, Set<(message: string) => void>>();
const waitForFailure = (key: string, fn?: (message: string) => void) => {
  if (!fn) return;
  const set = failureWaiters.get(key) || new Set();
  set.add(fn);
  failureWaiters.set(key, set);
};
/** Tells the readers of <key> that its check failed, once; a reader's own error must not break the refresh. */
const reportFailure = (key: string, message: string | null) => {
  const set = failureWaiters.get(key);
  failureWaiters.delete(key);
  if (message && set) for (const fn of set) { try { fn(message); } catch { /* the reader's problem, not the refresh's */ } }
};

/** One asynchronous gh call per key at a time; a failure keeps the old value, marks it stale and keeps gh's message. */
function refreshPrStatus(cwd: string, branchOrUrl: string, env: NodeJS.ProcessEnv, onError?: (message: string) => void): Promise<PrStatus | null> {
  const key = prKey(cwd, branchOrUrl);
  waitForFailure(key, onError);
  const running = inflight.get(key);
  if (running) return running;
  const t0 = performance.now();
  const p = new Promise<PrStatus | null>(resolve => {
    execFile('gh', ['pr', 'view', branchOrUrl, '--json', PR_FIELDS], { cwd, env, encoding: 'utf8', timeout: prTimeout(env) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : -1) : 0;
      trace({ action: 'spawn:gh', why: 'async pr', ms: Math.round((performance.now() - t0) * 1000) / 1000, code });
      const before = prCache.get(key);
      let status: PrStatus | null;
      let error: string | null = null;
      // "no pull requests found" is GitHub's answer for a branch without a PR, not a failed check.
      const none = Boolean(err) && /no pull requests found/i.test(String(stderr || ''));
      if (none) {
        status = null;
        prCache.set(key, { time: Date.now(), val: null });
      } else if (err) {
        status = before ? before.val : null;
        error = ghError(`gh pr view ${branchOrUrl}`, err, stdout, stderr, prTimeout(env));
        prCache.set(key, { time: Date.now(), val: status, failed: true, error });
      } else {
        status = stdout.trim() ? parsePr(stdout) : null;
        const entry = { time: Date.now(), val: status };
        prCache.set(key, entry);
        // The same PR asked for by its link (a brief that now records it) is the same answer.
        if (status) prCache.set(prKey(cwd, status.url), entry);
      }
      savePrStatuses(cwd);
      inflight.delete(key);
      reportFailure(key, error);
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
  return { status: e.val, ageMs, stale, pending: false, ...(e.failed ? { failed: true, ...(e.error ? { error: e.error } : {}) } : {}) };
}

/**
 * The PR status without waiting: the cached value at once (with its age), and a refresh in the background when it is
 * older than the cache time. With nothing cached it answers pending and starts the refresh. Never blocks the event loop.
 */
export function getPrStatusCached(cwd: string, branchOrUrl: string, env: NodeJS.ProcessEnv = process.env, o: PrReadOptions = {}): PrRead {
  if (!branchOrUrl || !branchOrUrl.trim()) return { status: null, ageMs: null, stale: false, pending: false };
  const e = prCache.get(prKey(cwd, branchOrUrl));
  const r = readEntry(e, Date.now(), o);
  if (!e || r.stale) void refreshPrStatus(cwd, branchOrUrl, env, o.onError);
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
  await refreshPrStatus(cwd, branchOrUrl, env, o.onError);
  // A prefetch it joined that did not hold this PR leaves nothing behind: then it is asked for on its own.
  if (!prCache.has(prKey(cwd, branchOrUrl))) await refreshPrStatus(cwd, branchOrUrl, env, o.onError);
  return readEntry(prCache.get(prKey(cwd, branchOrUrl)), Date.now(), o);
}

/** Below this many unknown links, one `gh pr view` each is as quick as one list. */
const PREFETCH_MIN = 3;

/**
 * Fills the cache for many PR links at once with one `gh pr list --state all` (the same fields `gh pr view` gives, so
 * an entry is the same whichever call made it), instead of one gh call per link: for a list of many completed tasks
 * when nothing is known about them yet (a first load, or after the cache was cleared). Only links are asked for, not
 * branches (a branch's PR is gh's own pick among several), and only those neither cached nor being fetched. A link
 * the list does not hold (an older PR past its limit, another repository) is left for its own `gh pr view`. A failed
 * list marks each of them failed with gh's message, which <onError> also gets once per link. Returns the links filled.
 */
export async function prefetchPrStatuses(cwd: string, links: string[], env: NodeJS.ProcessEnv = process.env, onError?: (link: string, message: string) => void): Promise<number> {
  const cold = [...new Set(links.map(k => k.trim()))].filter(k => /^https?:\/\//.test(k) && !prCache.has(prKey(cwd, k)) && !inflight.has(prKey(cwd, k)));
  if (cold.length < PREFETCH_MIN) return 0;
  const limit = Math.min(1000, Math.max(100, cold.length + 50));
  // gh asks GitHub for 100 PRs a page; each page gets the time of two single calls.
  const timeoutMs = prTimeout(env) * (2 + 2 * Math.ceil(limit / 100));
  let release: () => void = () => {};
  const done = new Promise<void>(r => { release = r; });
  // Readers that ask for one of these links meanwhile wait for the list instead of starting their own call.
  for (const k of cold) inflight.set(prKey(cwd, k), done.then(() => prCache.get(prKey(cwd, k))?.val ?? null));
  let filled = 0;
  try {
    const r = await execFileAsync('gh', ['pr', 'list', '--state', 'all', '--limit', String(limit), '--json', PR_FIELDS], { cwd, env, timeout: timeoutMs });
    let list: unknown = null;
    if (r.code === 0) { try { list = JSON.parse(r.stdout.trim() || '[]'); } catch { /* reported below */ } }
    if (!Array.isArray(list)) {
      const what = `gh pr list --state all --limit ${limit}`;
      const error = r.code !== 0 && r.error ? ghError(what, r.error, r.stdout, r.stderr, timeoutMs) : ghFailure(`${what} printed no list;`, { status: r.code, stdout: r.stdout, stderr: r.stderr });
      const now = Date.now();
      for (const k of cold) {
        prCache.set(prKey(cwd, k), { time: now, val: null, failed: true, error });
        reportFailure(prKey(cwd, k), error);
        if (onError) { try { onError(k, error); } catch { /* the reader's problem */ } }
      }
      return 0;
    }
    const byUrl = new Map<string, PrStatus>();
    for (const item of list) { const s = prOfData(item as Record<string, unknown>); if (s) byUrl.set(s.url, s); }
    const now = Date.now();
    for (const k of cold) {
      const status = byUrl.get(k);
      if (!status) continue;
      prCache.set(prKey(cwd, k), { time: now, val: status });
      failureWaiters.delete(prKey(cwd, k));
      filled++;
      for (const fn of prListeners) { try { fn({ cwd, branchOrUrl: k, status }); } catch { /* a listener must not break the refresh */ } }
    }
    return filled;
  } finally {
    savePrStatuses(cwd);
    for (const k of cold) inflight.delete(prKey(cwd, k));
    release();
  }
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
    // Says what failed in one line and keeps the whole text.
    const failed = (where: string, line: string, text: string): void => {
      o.keepError?.(where, text);
      o.err(`WARNING: ${line}: ${firstLine(text)}${o.keepError ? ` (the whole message is in ${log}/errors.log)` : ''}`);
    };
    try {
      o.git.run('push', '-u', 'origin', branch);
    } catch (e) {
      failed('finalise: push', 'git push to origin failed', (e as Error).message);
    }

    if (!prUrl) {
      const title = `feat(${o.slug}): implement per ${o.docs}/specs-1.md`;
      const body = `Automated finalisation for \`${o.slug}\`.\n\nSpecs: \`${o.docs}/specs-1.md\``;
      const opened = findOrCreatePr(root, branch, title, body, o.baseBranch);
      prUrl = opened.url;
      if (opened.error) failed('finalise: gh pr create', `could not create or detect a pull request for ${branch}`, opened.error);
    }

    if (prUrl) {
      o.out(`Pull Request: ${prUrl}`);
      // Record PR in brief.md
      if (fs.existsSync(briefFile)) {
        if (o.linkPr) o.linkPr(prUrl);
        else fs.writeFileSync(briefFile, recordPrInBrief(fs.readFileSync(briefFile, 'utf8'), prUrl));
        const briefRel = path.relative(root, briefFile);
        // An unchanged brief (the link was there already) has nothing to commit: that is not a failure.
        if (o.git.run('status', '--porcelain', '--', briefRel).trim()) {
          try {
            o.git.run('add', '--', briefRel);
            o.git.run('commit', '-q', '-m', `chore(${o.slug}): link pull request`, '--', briefRel);
            try { o.git.run('push', 'origin', branch); } catch (e) { failed('finalise: push of the pull request link', 'git push of the pull request link failed', (e as Error).message); }
          } catch (e) { failed('finalise: commit of the pull request link', 'could not commit the pull request link', (e as Error).message); }
        }
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

  return { committed: include.length, pr: prUrl, ...(isPrMerged ? { merged: true } : {}) };
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
