// What the run page and the board say about a run's stages, its test lock and its cost: the decisions and the wording,
// kept apart from the components so they can be tested.
// The shapes are repeated here, not imported from api.ts: the test project reads this file too, and it resolves
// imports differently. They match the Timeline types there field for field.
export interface UsageTotals { rounds: number; durationSec: number; turns: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null; estimatedUsd?: number; unpriced?: number }
export interface StageSpan { stage: string; started: string; ended: string | null; passes: number; steps: Array<{ key: string; label: string; started: string; ended: string | null }>; usage: UsageTotals }
export interface LockView { sha: string; origRedSha: string; at: string; source: 'red-tests' | 'test-repair'; tests: number | null; files: number | null; relocks: number; guards: Array<{ at: string; stage: string; restored: string[] }> }
export interface LockOpen { at: string; reason: 'retry' | 'review-findings' | 'test-repair'; sha: string }
/** What `guarantees` reads of a run. */
export interface GuardedRun {
  state: string; stage: string; redCommit: string; worktree: string | null; branch: string;
  pr?: string | null; prState?: string | null; prCi?: string | null; ci?: { state: string } | null;
  timeline?: { lock: LockView | null; lockOpen?: LockOpen | null };
}

/** The stages of the pipeline, in order; Resolve conflicts comes after the pull request and is not one of them. */
export const PIPELINE = ['Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Finalise'];
export const AFTER_PR = 'Resolve conflicts';

/** Where a stage stands, as the run log recorded it (the timeline's span status). */
export type SpanStatus = 'started' | 'completed' | 'failed' | 'paused' | 'stopped';
export interface StageMark { stage: string; status?: SpanStatus }
const STOPPED = ['failed', 'paused', 'stopped', 'interrupted'];

/**
 * The stage a run is at. The status file's stage when it has one; otherwise (a stop before any stage began has none) the
 * stage the log shows still open, failed or paused; otherwise, for a stopped run, the one after the last completed stage.
 * '' when the log has nothing: the caller falls back to where the run was to resume.
 */
export function currentStage(r: { state: string; stage: string }, marks?: readonly StageMark[]): string {
  if (r.stage) return stageName(r.stage);
  if (!marks?.length || r.state === 'not started' || r.state === 'ready' || r.state === 'done') return '';
  const open = [...marks].reverse().find(m => m.status && m.status !== 'completed');
  if (open) return stageName(open.stage);
  if (!STOPPED.includes(r.state)) return '';
  const last = [...marks].reverse().find(m => PIPELINE.includes(stageName(m.stage)));
  const next = last ? PIPELINE[PIPELINE.indexOf(stageName(last.stage)) + 1] : '';
  return next || '';
}

export type TileState = 'done' | 'active' | 'paused' | 'failed' | 'pending' | 'skipped';

/** Finalise is also written "6/6 Finalise" by older runs. */
export const stageName = (stage: string): string => (stage === '6/6 Finalise' ? 'Finalise' : stage);

/**
 * One state per pipeline stage for the strip on a board row: the stages before the current one are done, the current
 * one takes the run's state, the rest wait. A run at Resolve conflicts has every pipeline stage done.
 */
export function stripStates(r: { state: string; stage: string; stages?: readonly StageMark[] }): TileState[] {
  const name = currentStage(r, r.stages);
  const all = r.state === 'done' || name === AFTER_PR;
  const at = PIPELINE.indexOf(name);
  return PIPELINE.map((_, i) => {
    if (all) return 'done';
    if (r.state === 'not started' || at < 0) return 'pending';
    if (i < at) return 'done';
    if (i > at) return 'pending';
    // Ready: the run stays at the stage that was discarded, which waits to run again.
    return r.state === 'running' ? 'active' : r.state === 'paused' ? 'paused' : r.state === 'ready' ? 'pending' : 'failed';
  });
}

export type StageState = 'done' | 'active' | 'paused' | 'failed' | 'pending';

/**
 * One state per stage for the run page's rail: the stages before the current one are done, the current one takes the
 * run's state (a run ready after a stage discard has it waiting to run again), the rest wait. A running run with no stage yet shows
 * the stage it started from.
 */
