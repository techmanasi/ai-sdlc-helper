// The stage pane under the run page's stage rail: which stage it shows, the colour of its outline, what a stage that has
// not started waits for, which round of a stage is on view, the pull request badge on Finalise, and when the rail may
// scroll a stage into view by itself. Pure, so the decisions are tested without a browser; RunInsights.tsx draws them.
import type { AttemptRound, CiState, RoundCause, RoundNext, RoundStartedBy, StageRound, StageSpan } from './api.js';
import { durationText, spanSeconds, type TileState } from './insights.js';

export interface PaneStage { key: string; name: string; state: TileState }

/**
 * The stage the pane follows when nothing is picked: the running stage, else the one that paused or failed, else the
 * stage a ready run resumes at, else (a finished run) the last stage that ran, else the first stage.
 */
export function followedStage(stages: readonly PaneStage[], run: { state: string; stage: string }): string {
  const live = stages.find(s => s.state === 'active' || s.state === 'paused' || s.state === 'failed');
  if (live) return live.key;
  if (run.state === 'ready') {
    const at = stages.find(s => s.name === run.stage);
    if (at) return at.key;
  }
  const ran = stages.filter(s => s.state === 'done');
  if (ran.length && run.state !== 'not started') return ran[ran.length - 1].key;
  return stages[0]?.key || '';
}

/** The stage on view: the one the user picked while it still exists, otherwise the followed one. */
export function shownStage(stages: readonly PaneStage[], followed: string, picked: string): string {
  return picked && stages.some(s => s.key === picked) ? picked : followed;
}

/**
 * The pane's outline and tab colour: red for a stage that stopped or failed, teal while it runs, green when done, grey
 * when it has not started (or was not needed).
 */
export type PaneTone = 'stop' | 'run' | 'done' | 'idle';
export function paneTone(state: TileState): PaneTone {
  if (state === 'failed' || state === 'paused') return 'stop';
  if (state === 'active') return 'run';
  if (state === 'done') return 'done';
  return 'idle';
}

/** The line beside the steps' heading saying why the pane shows this stage, or '' when the user picked it. */
export function followNote(state: TileState, followed: boolean): string {
  if (!followed) return '';
  if (state === 'active') return 'Following the running stage';
  if (state === 'paused') return 'Following the stage that waits for you';
  if (state === 'failed') return 'Following the stage where the run stopped';
  return '';
}

/**
 * The bar shown when the user picked a stage other than the followed one: what is on view, where the run is, and the
 * button back. Null when the pane shows the followed stage.
 */
export function backBar(stages: readonly PaneStage[], followed: string, shown: string): { text: string; back: string; live: boolean } | null {
  if (!followed || shown === followed) return null;
  const at = stages.find(s => s.key === followed);
  const on = stages.find(s => s.key === shown);
  if (!at || !on) return null;
  const notYet = on.state === 'pending' ? ', which has not started' : '';
  const where = at.state === 'active' ? `${at.name} is running. This pane goes back to the running stage by itself when the run moves on.`
    : at.state === 'paused' ? `${at.name} is waiting for you.`
      : at.state === 'failed' ? `The run stopped at ${at.name}.`
        : `The run is at ${at.name}.`;
  return { text: `You are looking at ${on.name}${notYet}. ${where}`, back: `Back to ${at.name}`, live: at.state === 'active' };
}

/** What a stage that has not started waits for, in order. */
const WAITS: Record<string, string[]> = {
  Plan: ['Spec'],
  'Red tests': ['Plan'],
  Implement: ['Red tests'],
  'Test repair': ['Implement, and only if it claims a test defect'],
  Review: ['Implement', 'Test repair, if needed'],
  Finalise: ['Review'],
  'Resolve conflicts': ['Finalise, and only if the pull request conflicts with its base'],
};
export function waitsFor(stage: string): string[] {
  return WAITS[stage] || [];
}

/** "Round 3" for a stage that ran more than once; '' for a single pass or none. */
export function roundLabel(passes: number | undefined): string {
  return passes && passes > 1 ? `Round ${passes}` : '';
}

/**
 * The passes of a stage on view, oldest first. A span from an older server or file has no rounds: its latest steps
 * stand in as the one pass.
 */
