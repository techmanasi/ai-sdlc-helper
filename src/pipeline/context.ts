// What every part of a pipeline run shares: the stages, how a run stops, and the run's context.
import path from 'node:path';
import type { Config, Layout } from '../config/settings.js';
import type { Keys } from '../testcheck/keys.js';
import type { AgentSpawn } from './agent.js';
import type { Git } from './git.js';
import type { Status } from './status.js';

/** The stages a run can start at (FROM), in order. */
export const FROM_STAGES = ['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'review', 'finalise'] as const;
export type From = typeof FROM_STAGES[number];

/** The stages that run an agent, each with its own prompt, model and effort. */
export const AGENT_STAGES = ['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'test-audit', 'review'] as const;
export type AgentStage = typeof AGENT_STAGES[number];

/** Ends the run with an exit code: 0 done, 1 failed, 2 paused for the developer. What to say was printed already. */
export class Exit extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

/** A problem with the settings, the models or the prompts: printed on stderr, and the run fails (exit 1). */
export class SetupError extends Error {}

/** Local time as the status file writes it: 2026-10-17T14:05:09. */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Lets the event loop run between long synchronous steps (git chains, test runs). */
export const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

export interface Limits {
  /** Implement attempts (MAX_ATTEMPTS, default 4). */
  maxAttempts: number;
  /** Turns per agent (MAX_TURNS, default 40). */
  maxTurns: number;
  /** Tests Test repair may claim (MAX_REPAIR_TESTS, default 3). */
  maxRepairTests: number;
}

/** One pipeline run. Paths named `docs`, `log` and `backlog` are from the root, as the prompts and messages show them. */
export interface Ctx {
  root: string;
  config: Config;
  layout: Layout;
  slug: string;
  from: From;
  fromN: number;
  docs: string;
  log: string;
  backlog: string;
  branch: string;
  /** The environment the agents, tests and commands get: the caller's, without FROM. */
  env: NodeJS.ProcessEnv;
  /** SDLC_PROVIDER* keys read from the project's .env, for model resolution only (never passed on). */
  envModels: Record<string, string>;
  registryFile: string;
  limits: Limits;
  git: Git;
  keys: Keys;
  status: Status;
  spawnAgent: AgentSpawn;
  signal?: AbortSignal;
  promptsDir: string;
  /** The code search text for {{CODE_SEARCH}}. */
  guide: string;
  /** The tools every stage agent may use (before the developer's grants). */
  allowed: string[];
  /** The command that runs one test file: `<cmd> <file>`. */
  testFileCmd: string;
  /** The GET-only web read for agents ({{FETCH_CMD}}). */
  fetchCmd: string;
  permRepo: string;
  redSha: string;
  lockSha: string;
  origRedSha: string;
  /** The log of the check that failed last (tests.log or integration.log). */
  failLog: string;
  out(line: string): void;
  err(line: string): void;
}

/** <rel> (from the root) as an absolute path. */
export const at = (ctx: Pick<Ctx, 'root'>, rel: string): string => path.join(ctx.root, rel);

/** Prints <line> (stdout) and ends the run with <code>. */
export function stop(ctx: Pick<Ctx, 'out'>, line: string | null, code = 1): never {
  if (line !== null) ctx.out(line);
  throw new Exit(code);
}

/** Ends the run (failed) once it was stopped from outside (a signal). */
export function stopIfAborted(ctx: Pick<Ctx, 'out' | 'signal'>): void {
  if (ctx.signal && ctx.signal.aborted) stop(ctx, 'STOPPED: the run was stopped');
}