export function stageStates(v: { state: string; stage: string; resumeFrom?: string; record?: { from?: string } | null; timeline?: { stages: readonly StageMark[] } | null }, stages: readonly { name: string; key: string }[]): StageState[] {
  // A run that stopped before any stage began stays at the stage it was to resume at, not at Spec.
  const stopped = ['failed', 'paused', 'stopped', 'interrupted'].includes(v.state);
  const from = v.state === 'running' ? v.record?.from : stopped ? v.resumeFrom : '';
  const logged = currentStage(v, v.timeline?.stages);
  const name = stageName(logged || (from ? (stages.find(s => s.key === from)?.name || '') : ''));
  const at = v.state === 'done' ? stages.length : Math.max(0, stages.findIndex(s => s.name === name));
  return stages.map((_, i) => {
    if (v.state === 'done' || i < at) return 'done';
    const pre = !v.stage && !logged && !(stopped && name);
    if (i > at || v.state === 'not started' || (pre && (v.state === 'ready' || (!v.record?.from && v.state !== 'running')))) return 'pending';
    if (v.state === 'running') return 'active';
    if (v.state === 'paused') return 'paused';
    if (v.state === 'ready') return 'pending';
    return 'failed';
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

/**
 * The cost and tokens of a stage or run, for a tile or a chip: "$0.42 · 412k tok" when it cost something, "≈$0.42 · …"
 * when any of it is an estimate from the model's price, "412k tok" for a free model or one with no known price; '' for
 * nothing used.
 */
export function usageText(u: UsageTotals | null | undefined): string {
  if (!u) return '';
  const tok = u.tokens || u.input + u.output;
  const t = tok > 0 ? `${tokensText(tok)} tok` : '';
  if (u.costUsd !== null && u.costUsd > 0) return `${(u.estimatedUsd ?? 0) > 0 ? '≈' : ''}${costText(u.costUsd)}${t ? ` · ${t}` : ''}`;
  return t;
}

/** The Cost cell of the usage table: "$0.42", "≈$0.42" (estimated), "free" (cost 0), "—" (no cost and no price). */
export function costCell(u: UsageTotals): string {
  if (u.costUsd === null) return '—';
  if (u.costUsd === 0) return 'free';
  return `${(u.estimatedUsd ?? 0) > 0 ? '≈' : ''}${costText(u.costUsd)}`;
}

/** What the cost of a run leaves out or estimates, one sentence each; empty when every round reported its cost. */
export function costNotes(u: UsageTotals): string[] {
  const notes: string[] = [];
  if ((u.estimatedUsd ?? 0) > 0) notes.push("≈ is an estimate: the agent reported tokens but no cost, so they are priced at the model's list price from OpenCode's model list.");
  const n = u.unpriced ?? 0;
  if (n > 0) notes.push(`${n} agent round${n === 1 ? '' : 's'} reported tokens but no cost, and no price is known for ${n === 1 ? 'its model' : 'their models'} (OpenCode not installed, or the model is not in its list); ${n === 1 ? 'it is' : 'they are'} left out of the cost.`);
  return notes;
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

/**
 * The test lock, only when it can be shown to stand: the engine recorded it after the Red tests commit (a row in
 * attempts.jsonl, dropped again when a stage at or before Red tests is retried), and git still shows a red-tests commit
 * on the run's branch. A run with either record missing gets no lock, whatever stage it has reached. While the lock is
 * open (the tests are being changed on purpose) there is no closed lock either.
 */
export function verifiedLock(v: Pick<GuardedRun, 'redCommit' | 'timeline'>): LockView | null {
  const lock = v.timeline?.lock || null;
  return lock && lock.sha && v.redCommit && !v.timeline?.lockOpen ? lock : null;
}

/** The open lock, when the engine recorded that tests which were locked are being changed again. */
export const openLock = (v: Pick<GuardedRun, 'timeline'>): LockOpen | null => v.timeline?.lockOpen || null;

/** Why the lock is open, in one sentence. */
export function openSentence(o: LockOpen): string {
  const was = o.sha ? ` (they were locked at ${o.sha.slice(0, 7)})` : '';
  if (o.reason === 'review-findings') return `Open: Review asked for changes, so Red tests is writing tests for its findings${was}. The lock closes when they are committed.`;
  if (o.reason === 'test-repair') return `Open: Test repair is changing the tests it claimed${was}. The lock closes when the repair is checked and committed; a rejected repair puts the tests back.`;
  return `Open: a stage at or before Red tests was started again, so the tests are being rewritten${was}. The lock closes when Red tests commits them.`;
}

export interface Guarantee { key: 'gates' | 'isolated' | 'pr'; title: string; detail: string; state: 'held' | 'pending' | 'broken' }

/**
 * What the run's own records show about how it is protected: its worktree and branch, and its pull request and CI.
 * The first item describes the pipeline and claims nothing about this run; the test lock is on the Red tests stage.
 */
export function guarantees(v: GuardedRun): Guarantee[] {
  const ci = v.prCi || (v.ci?.state.startsWith('green') ? 'passed' : v.ci?.state.startsWith('red') ? 'failed' : v.ci ? 'in progress' : null);
  return [
    { key: 'gates', title: 'Stage by stage', detail: 'A stage starts only after the one before it passes its check', state: 'pending' },
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

/** What the Red tests stage says about a recorded lock, in one sentence. */
export function lockSentence(lock: LockView): string {
  const n = lock.tests ? `${lock.tests} test${lock.tests > 1 ? 's' : ''}` : 'The tests';
  const where = lock.files ? ` in ${lock.files} file${lock.files > 1 ? 's' : ''}` : '';
  const how = lock.source === 'test-repair' ? 'locked again after Test repair' : 'locked when Red tests committed them';
  return `${n}${where} ${lock.tests === 1 ? 'was' : 'were'} ${how}, at ${lock.sha.slice(0, 7)}. A later stage that changes them is stopped.`;
}

/** One figure of the run page's totals strip. */
export interface TotalCell { label: string; value: string; title?: string }

/**
 * The run's totals as big figures above the cost table: cost (an estimate marked ≈), tokens, cache share, agent time and
 * agent rounds. A figure the run has nothing for shows a dash, never a zero.
 */
export function totalCells(u: UsageTotals): TotalCell[] {
  const tok = u.tokens || u.input + u.output;
  const cache = cacheShare(u);
  return [
    { label: 'cost', value: costCell(u), title: costNotes(u).join(' ') || undefined },
    { label: 'tokens', value: tok > 0 ? tokensText(tok) : '—', title: `${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out · ${u.cacheRead.toLocaleString()} cache read · ${u.cacheWrite.toLocaleString()} cache write` },
    { label: 'cached', value: cache === null ? '—' : `${cache}%` },
    { label: 'agent time', value: u.durationSec > 0 ? durationText(u.durationSec) : '—' },
    { label: 'rounds', value: u.rounds ? String(u.rounds) : '—' },
  ];
}

/** The board's Cost cell for a run: the cost on top ("$0.42", "≈$0.42", "free" or "—") and its tokens below; null before any round. */
export function boardCost(u: UsageTotals | null | undefined): { cost: string; tokens: string } | null {
  if (!u || !hasUsage(u)) return null;
  const tok = u.tokens || u.input + u.output;
  return { cost: costCell(u), tokens: tok > 0 ? `${tokensText(tok)} tok` : '' };
}
