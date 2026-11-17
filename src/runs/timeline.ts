// The per-stage timeline of a run, from the rows of <log>/attempts.jsonl: when each stage and step began and ended, what each
// stage's agent rounds cost, and the red-test lock with every time a guard enforced it. Pure: the caller reads the file.

export interface StepSpan { key: string; label: string; started: string; ended: string | null }
export interface UsageTotals { rounds: number; durationSec: number; turns: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null }
export interface StageSpan { stage: string; started: string; ended: string | null; passes: number; steps: StepSpan[]; usage: UsageTotals }
export interface LockView { sha: string; origRedSha: string; at: string; source: 'red-tests' | 'test-repair'; tests: number | null; files: number | null; relocks: number; guards: Array<{ at: string; stage: string; restored: string[] }> }
/**
 * The lock is open: tests that were locked are being changed on purpose, and stay open until they are committed again.
 * `retry`: a stage at or before Red tests was started again; `review-findings`: Review sent its findings back through
 * Red tests; `test-repair`: Test repair is changing the tests it claimed (the lock it holds meanwhile is the old one).
 */
export interface LockOpen { at: string; reason: 'retry' | 'review-findings' | 'test-repair'; sha: string }
export interface Timeline { stages: StageSpan[]; lock: LockView | null; /** Set while the lock is open; null when there is no lock to open or it is closed. */ lockOpen: LockOpen | null; usage: UsageTotals }

/** The status stage each agent stage belongs to. */
const STAGE_OF: Record<string, string> = {
  spec: 'Spec', plan: 'Plan', 'red-tests': 'Red tests', implement: 'Implement', 'test-repair': 'Test repair', 'test-audit': 'Test repair',
  review: 'Review', finalise: 'Finalise', 'resolve-conflicts': 'Resolve conflicts', 'resolve-judge': 'Resolve conflicts',
};
const stageOfAgent = (agentStage: string): string | null => STAGE_OF[agentStage] ?? (agentStage.startsWith('resolve-') ? 'Resolve conflicts' : null);

