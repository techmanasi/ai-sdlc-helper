// Model and effort per stage, and the provider a "<provider>/<model>" name runs through: the user-level model registry
// first, then the SDLC_PROVIDER* variables (shell, then the project's .env).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { has } from '../util.js';
import { loadRegistry, resolvePath } from '../models/index.js';
import { EFFORT_LEVELS, agentFor } from '../config/settings.js';
import { AGENT_STAGES, SetupError, type AgentStage, type Ctx } from './context.js';

/** The default "<model> <effort>" of each stage; MODEL_<STAGE>, EFFORT_<STAGE>, SDLC_MODEL and SDLC_EFFORT override it. */
export const STAGE_DEFAULTS: Record<AgentStage, { model: string; effort: string }> = {
  spec: { model: 'opus', effort: 'medium' },
  plan: { model: 'opus', effort: 'medium' },
  'red-tests': { model: 'sonnet', effort: 'medium' },
  implement: { model: 'sonnet', effort: 'medium' },
  'test-repair': { model: 'sonnet', effort: 'medium' },
  // a different model from Test repair, so the audit is independent
  'test-audit': { model: 'opus', effort: 'medium' },
  review: { model: 'opus', effort: 'medium' },
};
export const EFFORTS: string[] = [...EFFORT_LEVELS];

/**
 * The SDLC_PROVIDER* keys of <root>/.env (quotes stripped) that the environment does not set. Only those keys are read;
 * the rest of .env never is.
 */
export function envModels(root: string, env: NodeJS.ProcessEnv): Record<string, string> {
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return {}; }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!/^SDLC_PROVIDER[^=]*=/.test(line)) continue;
    const k = line.slice(0, line.indexOf('='));
    if (!/^[A-Z0-9_]+$/.test(k)) continue;
    const v = line.slice(k.length + 1).replace(/^"|"$/g, '').replace(/^'|'$/g, '');
    if (!env[k]) out[k] = v;
  }
  return out;
}

/** The registry file the run reads (AI_SDLC_HELPER_MODELS_FILE, SDLC_MODELS_FILE, else the user-level models.json). */
export const registryFile = (env: NodeJS.ProcessEnv): string =>
  resolvePath({ env, platform: process.platform, home: env.HOME || os.homedir() }).read;

/** Fails when the registry file is broken, whatever models the stages use. */
export function registryCheck(file: string): void {
  try { loadRegistry(file); } catch (e) { throw new SetupError((e as Error).message); }
}

/** How a stage's model runs: through a custom provider (active) or Anthropic. */
export interface Provider {
  active: boolean;
  /** The name passed to --model. */
  model: string;
  endpoint: string;
  key: string;
  /** Whether --effort is passed. */
  effortFlag: boolean;
}

export interface ModelEnv {
  /** The shell environment. */
  env: NodeJS.ProcessEnv;
  /** SDLC_PROVIDER* keys from .env (see envModels). */
  fromFile?: Record<string, string>;
  registryFile: string;
  /** The project's model and effort for a stage (sdlc.config.json), below MODEL_<STAGE> and above SDLC_MODEL. */
  project?: (stage: AgentStage) => { model?: string; effort?: string };
  /** --model and --effort of the run: they win over everything, for every stage. */
  force?: { model?: string; effort?: string };
}

const provKey = (p: string) => p.toUpperCase().replace(/-/g, '_');

/**
 * The provider of <spec> for <stage>. A model without "/" is an Anthropic model. Throws SetupError on an unknown
 * provider, a missing endpoint or key, or a model the provider does not list.
 */
