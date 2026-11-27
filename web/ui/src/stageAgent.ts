// Agent / model / effort choices for a stage: what the selectors show once the agent is changed, and which choices
// may not be started. Plain functions so they are tested without a DOM.
import type { ModelInfo } from './api.js';

export interface StagePick { agent?: string; model?: string; effort?: string }

/**
 * Whether the agent picked for a stage differs from the one the stage last ran with (or the file names). Then the
 * recorded model and effort belong to the other agent: the selectors must not offer them as "default (...)".
 */
export function agentChanged(pickedAgent: string | undefined, recordedAgent: string | undefined): boolean {
  return !!pickedAgent && !!recordedAgent && pickedAgent !== recordedAgent;
}

/** The label of a selector's "no choice" row: the recorded value as the default only while the agent is unchanged. */
export function defaultChoiceLabel(recorded: string | undefined, changed: boolean, fallback = 'default'): string {
  return recorded && !changed ? `default (${recorded})` : fallback;
}

/**
 * Why a stage's picks cannot be started, or '' when they can: a model the agent does not offer (a stale pick kept from
 * another agent), or an effort the model does not support. Only agents whose models the catalog lists are checked.
 */
export function pickProblem(stage: string, pick: StagePick, catalog: Record<string, ModelInfo[]>, ownsIds: (agent: string) => boolean = () => true): string {
  const { agent, model, effort } = pick;
  if (!agent || !model) return '';
  const list = catalog[agent];
  if (!list || !list.length || !ownsIds(agent)) return '';
  const info = list.find(m => m.id === model || m.name === model || m.displayName === model);
  if (!info) return `${stage}: model ${model} is not offered by ${agent}. Choose a model for ${agent} (or the default).`;
  if (effort && info.supportedEfforts !== undefined && !info.supportedEfforts.includes(effort)) {
    return `${stage}: effort ${effort} is not supported by ${model}.`;
  }
  return '';
}

/** A model as the listbox needs it: enough to filter it and to name the provider/harness group it belongs to. */
export interface GroupableModel {
  id: string;
  name: string;
  displayName?: string;
  providerId?: string;
  providerName?: string;
  harness?: string;
}

/** One section of the model listbox. */
export interface ModelGroup<T extends GroupableModel> {
  name: string;
  provider: string;
  models: T[];
}

/**
 * Filters the model catalog by id, display name, name and provider (case-insensitive), then groups the matches by
 * provider or harness when the catalog carries one. Without any group field every match goes into one "Models" group;
 * no match means no groups, so the listbox can show its empty message. Plain data in, plain data out: no DOM.
 */
export function filterModels<T extends GroupableModel>(models: readonly T[], query: string): Array<ModelGroup<T>> {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? models.filter(m => `${m.id}\n${m.displayName ?? ''}\n${m.name}\n${m.providerName ?? ''}\n${m.providerId ?? ''}`.toLowerCase().includes(needle))
    : [...models];
  const groups = new Map<string, T[]>();
  for (const model of matched) {
    const provider = model.providerId || model.providerName || model.harness || '';
    const list = groups.get(provider);
    if (list) list.push(model);
    else groups.set(provider, [model]);
  }
  return Array.from(groups, ([provider, found]) => ({
    name: groups.size === 1 && !provider ? 'Models' : (matched.find(m => (m.providerId || m.providerName || m.harness || '') === provider)?.providerName || provider),
    provider,
    models: found,
  }));
}

/** Where to put a fixed-position popover opened from a tile button, kept inside the viewport with an edge margin. */
export function popoverPosition(rect: { left: number; top: number; bottom: number; width: number }, view: { width: number; height: number }, width = 320, height = 230, edge = 8, gap = 6): { left: number; top: number; width: number } {
  const w = Math.min(width, Math.max(160, view.width - 2 * edge));
  const left = Math.max(edge, Math.min(rect.left, view.width - w - edge));
  const below = view.height - rect.bottom - gap - edge;
  const above = rect.top - gap - edge;
  const up = below < height && above > below;
  return { left, top: Math.max(edge, up ? rect.top - gap - Math.min(height, above) : rect.bottom + gap), width: w };
}
