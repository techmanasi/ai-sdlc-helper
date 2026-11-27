// The board's segmented stage bar: one segment per stage in order, with conditional (dashed) segments for Test repair
// and Resolve conflicts until they have started. Logic kept apart from the component so it can be tested.

/** All 8 board stages, in order. Test repair and Resolve conflicts are conditional: drawn dashed until they ran. */
export const BOARD_STAGES = ['Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Finalise', 'Resolve conflicts'] as const;

/** The stages that are drawn dashed (conditional) until they have started or have a record. */
export const CONDITIONAL_STAGES = new Set<string>(['Test repair', 'Resolve conflicts']);

/** Segment state on the board strip, from what the run recorded. */
export type SegState = 'completed' | 'running' | 'failed' | 'paused' | 'not reached';

/** One segment of the board strip. */
export interface Segment {
  name: string;
  state: SegState;
  /** Drawn dashed: the stage is conditional and has not run yet. */
  dashed: boolean;
}

interface StageMark { stage: string; status?: 'started' | 'completed' | 'failed' | 'paused' | 'stopped' }

/**
 * The state a single stage's segment shows on the board, from the run's record of stages that began.
 * A stage with no record is "not reached", never "skipped": the pipeline may still run it.
 */
export function segStateOf(stage: string, marks: readonly StageMark[] | undefined | null): SegState {
  if (!marks?.length) return 'not reached';
  const mark = marks.find(m => m.stage === stage || (m.stage === '6/6 Finalise' && stage === 'Finalise'));
  if (!mark) return 'not reached';
  const s = mark.status;
  if (!s || s === 'started') return 'running';
  if (s === 'completed') return 'completed';
  if (s === 'failed' || s === 'stopped') return 'failed';
  if (s === 'paused') return 'paused';
  return 'not reached';
}

/** One segment per board stage, in order. */
export function segments(marks: readonly StageMark[] | undefined | null): Segment[] {
  return BOARD_STAGES.map(name => {
    const state = segStateOf(name, marks);
    return { name, state, dashed: CONDITIONAL_STAGES.has(name) && state === 'not reached' };
  });
}

/** Short label for one segment: "Spec" when not reached, "Implement · running" when there is a record. */
export function segmentLabel(seg: Segment): string {
  if (seg.state === 'not reached') return seg.name;
  const status = seg.state === 'completed' ? 'done'
    : seg.state === 'running' ? 'running'
    : seg.state === 'failed' ? 'failed'
    : /* paused */ 'paused';
  return `${seg.name} · ${status}`;
}

/**
 * The stage text under the strip on the board row: e.g. "Implement · running", "Failed at Red tests",
 * "Paused before Review". From the record when available, else from status.json's stage. Never invents a stage
 * the record does not name.
 */
export function boardStageText(r: { state: string; stage: string; stages?: readonly StageMark[] | null }): string {
  if (r.state === 'done') return 'All stages done';
  if (r.state === 'not started') return 'Not started';

  const marks = r.stages;
  if (marks?.length) {
    // The last non-completed stage is the one the run stopped at.
    const active = [...marks].reverse().find(m => m.status && m.status !== 'completed');
    if (active) {
      const name = active.stage === '6/6 Finalise' ? 'Finalise' : active.stage;
      if (r.state === 'running' && (active.status === 'started' || !active.status)) return `${name} · running`;
      if (r.state === 'paused' || active.status === 'paused') return `Paused before ${name}`;
      if (r.state === 'failed' || active.status === 'failed' || active.status === 'stopped') return `Failed at ${name}`;
    }
  }

  // Fall back to status.json's stage when the timeline has nothing.
  if (r.stage) {
    const name = r.stage === '6/6 Finalise' ? 'Finalise' : r.stage;
    if (r.state === 'running') return `${name} · running`;
    if (r.state === 'paused') return `Paused before ${name}`;
    if (['failed', 'stopped', 'interrupted', 'refused'].includes(r.state)) return `Failed at ${name}`;
  }

  return r.state;
}

/** Relative time for the UPDATED column: "now", "45s", "12m", "3h", "2d"; title carries the absolute time. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): { text: string; title: string } {
  if (!iso) return { text: '—', title: '' };
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { text: '—', title: iso };
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  const abs = new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (sec < 30) return { text: 'now', title: abs };
  if (sec < 60) return { text: `${sec}s`, title: abs };
  const min = Math.floor(sec / 60);
  if (min < 60) return { text: `${min}m`, title: abs };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { text: `${hr}h`, title: abs };
  const d = Math.floor(hr / 24);
  return { text: `${d}d`, title: abs };
}
