// The stage pane under the run page's stage rail: which stage it shows, the colour of its outline, what a stage that has
// not started waits for, which round of a stage is on view, the pull request badge on Finalise, and when the rail may
// scroll a stage into view by itself. Pure, so the decisions are tested without a browser; RunInsights.tsx draws them.
import type { CiState, StageRound, StageSpan } from './api';
import type { TileState } from './insights';

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
