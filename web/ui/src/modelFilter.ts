import { filterModels as groupModels } from './stageAgent.js';

/** The flat matches for older callers; the filter itself lives with the grouping in stageAgent.ts. */
export function filterModels<T extends { id: string; name: string; displayName?: string; providerName?: string }>(models: readonly T[], query: string): T[] {
  return groupModels(models, query).flatMap(group => group.models);
}

/**
 * How a stage's config names <model>: its display name when every provider offers it under a different one, else the
 * provider-routed id. A display name two providers share ("kimi-k3") would be ambiguous at run time, so the id keeps
 * the picker's choice explicit.
 */
export function configValue<T extends { id: string; displayName?: string }>(model: T, models: readonly T[]): string {
  const name = model.displayName || model.id;
  return models.some(other => other !== model && (other.displayName || other.id) === name) ? model.id : name;
}

/** Move a highlighted option by `delta` and wrap at both ends, so ArrowDown on the last row starts again at the top. */
export function nextIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}
