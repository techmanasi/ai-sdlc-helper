// Per-stage-round facts kept while a run is in progress, then appended to attempts.jsonl when that round ends.
// Every field comes from what the pipeline knows at that point: a round that did not establish one leaves it out.
import { at, stamp, type Ctx } from './context.js';
import { appendRound, type RoundCause, type RoundNext, type RoundStartedBy, type StageRoundMark } from './observe.js';

export interface RoundOutcome { cause?: RoundCause; next?: RoundNext }

/** What a round record needs of a run: its root, log dir, output, and the stage it started from. */
export type RoundCtx = Pick<Ctx, 'root' | 'log' | 'out' | 'from'>;

interface OpenRound {
  stage: string;
  startedBy: RoundStartedBy;
  /** Every agent invocation of the round, by agent stage: several distinct ones leave the round's agent and model unknown. */
  agents: Array<{ stage: string; agent: string; model: string }>;
}

interface RunRounds {
  current?: OpenRound;
  /** The stages this process already started, so a stage that runs again is a rerun of it. */
  seen: Set<string>;
}

const rounds = new WeakMap<RoundCtx, RunRounds>();

function stateOf(ctx: RoundCtx): RunRounds {
  let state = rounds.get(ctx);
  if (!state) {
    state = { seen: new Set() };
    rounds.set(ctx, state);
  }
  return state;
}

/**
 * The agent stages that carry a round's own work. A round can run more than one agent (Test repair also audits, Review
 * may use several reviewers): only the ones that do the round's work name its agent and model.
 */
const OWN_AGENT: Record<string, (agentStage: string) => boolean> = {
  Spec: s => s === 'spec',
  Plan: s => s === 'plan',
  'Red tests': s => s === 'red-tests',
  Implement: s => s === 'implement',
  'Test repair': s => s === 'test-repair',
  Review: s => s === 'review' || s.startsWith('review-'),
  Finalise: s => s === 'finalise',
  'Resolve conflicts': s => s.startsWith('resolve'),
};

function usedAgent(round: OpenRound): { agent?: string; model?: string } {
  const own = OWN_AGENT[round.stage] || (() => true);
  const pairs = new Map<string, { agent: string; model: string }>();
  for (const a of round.agents) if (own(a.stage) && a.agent) pairs.set(`${a.agent}\0${a.model}`, { agent: a.agent, model: a.model });
  if (pairs.size !== 1) return {};
  const one = [...pairs.values()][0];
  return { ...(one.agent ? { agent: one.agent } : {}), ...(one.model ? { model: one.model } : {}) };
}

function writeRound(ctx: RoundCtx, round: OpenRound, outcome: RoundOutcome): void {
  const used = usedAgent(round);
  const row: StageRoundMark = {
    kind: 'round', at: stamp(), stage: round.stage,
    ...(outcome.cause ? { cause: outcome.cause } : {}),
    ...(outcome.next ? { next: outcome.next } : {}),
    ...used,
    startedBy: round.startedBy,
  };
  if (!appendRound(at(ctx, ctx.log), row)) {
    ctx.out(`WARNING: could not record the end of ${round.stage} in ${ctx.log}/attempts.jsonl (see ${ctx.log}/errors.log)`);
  }
}

/**
 * Starts the record for a stage round. Reaching another stage proves that the previous one returned normally; Review
 * sending its findings back through Red tests is its recorded fix loop. The previous round's row is written before the
 * new stage's row, so the timeline finds the round it closes.
 */
export function beginStageRound(ctx: RoundCtx, stage: string): void {
  const state = stateOf(ctx);
  const previous = state.current;
  if (previous) {
    const reviewChanges = previous.stage === 'Review' && stage === 'Red tests';
    const sameStage = previous.stage === stage;
    writeRound(ctx, previous, {
      ...(reviewChanges ? { cause: 'review-changes' as const } : sameStage ? {} : { cause: 'passed' as const }),
      next: reviewChanges || sameStage ? 'retry' : 'next-stage',
    });
  }
  const startedBy: RoundStartedBy = !state.seen.size
    ? ctx.from === 'spec' ? 'run' : 'resume'
    : previous?.stage === 'Review' && stage === 'Red tests'
      ? 'review'
      : state.seen.has(stage) ? 'retry' : 'run';
  state.current = { stage, startedBy, agents: [] };
  state.seen.add(stage);
}

/** Records an agent invocation of the open round; a round with several distinct agents stays unclaimed. */
export function noteStageRoundAgent(ctx: RoundCtx, agentStage: string, agent: string, model: string): void {
  const current = stateOf(ctx).current;
  if (!current || !agent) return;
  current.agents.push({ stage: agentStage, agent, model });
}

/** Appends the open round's end record. Unknown causes are deliberately left out rather than inferred from stop text. */
export function endStageRound(ctx: RoundCtx, outcome: RoundOutcome): void {
  const state = stateOf(ctx);
  if (!state.current) return;
  writeRound(ctx, state.current, outcome);
  state.current = undefined;
}
