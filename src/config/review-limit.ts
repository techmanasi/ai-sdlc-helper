export const DEFAULT_REVIEW_LIMIT = 2;
export const REVIEW_LIMIT_ENV = 'SDLC_REVIEW_MAX_LOOPS';
export const REVIEW_LIMIT_REQUIREMENT = 'must be a whole number of 0 or more';

/** Project JSON uses a number. Form and environment values can also be decimal strings. */
export function parseReviewLimit(value: unknown): number | undefined {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())) {
    value = Number(value);
  }
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
