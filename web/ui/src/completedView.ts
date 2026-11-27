// Filtering and recorded-stage presentation for the Completed page, kept apart from Preact so the decisions are testable.

export interface CompletedFilterItem {
  slug: string;
  title: string;
  branch: string;
}

/** Live, case-insensitive search across the item's title, slug and branch. */
export function filterCompletedTasks<T extends CompletedFilterItem>(tasks: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...tasks];
  return tasks.filter(t => [t.title, t.slug, t.branch].some(value => value.toLowerCase().includes(q)));
}

export type CompletedStageStatus = 'started' | 'completed' | 'failed' | 'paused' | 'stopped';
export interface CompletedStageMark {
  stage: string;
  status: CompletedStageStatus;
}
export type CompletedSegmentState = 'done' | 'no-record' | 'not-needed';
export interface CompletedStageSegment {
  stage: string;
  state: CompletedSegmentState;
  label: string;
}
export interface CompletedStageView {
  segments: CompletedStageSegment[];
  note: string;
}

export const COMPLETED_STAGES = ['Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Finalise', 'Resolve conflicts'] as const;
const CONDITIONAL_STAGES = new Set<string>(['Test repair', 'Resolve conflicts']);

/**
 * The stages a completed item's timeline proves. A regular stage with no record shows as "no record" (nothing records a skip); a missing conditional stage was
 * not needed. No timeline (or one whose recorded stages did not complete) has no bar: the design has no honest state for it.
 */
export function completedStageView(marks: readonly CompletedStageMark[] | null | undefined): CompletedStageView | null {
  if (!marks?.length) return null;
  const recorded = new Map<string, CompletedStageMark>();
  for (const mark of marks) {
    if ((COMPLETED_STAGES as readonly string[]).includes(mark.stage)) recorded.set(mark.stage, mark);
  }
  if (!recorded.size || [...recorded.values()].some(mark => mark.status !== 'completed')) return null;

  const segments = COMPLETED_STAGES.map(stage => {
    const state: CompletedSegmentState = recorded.has(stage) ? 'done' : CONDITIONAL_STAGES.has(stage) ? 'not-needed' : 'no-record';
    return { stage, state, label: `${stage}: ${state === 'not-needed' ? 'not needed' : state === 'no-record' ? 'no record' : state}` };
  });
  const ran = [...recorded.keys()].filter(stage => CONDITIONAL_STAGES.has(stage));
  const count = recorded.size;
  const note = [`${count} stage${count === 1 ? '' : 's'}`, ...ran.map(stage => `${stage} ran`)].join(' · ');
  return { segments, note };
}