const emptyUsage = (): UsageTotals => ({ rounds: 0, durationSec: 0, turns: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const ms = (t: string): number => { const x = Date.parse(t); return Number.isFinite(x) ? x : NaN; };

function addRound(u: UsageTotals, r: Record<string, unknown>): void {
  u.rounds++;
  u.durationSec += n(r.durationSec);
  u.turns += n(r.turns);
  u.tokens += n(r.tokens);
  const x = r.usage && typeof r.usage === 'object' ? r.usage as Record<string, unknown> : null;
  if (!x) return;
  u.input += n(x.input);
  u.output += n(x.output);
  u.cacheRead += n(x.cacheRead);
  u.cacheWrite += n(x.cacheWrite);
  if (typeof x.costUsd === 'number' && Number.isFinite(x.costUsd)) u.costUsd = (u.costUsd ?? 0) + x.costUsd;
}

function sumUsage(list: UsageTotals[]): UsageTotals {
  const t = emptyUsage();
  for (const u of list) {
    t.rounds += u.rounds; t.durationSec += u.durationSec; t.turns += u.turns; t.tokens += u.tokens;
    t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite;
    if (u.costUsd !== null) t.costUsd = (t.costUsd ?? 0) + u.costUsd;
  }
  return t;
}

/** The stages that run before the tests are locked, by status name and by `--from` key ('' is a start from the top). When one of them runs again, the lock is gone until Red tests commits again. */
const BEFORE_LOCK_STAGES = new Set(['Spec', 'Plan', 'Red tests']);
const BEFORE_LOCK_KEYS = new Set(['', 'spec', 'plan', 'red-tests']);

/** All rows of an item's attempts.jsonl (every start of it) in order. <now> is accepted for callers that pass one; an open stage stays null. */
export function runTimeline(rows: unknown[], now?: string): Timeline {
  void now;
  const stages = new Map<string, StageSpan>();
  const starts = new Map<string, string>(); // `${agent}` of the open round -> its start row's time
  let current: StageSpan | null = null;
  let openStep: StepSpan | null = null;
  const closeAt = (at: string) => {
    if (openStep && openStep.ended === null) openStep.ended = at;
    openStep = null;
  };
  const locks: Array<Record<string, unknown>> = [];
  const guards: LockView['guards'] = [];
  let sawStage = false;
  let open: LockOpen | null = null;
  const lastSha = (): string => str(locks[locks.length - 1]?.sha);
  /** The lock recorded so far no longer stands; it was open from <at> for <reason> if there was one. */
  const unlock = (at: string, reason: LockOpen['reason']): void => {
    if (locks.length && !open) open = { at, reason, sha: lastSha() };
    locks.length = 0; guards.length = 0;
  };

  const spanFor = (name: string, started: string): StageSpan => {
    let s = stages.get(name);
    if (!s) { s = { stage: name, started, ended: null, passes: 0, steps: [], usage: emptyUsage() }; stages.set(name, s); }
    return s;
  };

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const at = str(r.at);
    switch (r.kind) {
      case 'run':
        // A start at or before Red tests writes the tests again: the lock recorded so far no longer stands.
        if (BEFORE_LOCK_KEYS.has(str(r.from))) unlock(at, 'retry');
        break;
      case 'stage': {
        const name = str(r.stage);
        if (!name || !at) break;
        if (BEFORE_LOCK_STAGES.has(name)) unlock(at, current?.stage === 'Review' ? 'review-findings' : 'retry');
        // Test repair changes the tests it claimed: open until it locks them again. A repair that is rejected puts the
        // tests back, so the next stage (or the end of the run) finds the old lock closed.
        else if (name === 'Test repair') { if (locks.length) open = { at, reason: 'test-repair', sha: lastSha() }; }
        else if (open?.reason === 'test-repair') open = null;
        sawStage = true;
        if (current && current.ended === null) current.ended = at;
        closeAt(at);
        const s = spanFor(name, at);
        s.passes++;
        s.steps = [];
        s.ended = null;
        current = s;
        break;
      }
      case 'step': {
        const key = str(r.key);
        if (!key || !at) break;
        closeAt(at);
        const s = spanFor(str(r.stage) || current?.stage || '', at);
        if (!s.stage) break;
        const span: StepSpan = { key, label: str(r.label) || key, started: at, ended: null };
        s.steps.push(span);
        openStep = span;
        break;
      }
      case 'end': {
        if (open?.reason === 'test-repair') open = null;
        if (current && current.ended === null && at) current.ended = at;
        closeAt(at);
        current = null;
        break;
      }
      case 'start': {
        starts.set(str(r.agent), at);
        break;
      }
      case 'agent': {
        const mapped = stageOfAgent(str(r.stage));
        const name = mapped ?? current?.stage ?? null;
        if (!name) break;
        let s = stages.get(name);
        if (!s) {
          // An old file with no stage rows: the stage begins when its first round began.
          const began = starts.get(str(r.agent)) || (() => {
            const t = ms(at);
            const d = n(r.durationSec);
            return Number.isFinite(t) ? new Date(t - d * 1000).toISOString() : at;
          })();
          s = spanFor(name, began);
          s.ended = at || null;
        } else if (!sawStage && at) {
          s.ended = at;
        }
        addRound(s.usage, r);
        break;
      }
      case 'lock': locks.push(r); open = null; break;
      case 'guard': guards.push({ at, stage: str(r.stage), restored: Array.isArray(r.restored) ? r.restored.filter((f): f is string => typeof f === 'string') : [] }); break;
      default: break;
    }
  }

  const list = [...stages.values()];
  const last = locks[locks.length - 1];
  const lock: LockView | null = last ? {
    sha: str(last.sha), origRedSha: str(last.origRedSha), at: str(last.at),
    source: last.source === 'test-repair' ? 'test-repair' : 'red-tests',
    tests: typeof last.tests === 'number' ? last.tests : null,
    files: typeof last.files === 'number' ? last.files : null,
    relocks: locks.length - 1,
    guards,
  } : null;
  return { stages: list, lock, lockOpen: open, usage: sumUsage(list.map(s => s.usage)) };
}
