// The New item screen's plain logic: the stage rows, their project-default summary, the live branch line and the
// command shown for each When choice. No DOM here, so test/ can exercise it directly.
import { cliLine, shellArg, type SettingsView } from './api.js';

export type When = 'now' | 'later';

/** The stages of a run, in order, with the notes the New item screen shows beside them. */
export const STAGES: ReadonlyArray<{ key: string; name: string; tag: string }> = [
  { key: 'spec', name: 'Spec', tag: '' },
  { key: 'plan', name: 'Plan', tag: '' },
  { key: 'red-tests', name: 'Red tests', tag: '' },
  { key: 'implement', name: 'Implement', tag: '' },
  { key: 'test-repair', name: 'Test repair', tag: 'if needed' },
  { key: 'review', name: 'Review', tag: '' },
  { key: 'finalise', name: 'Finalise', tag: '' },
  { key: 'resolve-conflicts', name: 'Resolve conflicts', tag: 'after PR' },
];

/** One item-only override: an empty field keeps what the project or the stage default says. */
export interface ItemPick { harness: string; model: string; effort: string }

/**
 * The branch a run of this item gets: the git branch prefix plus the slug, as `branchExists` in src/backlog/index.ts
 * names it. The prefix comes from the project's resolved settings; without them it is the same `sdlc/` default.
 */
export function branchLine(slug: string, prefix?: string): string {
  return `Branch: ${prefix || 'sdlc/'}${slug.trim() || '<slug>'}`;
}

/** What the project will use for one stage, from the settings the screen already loads. */
export function defaultsSummary(stage: string, settings?: SettingsView | null): string {
  if (!settings) return 'default';
  // The server's stage list is AGENT_STAGES: a stage absent from it, such as Finalise, runs no agent.
  if (!settings.stages.includes(stage)) return 'no agent';
  const own = settings.config?.agent?.stages?.[stage] || {};
  const project = settings.config?.agent;
  const builtIn = settings.stageDefaults?.[stage];
  const agent = own.harness || project?.harness || 'default';
  const model = own.model || project?.model || builtIn?.model || 'default';
  const effort = own.effort || project?.effort || builtIn?.effort || 'default';
  if (agent === 'default' && model === 'default' && effort === 'default') return 'default';
  return `${agent} · ${model} · ${effort}`;
}

/** Item-only picks as the run's per-stage environment overrides (the same names the pipeline reads). */
export function stageEnv(picks: Record<string, ItemPick>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [stage, pick] of Object.entries(picks)) {
    const key = stage.toUpperCase().replace(/-/g, '_');
    if (pick.harness) env[`AGENT_${key}`] = pick.harness;
    if (pick.model) env[`MODEL_${key}`] = pick.model;
    if (pick.effort) env[`EFFORT_${key}`] = pick.effort;
  }
  return env;
}

/**
 * The command shown under the form. `now` is the command the button runs. `later` is the command to start the item
 * once it is on the board: adding without starting has no CLI command, so the line says plainly that it is for later.
 */
export function newItemCommand(when: When, slug: string, env: Record<string, string> = {}): string {
  const prefix = Object.keys(env).sort().map(k => `${shellArg(k)}=${shellArg(env[k])}`).join(' ');
  const line = `${prefix ? `${prefix} ` : ''}${cliLine(['start', slug])}`;
  return when === 'later' ? `${line}  # added to the board now; run this when you're ready` : line;
}
