// What the run page and the board say about a run's stages, its test lock and its cost: the decisions and the wording,
// kept apart from the components so they can be tested.
// The shapes are repeated here, not imported from api.ts: the test project reads this file too, and it resolves
// imports differently. They match the Timeline types there field for field.
export interface UsageTotals { rounds: number; durationSec: number; turns: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null }
export interface StageSpan { stage: string; started: string; ended: string | null; passes: number; steps: Array<{ key: string; label: string; started: string; ended: string | null }>; usage: UsageTotals }
export interface LockView { sha: string; origRedSha: string; at: string; source: 'red-tests' | 'test-repair'; tests: number | null; files: number | null; relocks: number; guards: Array<{ at: string; stage: string; restored: string[] }> }
/** What `guarantees` reads of a run. */
export interface GuardedRun {
  state: string; stage: string; redCommit: string; worktree: string | null; branch: string;
  pr?: string | null; prState?: string | null; prCi?: string | null; ci?: { state: string } | null;
  timeline?: { lock: LockView | null };
}

/** The stages of the pipeline, in order; Resolve conflicts comes after the pull request and is not one of them. */
export const PIPELINE = ['Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Finalise'];
export const AFTER_PR = 'Resolve conflicts';

export type TileState = 'done' | 'active' | 'paused' | 'failed' | 'pending' | 'skipped';

/** Finalise is also written "6/6 Finalise" by older runs. */
export const stageName = (stage: string): string => (stage === '6/6 Finalise' ? 'Finalise' : stage);

/**
 * One state per pipeline stage for the strip on a board row: the stages before the current one are done, the current
 * one takes the run's state, the rest wait. A run at Resolve conflicts has every pipeline stage done.
 */
export function stripStates(r: { state: string; stage: string }): TileState[] {
  const name = stageName(r.stage);
  const all = r.state === 'done' || name === AFTER_PR;
  const at = PIPELINE.indexOf(name);
  return PIPELINE.map((_, i) => {
    if (all) return 'done';
    if (r.state === 'not started' || at < 0) return 'pending';
    if (i < at) return 'done';
    if (i > at) return 'pending';
    return r.state === 'running' ? 'active' : r.state === 'paused' ? 'paused' : 'failed';
  });
}

/** Test repair runs only when Implement claims a test defect: a run past it that never entered it skipped it. */
export function skipped(stage: string, state: TileState, spans: StageSpan[] | undefined, stageFiles: Record<string, string[]>): boolean {
  if (stage !== 'Test repair' || state !== 'done') return false;
  if (!spans) return false;
  return !spans.some(s => s.stage === stage) && !(stageFiles[stage]?.length);
}

/** "42s", "3m 05s", "1h 12m" for a number of seconds; '' for nothing to show. */
export function durationText(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** Seconds between two ISO times (to `now` while the end is open); null when either cannot be read. */
export function spanSeconds(started: string, ended: string | null, now: number): number | null {
  const a = Date.parse(started);
  const b = ended ? Date.parse(ended) : now;
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (b - a) / 1000) : null;
}

/** "812", "14.2k", "1.31M" tokens. */
export function tokensText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e5 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

