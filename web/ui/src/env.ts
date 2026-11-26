import { DEFAULT_REVIEW_LIMIT, parseReviewLimit, REVIEW_LIMIT_ENV, REVIEW_LIMIT_REQUIREMENT } from 'ai-sdlc-helper/review-limit';

// The run page's environment rows: [name, value] pairs edited in the "Environment" panel.
export type EnvRow = [string, string];

/** Sets a variable to a value, replacing any row of that name; an empty value removes it. */
export const setEnvValue = (rows: EnvRow[], k: string, val: string): EnvRow[] =>
  val ? [...rows.filter(r => r[0].trim() !== k), [k, val]] : rows.filter(r => r[0].trim() !== k);

/**
 * A quick button: adds a row for the variable with its default value (empty when it has none, for the user to fill
 * in). A row already named k is kept as it is, so a second click adds nothing.
 */
export const addEnvKey = (rows: EnvRow[], k: string, def = ''): EnvRow[] =>
  rows.some(r => r[0].trim() === k) ? rows : [...rows, [k, def]];

/** The quick buttons still to show: those whose variable has no row yet (an empty-valued row counts as present). */
export const quickKeys = (rows: EnvRow[], keys: string[]): string[] =>
  keys.filter(k => !rows.some(r => r[0].trim() === k));

/** The variables a run starts with: named rows with a value. A row still waiting for its value is left out, so a
 * quick button's empty row never sends NAME= (an empty SDLC_BASE, ...). */
export const envVars = (rows: EnvRow[]): Record<string, string> =>
  Object.fromEntries(rows.filter(([k, v]) => k.trim() && v !== '').map(([k, v]) => [k.trim(), v]));

export type ReviewConfig = { review?: { maxLoops?: number } };
export type SettingsResult = { error: string; patch: { review?: { maxLoops: number } } };
export type RunOptions = { error: string; env: Record<string, string>; summary: string; canLaunch: boolean };

/** Initializes the review loop limit draft in project settings. */
export function reviewSettingsDraft(config?: ReviewConfig | null): string {
  return String(config?.review?.maxLoops ?? DEFAULT_REVIEW_LIMIT);
}

/** Validates and builds the review loop limit patch for project settings. */
export function reviewSettingsPatch(config: ReviewConfig | undefined | null, draft: string): SettingsResult {
  const limit = parseReviewLimit(draft);
  if (limit === undefined) {
    return { error: `Review loop limit ${REVIEW_LIMIT_REQUIREMENT}`, patch: {} };
  }
  const current = config?.review?.maxLoops ?? DEFAULT_REVIEW_LIMIT;
  const patch: { review?: { maxLoops: number } } = {};
  if (limit !== current) {
    patch.review = { maxLoops: limit };
  }
  return { error: '', patch };
}

/** Error message when a review loop limit override row is invalid; empty string if valid or unset. */
export function reviewLimitError(rows: EnvRow[]): string {
  const invalid = rows.find(([k, v]) => k.trim() === REVIEW_LIMIT_ENV && v !== '' && parseReviewLimit(v) === undefined);
  return invalid ? `Review loop limit override ${REVIEW_LIMIT_REQUIREMENT}` : '';
}

/** Validates the review loop limit override in run environment rows. */
export function reviewLimitOptions(rows: EnvRow[]): RunOptions {
  const error = reviewLimitError(rows);
  const env = envVars(rows);
  if (error) {
    delete env[REVIEW_LIMIT_ENV];
    return { error, env, summary: '', canLaunch: false };
  }
  const val = env[REVIEW_LIMIT_ENV];
  const summary = val !== undefined ? `review loop limit ${val}` : '';
  return { error: '', env, summary, canLaunch: true };
}
