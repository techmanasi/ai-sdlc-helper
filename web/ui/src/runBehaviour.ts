// The Run behaviour panel's rules, in the browser: the settings' shape, the environment variables they set, and the
// validation of an extra variable's name. The server keeps the same rules (src/config/run-behaviour.ts); this copy
// runs in the browser so it can validate before the round-trip and label a value that the server's own environment sets.

/** The run behaviour settings one user saves for a project. The units are the pipeline's: seconds (see pipeline/agent.ts limitWait). */
export interface RunBehaviourSettings {
  allowMerged?: boolean;
  limitRetry?: number;
  limitMaxWait?: number;
  env?: Record<string, string>;
}

export type RunEnvField = 'allowMerged' | 'limitRetry' | 'limitMaxWait';

/** The environment variable each run behaviour field sets. */
export const RUN_ENV: Record<RunEnvField, string> = {
  allowMerged: 'SDLC_ALLOW_MERGED',
  limitRetry: 'SDLC_LIMIT_RETRY',
  limitMaxWait: 'SDLC_LIMIT_MAX_WAIT',
};

/** A variable name: an uppercase letter, then letters, digits and underscores. */
export const RUN_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** The names the controls own (CONTROL_ENV) and the personal agent blob: an extra variable must not shadow them. */
export const RUN_RESERVED_ENV: readonly string[] = ['SDLC_BASE', 'SDLC_WT_BASE', 'SDLC_MAX_PARALLEL', 'SDLC_ALLOW_MERGED', 'FROM', 'AI_SDLC_HELPER_PIPELINE_CMD', 'WATCH_REPORT_DEPENDENCIES', 'SDLC_PERSONAL_AGENT'];

/** The problem with a variable name the user typed, or null when it is allowed (an empty name is "no row yet", also fine). */
export function variableNameError(name: string): string | null {
  if (!name) return null;
  if (!RUN_ENV_NAME.test(name)) return 'A name is an uppercase letter, then letters, digits and underscores (for example FOO_BAR).';
  if (RUN_RESERVED_ENV.includes(name)) return `${name} is set by the tool itself; choose another name.`;
  return null;
}

/** The "set in the environment" note for a name the server's own environment sets; '' otherwise. */
export function envSetNote(name: string, envSet: Record<string, string> | undefined): string {
  return envSet && Object.prototype.hasOwnProperty.call(envSet, name) ? 'set in the environment' : '';
}

/** The problem with a whole-number-of-seconds field, or null when it is empty (unset) or parses. */
export function secondsError(value: string, min: number, label: string): string | null {
  if (value === '') return null;
  if (!/^\d+$/.test(value)) return `${label} must be a whole number of seconds.`;
  if (Number(value) < min) return `${label} must be ${min} or more seconds.`;
  return null;
}