export function roundsOf(span: StageSpan | undefined): StageRound[] {
  if (!span) return [];
  if (span.rounds && span.rounds.length) return span.rounds;
  return [{ started: span.started, ended: span.ended, steps: span.steps }];
}

/**
 * The recorded words for a round's cause and next action. Nothing here is inferred from the stage's state: a run from
 * before round records still recorded how each round ended (the end row's state), and only that is used for it.
 */
const CAUSE_WORD: Record<RoundCause, string> = {
  passed: 'passed',
  'check-failed': 'check failed',
  questions: 'questions',
  permission: 'permission',
  limit: 'limit',
  error: 'error',
  stopped: 'stopped',
  'review-changes': 'review changes',
};
const NEXT_WORD: Record<RoundNext, string> = {
  'next-stage': 'next stage',
  retry: 'retry',
  pause: 'pause',
  stop: 'stop',
};
const START_WORD: Record<RoundStartedBy, string> = {
  run: 'the run reached this stage',
  resume: 'resumed',
  retry: 'retry',
  review: 'review asked for changes',
  user: 'you started it',
};

export interface RoundMark { n: number; tone: 'done' | 'stop' | 'run' | 'idle'; label: string }

/** How a round with no cause recorded ended, from the run's end row (older runs): passed, failed, paused or stopped. */
const ENDED_WORD: Partial<Record<NonNullable<StageRound['status']>, string>> = { completed: 'passed', failed: 'failed', paused: 'paused', stopped: 'stopped' };
const endedWord = (round: StageRound): string => (round.ended && !round.cause && round.status ? ENDED_WORD[round.status] || '' : '');

/**
 * One mark per recorded round, oldest first. An unclosed round is running; a passed one is done; a round whose end
 * cause was recorded is a stop; a round with no cause recorded has no claim to make, so it is idle.
 */
export function roundMarks(rounds: readonly StageRound[]): RoundMark[] {
  return rounds.map((round, i) => {
    const running = !round.ended;
    const cause = !running ? (round.cause ? CAUSE_WORD[round.cause] : endedWord(round)) : '';
    return {
      n: i + 1,
      tone: running ? 'run' as const : !cause ? 'idle' as const : cause === 'passed' ? 'done' as const : 'stop' as const,
      label: running ? 'running' : cause || '',
    };
  });
}

/** The tile's accessible name: a cause or "running" per round; a round with no cause is just its number. */
export function roundMarksLabel(rounds: readonly StageRound[]): string {
  if (!rounds.length) return '';
  return `Rounds: ${roundMarks(rounds).map(m => (m.label ? `${m.n} ${m.label}` : `${m.n}`)).join(', ')}`;
}

export interface AttemptMark { n: number; tone: 'done' | 'stop' | 'run' | 'idle'; label: string }

/**
 * One mark per recorded Implement attempt, then one dashed mark for each attempt the recorded iteration limit still
 * allows. Only recorded exit codes, gate failures and running rows decide a mark's state.
 */
export function attemptMarks(attempts: readonly AttemptRound[], maxAttempts?: number): AttemptMark[] {
  const marks: AttemptMark[] = attempts.map((a, i) => {
    const failed = !a.running && (a.exitCode !== 0 || (a.gate?.failing?.length ?? 0) > 0);
    return {
      n: i + 1,
      tone: a.running ? 'run' as const : failed ? 'stop' as const : 'done' as const,
      label: a.running ? 'running' : failed ? 'failed' : 'done',
    };
  });
  const left = maxAttempts && Number.isFinite(maxAttempts) ? Math.max(0, Math.floor(maxAttempts) - attempts.length) : 0;
  for (let i = 0; i < left; i++) marks.push({ n: attempts.length + i + 1, tone: 'idle', label: 'left' });
  return marks;
}

/** The tile's accessible name: one entry per recorded attempt, plus the remaining attempts when a max is known. */
export function attemptMarksLabel(attempts: readonly AttemptRound[], maxAttempts?: number): string {
  if (!attempts.length) return '';
  const marks = attemptMarks(attempts, maxAttempts);
  const parts = marks.filter(m => m.tone !== 'idle').map(m => `${m.n} ${m.label}`);
  const left = marks.filter(m => m.tone === 'idle').length;
  return `Attempts: ${left ? [...parts, `${left} left`].join(', ') : parts.join(', ')}`;
}