/** "$0.42", "$12.30", "<$0.01"; "—" when the harness reported no cost. */
export function costText(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** The share of the input that came from the cache, as a whole percent; null when there was no input. */
export function cacheShare(u: UsageTotals): number | null {
  const all = u.input + u.cacheRead + u.cacheWrite;
  return all > 0 ? Math.round((u.cacheRead / all) * 100) : null;
}

/** Whether a usage total holds anything worth a row. */
export const hasUsage = (u: UsageTotals | undefined | null): u is UsageTotals => !!u && (u.rounds > 0 || u.tokens > 0);

/** The line under a stage's name on its tile. */
export function tileLine(state: TileState, span: StageSpan | undefined, files: number, liveStep: string, now: number): string {
  if (state === 'skipped') return 'Not needed';
  if (state === 'pending') return 'Not started';
  const time = span ? durationText(spanSeconds(span.started, state === 'active' ? null : span.ended, now) ?? (span.usage.durationSec || null)) : '';
  if (state === 'active') return [liveStep || 'Working', time].filter(Boolean).join(' · ');
  const what = state === 'paused' ? 'Waiting for you' : state === 'failed' ? 'Stopped here' : files ? `${files} file${files > 1 ? 's' : ''}` : 'Done';
  return [what, time].filter(Boolean).join(' · ');
}

export interface Guarantee { key: 'lock' | 'gates' | 'isolated' | 'pr'; title: string; detail: string; state: 'held' | 'pending' | 'broken' }

/**
 * The four promises of the pipeline as they stand for this run: the tests are locked before any code is written, every
 * stage is checked before the next starts, the work is in its own worktree and branch, and it ends as a pull request
 * whose CI is green. `held` only says what the run's own records show.
 */
export function guarantees(v: GuardedRun): Guarantee[] {
  const lock = v.timeline?.lock || null;
  const sha = (lock?.sha || v.redCommit || '').slice(0, 7);
  const guards = lock?.guards.length || 0;
  const at = PIPELINE.indexOf(stageName(v.stage));
  const passed = v.state === 'done' || stageName(v.stage) === AFTER_PR ? PIPELINE.length : Math.max(0, at);
  const ci = v.prCi || (v.ci?.state.startsWith('green') ? 'passed' : v.ci?.state.startsWith('red') ? 'failed' : v.ci ? 'in progress' : null);
  return [
    {
      key: 'lock',
      title: sha ? 'Tests locked' : 'Tests lock at Red tests',
      detail: sha
        ? `${lock?.tests ? `${lock.tests} tests ` : ''}at ${sha}${guards ? ` · ${guards} edit${guards > 1 ? 's' : ''} stopped` : ' · untouched since'}`
        : 'Written and failing before any code',
      state: sha ? 'held' : 'pending',
    },
    {
      key: 'gates',
      title: `${passed} of ${PIPELINE.length} stages checked`,
      detail: v.state === 'failed' || v.state === 'refused' ? `Stopped at ${stageName(v.stage) || 'the start'}: nothing unchecked goes on` : 'Each stage is checked before the next starts',
      state: passed === PIPELINE.length ? 'held' : v.state === 'failed' || v.state === 'refused' ? 'broken' : 'pending',
    },
    {
      key: 'isolated',
      title: v.worktree ? 'Own worktree and branch' : 'Runs in its own worktree',
      detail: v.worktree ? v.branch : 'Your checkout is never edited',
      state: v.worktree ? 'held' : 'pending',
    },
    {
      key: 'pr',
      title: v.prState === 'MERGED' ? 'Merged' : ci === 'passed' ? 'Pull request, CI green' : ci === 'failed' ? 'CI failed' : v.pr ? 'Pull request open' : 'Ends as a pull request',
      detail: v.prState === 'MERGED' ? 'In the base branch' : ci === 'failed' ? 'Not marked ready until it passes' : ci === 'in progress' ? 'Waiting for CI' : v.pr ? 'Ready for your review' : 'Opened once the checks pass',
      state: v.prState === 'MERGED' || ci === 'passed' ? 'held' : ci === 'failed' ? 'broken' : 'pending',
    },
  ];
}

/** What the lock panel says in one sentence. */
export function lockSentence(lock: LockView): string {
  const n = lock.tests ? `${lock.tests} test${lock.tests > 1 ? 's' : ''}` : 'The tests';
  const where = lock.files ? ` in ${lock.files} file${lock.files > 1 ? 's' : ''}` : '';
  const how = lock.source === 'test-repair' ? 'locked again after an audited Test repair' : 'locked when Red tests finished';
  return `${n}${where} ${lock.tests === 1 ? 'was' : 'were'} ${how}. Implement and Review cannot change them.`;
}
