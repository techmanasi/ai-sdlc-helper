/** The pipeline's stages in run order, as status.json and stage-files.json name them. */
export const STAGE_ORDER = ['Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Finalise', 'Resolve conflicts'];

/**
 * The stage a stage discard may take back now: the last stage that ran. That is the stage the run is at, unless the
 * run is `ready` after a discard: it then stays at the discarded stage, and the last one that ran is the latest stage
 * before it that still has work in stage-files.json (none: ''). Discarding an earlier stage would leave the later
 * stages built on files that are gone.
 */
export function discardableStage(status: { state?: unknown; stage?: unknown }, stages: Record<string, unknown> | null | undefined): string {
  const at = typeof status.stage === 'string' ? status.stage : '';
  if (status.state !== 'ready') return at;
  const i = STAGE_ORDER.indexOf(at);
  const left = stages ? Object.keys(stages) : [];
  return STAGE_ORDER.filter((n, j) => (i < 0 || j < i) && left.includes(n)).pop() || '';
}