/** Why an attempt went back to Implementing, only from the gate result or the recorded error's first line. */
export function backToImplementText(attempt: AttemptRound): string {
  const failing = attempt.gate?.failing ?? [];
  const reason = failing.length
    ? `${failing.length} test${failing.length === 1 ? '' : 's'} failing`
    : (attempt.error || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  return reason ? `↩ Back to Implementing: ${reason}` : '';
}

/** Why a round began, only when the run recorded a reason. */
export function roundStartText(round: StageRound | undefined): string {
  const reason = round?.startedBy ? START_WORD[round.startedBy] : '';
  return reason ? `started: ${reason}` : '';
}

/** How a round ended and what came next, only when the run recorded an end cause; a running round has no end. */
export function roundEndText(round: StageRound | undefined): string {
  const ended = round ? endedWord(round) : '';
  if (ended === 'passed') return 'Passed';
  if (ended) return `${ended[0].toUpperCase()}${ended.slice(1)} · the reason was not recorded (a run from before round records)`;
  if (!round?.cause || !round.ended) return '';
  const cause = CAUSE_WORD[round.cause];
  if (!cause) return '';
  const next = round.next ? (round.cause === 'questions' && round.next === 'pause' ? 'paused for your answers' : NEXT_WORD[round.next]) : '';
  return `${cause[0].toUpperCase()}${cause.slice(1)}${next ? ` → ${next}` : ''}`;
}

/**
 * The hand-off between two rounds, when the earlier round recorded both its end and the time the user answered.
 * A count is used only when the caller has one recorded for that round.
 */
export function answeredBetween(prev: StageRound | undefined, next: StageRound | undefined, questions?: number): string {
  if (!prev?.ended || !prev.answeredAt || !next) return '';
  const from = Date.parse(prev.ended);
  const to = Date.parse(prev.answeredAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '';
  const sec = Math.floor((to - from) / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `You answered${questions && questions > 0 ? ` ${questions}` : ''} · ${mm}:${ss}`;
}

/** A normal end row closes the last step even on failure. An abrupt stop may only have a status timestamp. */
export function stepPills(round: StageRound | undefined, state: TileState, plan: readonly string[], updated: string, now: number) {
  const steps = round?.steps ?? [];
  const recorded = steps.map((step, i) => {
    // An earlier round that failed or was stopped recorded that in its end row, whatever the stage's state is now.
    const stopped = state === 'failed' || state === 'paused' || round?.status === 'failed' || round?.status === 'stopped';
    const cut = stopped && i === steps.length - 1 && (!step.ended || step.ended === round?.ended);
    const live = !step.ended && state === 'active';
    const end = step.ended || round?.ended || null;
    const seconds = spanSeconds(step.started, end, live ? now : Date.parse(updated));
    const time = durationText(seconds);
    return {
      label: step.label,
      state: cut ? 'cut' : live ? 'open' : 'done',
      time: cut ? (seconds === null ? 'failed' : `failed at ${time}`) : time,
    };
  });
  // A stage can skip optional steps or retry a step. Only preview steps beyond its furthest recorded one.
  const lastPlanned = steps.reduce((last, step) => Math.max(last, plan.indexOf(step.label)), -1);
  return recorded.concat(plan.slice(lastPlanned + 1).map(label => ({ label, state: 'plan', time: '' })));
}

/** The round on view: the one picked (1-based) when it exists, else the latest. */
export function pickRound(rounds: readonly StageRound[], picked: number): number {
  return picked >= 1 && picked <= rounds.length ? picked : rounds.length;
}

/** The pull request badge on the Finalise tile, once a pull request exists. */
export function prBadge(pr: { pr?: string | null; prState?: 'OPEN' | 'MERGED' | 'CLOSED' | null; prCi?: CiState | null }): { text: string; tone: 'ok' | 'wait' | 'bad' | 'plain'; title: string } | null {
  if (!pr.pr) return null;
  const num = pr.pr.match(/\/pull\/(\d+)/)?.[1];
  const name = num ? `Pull request #${num}` : 'The pull request';
  if (pr.prState === 'MERGED') return { text: 'PR · merged', tone: 'ok', title: `${name} is merged` };
  if (pr.prState === 'CLOSED') return { text: 'PR · closed', tone: 'plain', title: `${name} was closed without merging` };
  if (pr.prCi === 'passed') return { text: 'PR · CI ✓', tone: 'ok', title: `${name} is open and its CI passed` };
  if (pr.prCi === 'failed') return { text: 'PR · CI ✕', tone: 'bad', title: `${name} is open and its CI failed` };
  if (pr.prCi === 'in progress') return { text: 'PR · CI …', tone: 'wait', title: `${name} is open; CI is running` };
  return { text: 'PR · open', tone: 'wait', title: `${name} is open; CI has not reported yet` };
}

/** How long after the user scrolls the rail it is left alone, rather than jumping under their hand. */
export const HANDS_OFF_MS = 4000;
export function mayAutoScroll(lastUserScroll: number, now: number): boolean {
  return now - lastUserScroll >= HANDS_OFF_MS;
}

/**
 * On a rail that overflows, replace the leading done stages with one fold tile. Stop at the first stage that is not
 * done or is on view: folding must never hide a running, paused, failed or picked stage. Keep one stage if every stage
 * is done and there is no pick, so the rail never becomes only a fold tile.
 */
export function foldDone<T extends PaneStage>(tiles: readonly T[], widthFits: boolean, picked: string): { folded: T[]; shown: T[] } {
  if (widthFits) return { folded: [], shown: [...tiles] };
  let count = 0;
  while (count < tiles.length && tiles[count].state === 'done' && tiles[count].key !== picked) count++;
  if (count === tiles.length) count = Math.max(0, count - 1);
  return { folded: tiles.slice(0, count), shown: tiles.slice(count) };
}

/** The fold button's accessible name, including exactly which recorded stages it represents. */
export function doneFoldLabel(folded: readonly PaneStage[]): string {
  if (!folded.length) return '';
  return `${folded.length} stage${folded.length === 1 ? '' : 's'} done: ${folded.map(s => s.name).join(', ')}`;
}

/**
 * Where an edge arrow scrolls: the nearest tile whose middle is beyond that edge, brought into view by scrollTarget.
 * Null means that side has no hidden tile and its arrow is not shown.
 */
export function edgeScrollTarget(tiles: ReadonlyArray<{ left: number; width: number }>, scrollLeft: number, viewWidth: number, direction: 'left' | 'right'): number | null {
  const end = scrollLeft + viewWidth;
  const ordered = direction === 'left' ? [...tiles].reverse() : tiles;
  const tile = ordered.find(t => direction === 'left' ? t.left + t.width / 2 < scrollLeft : t.left + t.width / 2 > end);
  return tile ? scrollTarget(tile, scrollLeft, viewWidth) : null;
}

/**
 * How many tiles are cut off at each edge of a rail that scrolls sideways: a tile counts as hidden on a side when less
 * than half of it shows. <tiles> are each tile's left offset and width inside the scrolled content.
 */
export function hiddenCounts(tiles: ReadonlyArray<{ left: number; width: number }>, scrollLeft: number, viewWidth: number): { left: number; right: number } {
  let left = 0, right = 0;
  const end = scrollLeft + viewWidth;
  for (const t of tiles) {
    const mid = t.left + t.width / 2;
    if (mid < scrollLeft) left++;
    else if (mid > end) right++;
  }
  return { left, right };
}

/**
 * Where to scroll the rail so the tile is in view with a margin, or null when it already is. On the left edge it lands
 * <pad> pixels in; past the right edge its right side lands <pad> pixels short of the edge.
 */
export function scrollTarget(tile: { left: number; width: number }, scrollLeft: number, viewWidth: number, pad = 48): number | null {
  if (tile.left < scrollLeft) return Math.max(0, tile.left - pad);
  if (tile.left + tile.width > scrollLeft + viewWidth) return Math.max(0, tile.left + tile.width - viewWidth + pad);
  return null;
}

/**
 * On a phone the pane opens under a stage only when asked: a tap, or by itself when the followed stage paused, was
 * interrupted or failed. A running or finished stage does not open it.
 */
export function phoneOpens(followedState: TileState | undefined): boolean {
  return followedState === 'paused' || followedState === 'failed';
}
