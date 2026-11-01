// Personal agent settings: what one user changes for a project on this machine, kept in the registry (projects.json,
// overrides.agent) instead of the committed sdlc.config.json. They sit above the project's file and below the run's
// environment and flags. The pipeline of a run worktree gets them in SDLC_PERSONAL_AGENT, since the registry
// entry belongs to the main working tree.
import { findContaining, readRegistry } from '../registry/projects.js';
import type { Json } from '../util.js';

/** Where a setting comes from: the user's personal settings, the project's sdlc.config.json, or (absent) the built-in default. */
export type Source = 'personal' | 'project';
export const PERSONAL_ENV = 'SDLC_PERSONAL_AGENT';
export const PERSONAL_KEYS = ['harness', 'model', 'effort', 'stages'] as const;
const FIELDS = ['harness', 'model', 'effort'] as const;
const DEFAULT_HARNESS = 'claude';

/** The personal agent settings that apply to the project at <root>: from the environment (a run worktree), else its registry entry. */
export function personalAgentOf(root: string, env: NodeJS.ProcessEnv): Json | undefined {
  if (env[PERSONAL_ENV]) {
    try { const j = JSON.parse(env[PERSONAL_ENV] as string); return j && typeof j === 'object' && !Array.isArray(j) ? j : undefined; } catch { return undefined; }
  }
  try {
    const agent = findContaining(readRegistry(env), root)?.overrides?.agent;
    return agent && Object.keys(agent).length ? (agent as Json) : undefined;
  } catch { return undefined; } // a corrupt registry is reported by the commands that read it
}

/** <base> with the fields <over> sets; the model and effort <base> chose for another harness are dropped when the harness changes. */
function layer(base: Json, over: Json, wasHarness: string, nowParent: string): Json {
  const out: Json = { ...base };
  for (const k of FIELDS) if (over[k]) out[k] = over[k];
  if ((out.harness || nowParent) !== wasHarness) for (const k of ['model', 'effort']) if (!over[k]) delete out[k];
  return out;
}

/** The agent settings of the project file with the personal ones on top, field by field (and stage by stage). */
export function mergeAgent(base: Json | undefined, personal: Json | undefined): Json {
  const file = base || {};
  if (!personal) return file;
  const wasTop = file.harness || DEFAULT_HARNESS;
  const top = layer(file, personal, wasTop, DEFAULT_HARNESS);
  const nowTop = top.harness || DEFAULT_HARNESS;
  const stages: Json = { ...(file.stages || {}) };
  const names = new Set([...Object.keys(file.stages || {}), ...Object.keys(personal.stages || {})]);
  for (const st of names) {
    const was = (file.stages && file.stages[st]) || {};
    const over = (personal.stages && personal.stages[st]) || {};
    const merged = layer(was, over, was.harness || wasTop, nowTop);
    if (Object.keys(merged).length) stages[st] = merged;
  }
  const out: Json = { ...top };
  if (Object.keys(stages).length) out.stages = stages; else delete out.stages;
  return out;
}

export interface AgentSources {
  harness?: Source; model?: Source; effort?: Source;
  stages: Record<string, { harness?: Source; model?: Source; effort?: Source }>;
}

/** For every agent setting that is set, which layer it comes from. A setting that is not listed is the built-in default. */
export function agentSources(merged: Json, personal: Json | undefined): AgentSources {
  const src = (m: Json, p: Json | undefined) => Object.fromEntries(FIELDS.filter(k => m[k]).map(k => [k, p && p[k] ? 'personal' : 'project']));
  const out: AgentSources = { ...src(merged, personal), stages: {} };
  for (const [st, m] of Object.entries((merged.stages || {}) as Json)) out.stages[st] = src(m as Json, personal && personal.stages && personal.stages[st]);
  return out;
}
