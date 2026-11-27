// Run behaviour settings: what one user changes for a project on this machine, kept in the registry (projects.json,
// overrides.run) like the personal agent settings. They map to environment variables the controls and the pipeline read,
// so a run worktree (whose registry entry belongs to the main tree) needs no separate hand-off. A variable the server's
// own environment already sets wins over the saved one.
import { findContaining, readRegistry } from '../registry/projects.js';
import { PERSONAL_ENV } from './personal.js';

/** The controls' own environment variables: read here, never passed to the pipeline. (Moved from runs so the run-behaviour rules can name them without a cycle.) */
export const CONTROL_ENV = ['SDLC_BASE', 'SDLC_WT_BASE', 'SDLC_MAX_PARALLEL', 'SDLC_ALLOW_MERGED', 'FROM', 'AI_SDLC_HELPER_PIPELINE_CMD', 'WATCH_REPORT_DEPENDENCIES'] as const;

/** The environment variables the run behaviour settings set. */
export const RUN_ENV = {
  allowMerged: 'SDLC_ALLOW_MERGED',
  limitRetry: 'SDLC_LIMIT_RETRY',
  limitMaxWait: 'SDLC_LIMIT_MAX_WAIT',
} as const;

/** A variable name: an uppercase letter, then letters, digits and underscores. */
export const RUN_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** The names an extra variable must not shadow: the controls' own, and the personal agent blob. */
export const RUN_RESERVED_ENV: readonly string[] = [...CONTROL_ENV, PERSONAL_ENV];

/** The run behaviour settings one user saves for a project. The units are the pipeline's: seconds (see pipeline/agent.ts limitWait). */
export interface RunBehaviour {
  /** Allow running an item whose red-tests commit is already in the base (SDLC_ALLOW_MERGED=1). */
  allowMerged?: boolean;
  /** Seconds between usage-limit retries; 0 = off (SDLC_LIMIT_RETRY). */
  limitRetry?: number;
  /** Seconds to keep retrying in all (SDLC_LIMIT_MAX_WAIT; only used when retry is on). */
  limitMaxWait?: number;
  /** Extra variables for the pipeline, in the order they were added. */
  env?: Record<string, string>;
}

/** The run behaviour settings of the project at <root>, from overrides.run; undefined when there are none or the registry is corrupt. */
export function runBehaviourOf(root: string, env: NodeJS.ProcessEnv): RunBehaviour | undefined {
  try {
    const run = findContaining(readRegistry(env), root)?.overrides?.run;
    return run && typeof run === 'object' && !Array.isArray(run) ? (run as RunBehaviour) : undefined;
  } catch { return undefined; } // a corrupt registry is reported by the commands that read it
}

/** Problems with a run behaviour value (the stored form: only set keys, no nulls), as "path: problem" lines. */
export function runBehaviourErrors(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['must be an object'];
  const o = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (k === 'allowMerged') {
      if (typeof v !== 'boolean') errors.push(`allowMerged: must be true or false (got ${JSON.stringify(v)})`);
    } else if (k === 'limitRetry') {
      if (!(Number.isInteger(v) && (v as number) >= 0)) errors.push(`limitRetry: must be a whole number of seconds, 0 or more (got ${JSON.stringify(v)})`);
    } else if (k === 'limitMaxWait') {
      if (!(Number.isInteger(v) && (v as number) > 0)) errors.push(`limitMaxWait: must be a whole number of seconds, 1 or more (got ${JSON.stringify(v)})`);
    } else if (k === 'env') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) errors.push('env: must be an object of names and values');
      else for (const [name, val] of Object.entries(v as Record<string, unknown>)) {
        if (!RUN_ENV_NAME.test(name)) errors.push(`env.${name}: a name is an uppercase letter, then letters, digits and underscores`);
        else if (RUN_RESERVED_ENV.includes(name)) errors.push(`env.${name}: ${name} is set by the tool itself`);
        if (typeof val !== 'string') errors.push(`env.${name}: must be text`);
      }
    } else errors.push(`${k}: not a run behaviour setting`);
  }
  return errors;
}

/**
 * <run> as the environment variables the controls and pipeline read. A name the server's own environment already sets
 * is left to it (the server wins); so the result only holds the saved values that would actually apply.
 */
export function runEnv(run: RunBehaviour | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  if (!run || typeof run !== 'object' || Array.isArray(run)) return out;
  const set = (name: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    if (env[name] !== undefined) return; // the server's own environment wins
    out[name] = String(value);
  };
  if (run.allowMerged === true) set(RUN_ENV.allowMerged, '1');
  set(RUN_ENV.limitRetry, run.limitRetry);
  set(RUN_ENV.limitMaxWait, run.limitMaxWait);
  for (const [name, value] of Object.entries(run.env || {})) set(name, value);
  return out;
}

/** The run-behaviour names (the saved ones and the built-ins) the server's own environment sets, name → value, for the UI's "set in the environment" note. */
export function runEnvSet(run: RunBehaviour | undefined, env: NodeJS.ProcessEnv): Record<string, string> {
  const names = [RUN_ENV.allowMerged, RUN_ENV.limitRetry, RUN_ENV.limitMaxWait, ...Object.keys(run?.env || {})];
  return Object.fromEntries([...new Set(names)].filter(n => env[n] !== undefined).map(n => [n, String(env[n])]));
}
