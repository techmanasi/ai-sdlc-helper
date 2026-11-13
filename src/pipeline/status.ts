// The status file: ONE small JSON line, replaced (never appended), so the pane and `watch` read it cheaply.
import fs from 'node:fs';
import { stamp } from './context.js';
import { STEPS } from './steps.js';
import { procStart } from '../runs/proc.js';

export type RunState = 'running' | 'done' | 'paused' | 'failed';

export interface StatusLine {
  slug: string;
  state: RunState;
  stage: string;
  agent: string;
  model: string;
  effort: string;
  models: Record<string, { model: string; effort: string }>;
  attempt: string;
  agent_started: string;
  run_started: string;
  updated: string;
  pid: number;
  /** When that process started (see procStart), so a later process with the same pid is not taken for the run; absent when unknown. */
  pid_start?: string;
  /** Why a running run waits, for example "usage limit, resets 1:10am (Asia/Dubai)" (only when SDLC_LIMIT_RETRY is set); empty otherwise. */
  note: string;
  /** The full suite in CI (tests.fullSuite "ci"); absent when the setting is off. */
  ci?: CiStatus;
  /** What the stage is doing now: step i of n, a plain-language label, when it began. Present only while a step runs. */
  step?: StepLine;
  /** Which start of this item this run is (1 for the first), and how the one before ended; absent on old files. */
  run_number?: number;
  previous_run?: PreviousRun;
  /** The branch the run is on when it is not <prefix><slug> (it moved: see branch-move.ts). */
  branch?: string;
  moved_from?: MovedFrom;
}

/** Where a run came from when it moved to a new branch, and why. */
export interface MovedFrom { branch: string; reason: string; pr?: string | null; at: string }

/** How the start before this one ended, as far as is known. */
export interface PreviousRun { stage?: string; state?: string; at?: string }

/** Where the full suite stands when it runs in CI, for the run page and `watch`. */
export interface CiStatus {
  enabled: boolean;
  /** waiting, running, green, red: side effect, green with warnings, timed out (paused), unavailable: running locally. */
  state: string;
  /** Why CI is unavailable (the run runs the full suite locally). */
  reason?: string;
  /** The PR link. */
  pr?: string | null;
  /** Whether the PR is still a draft (Finalise marks it ready). */
  prDraft?: boolean;
  failingChecks?: string[];
  warnings?: string[];
}

export interface StepLine { i: number; n: number; label: string; started: string }

/** <logDir>/status.json, written with the same fields, order and values as the shell pipeline wrote them. */
export class Status {
  state: RunState = 'running';
  stage = '';
  agent = '';
  model = '';
  effort = '';
  models: StatusLine['models'] = {};
  attempt = '';
  agentStarted = '';
  note = '';
  ci?: CiStatus;
  step: StepLine | null = null;
  runNumber?: number;
  previousRun?: PreviousRun;
  branch?: string;
  movedFrom?: MovedFrom;
  private stepId = '';
  readonly runStarted = stamp();

  constructor(readonly file: string, readonly slug: string, readonly pid = process.pid) {}

  line(): StatusLine {
    const line: StatusLine = {
      slug: this.slug, state: this.state, stage: this.stage, agent: this.agent, model: this.model, effort: this.effort,
      models: this.models, attempt: this.attempt, agent_started: this.agentStarted, run_started: this.runStarted,
      updated: stamp(), pid: this.pid, ...(this.pidStart() ? { pid_start: this.pidStart() } : {}), note: this.note,
      ...(this.ci ? { ci: this.ci } : {}),
    };
    if (this.step) line.step = this.step;
    if (this.runNumber) line.run_number = this.runNumber;
    if (this.branch) line.branch = this.branch;
    if (this.movedFrom) line.moved_from = this.movedFrom;
    if (this.previousRun && Object.keys(this.previousRun).length) line.previous_run = this.previousRun;
    return line;
  }

  /**
   * Name the step the stage has reached (a key from STEPS). One write at each boundary, no timer: the run screen works
   * out the elapsed time from `started`. Does nothing for an unknown key or the step already shown, and never throws:
   * a banner must not be able to fail a run.
   */
  beginStep(key: string, detail = ''): void {
    try {
      const list = STEPS[this.stage];
      const at = list ? list.findIndex(s => s.key === key) : -1;
      if (!list || at < 0) return;
      const id = `${this.stage}/${key}/${detail}`;
      if (this.step && this.stepId === id) return;
      this.stepId = id;
      const label = detail ? `${list[at].label}: ${detail}` : list[at].label;
      this.step = { i: at + 1, n: list.length, label, started: new Date().toISOString() };
      this.write();
    } catch { /* best effort */ }
  }

  private started: string | null = null;
  /** This process's start time, asked for once; '' for a pid that is not this process. */
  private pidStart(): string {
    if (this.started === null) this.started = this.pid === process.pid ? procStart(this.pid) : '';
    return this.started;
  }

  write(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.line())}\n`);
    fs.renameSync(tmp, this.file);
  }
}

/** The stage a status file names ('' when there is none): a resume that stops before its first stage keeps the one it had. */
export function previousStage(file: string): string {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return typeof j.stage === 'string' ? j.stage : ''; } catch { return ''; }
}

/** The state a status file names ('' when there is none): read before this run overwrites it. */
export function previousState(file: string): string {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return typeof j.state === 'string' ? j.state : ''; } catch { return ''; }
}

/** The final state for an exit code: done (0), paused for answers (2), failed (anything else). */
export const finalState = (code: number): RunState => (code === 0 ? 'done' : code === 2 ? 'paused' : 'failed');

/** The branch and move a status file names (both absent when there is none): read before this run overwrites it. */
export function previousBranch(file: string): { branch?: string; movedFrom?: MovedFrom } {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const m = j.moved_from;
    return {
      ...(typeof j.branch === 'string' && j.branch ? { branch: j.branch } : {}),
      ...(m && typeof m.branch === 'string' ? { movedFrom: m as MovedFrom } : {}),
    };
  } catch { return {}; }
}
