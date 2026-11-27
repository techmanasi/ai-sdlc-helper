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
