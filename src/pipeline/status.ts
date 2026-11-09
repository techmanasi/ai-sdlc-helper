// The status file: ONE small JSON line, replaced (never appended), so the pane and `watch` read it cheaply.
import fs from 'node:fs';
import { stamp } from './context.js';

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
  /** Why a running run waits, for example "usage limit, resets 1:10am (Asia/Dubai)" (only when SDLC_LIMIT_RETRY is set); empty otherwise. */
  note: string;
  /** The full suite in CI (tests.fullSuite "ci"); absent when the setting is off. */
  ci?: CiStatus;
}

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
  readonly runStarted = stamp();

  constructor(readonly file: string, readonly slug: string, readonly pid = process.pid) {}

  line(): StatusLine {
    return {
      slug: this.slug, state: this.state, stage: this.stage, agent: this.agent, model: this.model, effort: this.effort,
      models: this.models, attempt: this.attempt, agent_started: this.agentStarted, run_started: this.runStarted,
      updated: stamp(), pid: this.pid, note: this.note,
      ...(this.ci ? { ci: this.ci } : {}),
    };
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

/** The final state for an exit code: done (0), paused for answers (2), failed (anything else). */
export const finalState = (code: number): RunState => (code === 0 ? 'done' : code === 2 ? 'paused' : 'failed');