export function resolveProvider(spec: string, stage: string, { env, fromFile = {}, registryFile: file }: ModelEnv): Provider {
  if (!spec.includes('/')) return { active: false, model: spec, endpoint: '', key: '', effortFlag: true };
  const p = spec.slice(0, spec.indexOf('/'));
  const m = spec.slice(p.length + 1);
  let registry;
  try { registry = loadRegistry(file); } catch (e) { throw new SetupError(`ERROR: model registry: ${(e as Error).message}`); }
  if (has(registry.providers, p)) {
    const r = registry.providers[p];
    if (m.includes(',') || !r.models.includes(m)) {
      throw new SetupError(`ERROR: model '${m}' (stage ${stage}) is not in the registry models of provider '${p}' (allowed: ${r.models.join(',')})`);
    }
    const key = env[r.api_key_env] || '';
    if (!key) {
      throw new SetupError(`ERROR: provider '${p}' (stage ${stage}): key variable ${r.api_key_env} is not set in the environment (export it; .env is not read for a registry provider)`);
    }
    return { active: true, model: m, endpoint: r.endpoint, key, effortFlag: r.effort === true };
  }
  const value = (k: string) => env[k] || fromFile[k] || '';
  const known = value('SDLC_PROVIDERS').split(',').map(x => x.replace(/ /g, '')).includes(p);
  if (!known) throw new SetupError(`ERROR: model '${spec}' (stage ${stage}): provider '${p}' is not listed in SDLC_PROVIDERS (see .env.example)`);
  const K = provKey(p);
  const ep = value(`SDLC_PROVIDER_${K}_ENDPOINT`);
  const key = value(`SDLC_PROVIDER_${K}_API_KEY`);
  const models = value(`SDLC_PROVIDER_${K}_MODELS`);
  if (!ep || !key) throw new SetupError(`ERROR: provider '${p}' (stage ${stage}) needs SDLC_PROVIDER_${K}_ENDPOINT and SDLC_PROVIDER_${K}_API_KEY`);
  if (!`,${models.replace(/ /g, '')},`.includes(`,${m},`)) {
    throw new SetupError(`ERROR: model '${m}' (stage ${stage}) is not in SDLC_PROVIDER_${K}_MODELS (allowed: ${models || 'none'})`);
  }
  return { active: true, model: m, endpoint: ep, key, effortFlag: value(`SDLC_PROVIDER_${K}_EFFORT`) === 'yes' };
}

export interface StageModel { model: string; effort: string; provider: Provider }

/**
 * The model and effort of <stage>, and its provider. Highest first: the run's --model / --effort, MODEL_<STAGE> /
 * EFFORT_<STAGE>, the project's setting, SDLC_MODEL / SDLC_EFFORT, the stage default.
 */
export function stageModel(stage: AgentStage, menv: ModelEnv): StageModel {
  const up = stage.toUpperCase().replace(/-/g, '_');
  const def = STAGE_DEFAULTS[stage];
  const proj = menv.project ? menv.project(stage) : {};
  const model = menv.force?.model || menv.env[`MODEL_${up}`] || proj.model || menv.env.SDLC_MODEL || def.model;
  const effort = menv.force?.effort || menv.env[`EFFORT_${up}`] || proj.effort || menv.env.SDLC_EFFORT || def.effort;
  if (!EFFORTS.includes(effort)) throw new SetupError(`ERROR: invalid effort '${effort}' for stage ${stage} (use low, medium, high, xhigh or max)`);
  return { model, effort, provider: resolveProvider(model, stage, menv) };
}

/** The model settings of a run: its environment, the project's settings and the run's --model / --effort. */
export const modelEnvOf = (ctx: Ctx): ModelEnv => ({
  env: ctx.env, fromFile: ctx.envModels, registryFile: ctx.registryFile,
  project: st => agentFor(ctx.config, st), force: ctx.force,
});

/** Every stage's model and effort, for status.json; a bad value fails the run at the start. */
export function stageModels(menv: ModelEnv): Record<string, { model: string; effort: string }> {
  registryCheck(menv.registryFile);
  const out: Record<string, { model: string; effort: string }> = {};
  for (const st of AGENT_STAGES) { const { model, effort } = stageModel(st, menv); out[st] = { model, effort }; }
  return out;
}

/** The claude flags for a stage's model. */
export const modelFlags = ({ effort, provider }: StageModel): string[] =>
  ['--model', provider.model, ...(provider.effortFlag ? ['--effort', effort] : [])];

/**
 * The environment the agent of a custom provider runs with: its endpoint and key, with ANTHROPIC_API_KEY emptied so a real
 * Anthropic key is never sent to a third-party endpoint. Only the agent's process gets it.
 */
export const providerEnv = (p: Provider): Record<string, string> => (p.active ? {
  ANTHROPIC_BASE_URL: p.endpoint, ANTHROPIC_AUTH_TOKEN: p.key, ANTHROPIC_API_KEY: '',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: p.model, ANTHROPIC_SMALL_FAST_MODEL: p.model,
} : {});
