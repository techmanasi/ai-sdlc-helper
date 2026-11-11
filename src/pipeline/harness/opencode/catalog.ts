import { execFile } from 'node:child_process';
import { EFFORT_LEVELS } from '../../../config/settings.js';
import { which } from '../../../shell.js';
import type { HarnessModel, ModelCatalogAdapter } from '../types.js';

const CONSOLE_PROVIDERS = new Set(['opencode', 'opencode-go']);
const MODEL_LIST_PATH = '/api/model';
const DEFAULT_MODEL_PATH = '/api/model/default';

type Effort = NonNullable<HarnessModel['defaultEffort']>;

interface OpencodeModelItem {
  modelID?: string;
  providerID?: string;
  name?: string;
  family?: string;
  capabilities?: { tools?: boolean };
  variants?: Array<{
    settings?: { reasoning?: { effort?: string } };
  }>;
}

/** Query an OpenCode API endpoint. Injectable at the catalog seam for tests and fake binaries. */
export type OpencodeListFn = (env: NodeJS.ProcessEnv, endpoint?: string) => Promise<unknown>;

/** Run `opencode api get <endpoint>` and parse its JSON response. */
export function queryOpencodeApi(
  env: NodeJS.ProcessEnv = process.env,
  endpoint = MODEL_LIST_PATH,
): Promise<unknown> {
  const binary = env.OPENCODE || which('opencode', { env }) || 'opencode';
  return new Promise((resolve, reject) => {
    execFile(binary, ['api', 'get', endpoint], {
      env,
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 32 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`OpenCode returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}

function responseData(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: unknown }).data;
  }
  throw new Error('OpenCode model response did not contain data');
}

function canonicalModelId(item: OpencodeModelItem): string | undefined {
  if (!item.modelID || !item.providerID) return undefined;
  return item.modelID.includes('/') ? item.modelID : `${item.providerID}/${item.modelID}`;
}

function supportedEfforts(item: OpencodeModelItem): Effort[] {
  if (!Array.isArray(item.variants)) return [];
  return item.variants
    .map(variant => variant?.settings?.reasoning?.effort)
    .filter((effort): effort is Effort => typeof effort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(effort));
}

/** Map the `/api/model` envelope to the dynamic OpenCode Console model catalog. */
export function opencodeModelsFromPayload(payload: unknown): HarnessModel[] {
  const data = responseData(payload);
  if (!Array.isArray(data)) throw new Error('OpenCode model response data was not an array');
  const models: HarnessModel[] = [];
  for (const value of data) {
    if (!value || typeof value !== 'object') continue;
    const item = value as OpencodeModelItem;
    if (!item.providerID || !CONSOLE_PROVIDERS.has(item.providerID)) continue;
    const id = canonicalModelId(item);
    if (!id) continue;
    const efforts = supportedEfforts(item);
    models.push({
      id,
      name: item.name || id,
      harness: 'opencode',
      supportsEffort: efforts.length > 0,
      defaultEffort: efforts[0],
      description: item.family || (item.capabilities?.tools ? 'Tool-capable OpenCode model' : undefined),
    });
  }
  return models;
}

interface CatalogCache {
  models: HarnessModel[];
  expiresAt: number;
  source: 'api' | 'fallback';
}

export class OpencodeModelCatalogAdapter implements ModelCatalogAdapter {
  readonly harnessId = 'opencode' as const;

  private cache: CatalogCache | null = null;
  private readonly defaultTtlMs = 60 * 60 * 1000;
  private readonly fallbackTtlMs = 10 * 1000;
  lastError: string | null = null;

  constructor(
    private readonly listFn: OpencodeListFn = queryOpencodeApi,
    private readonly fallback: HarnessModel[] = [],
  ) {}

  async listModels(env: NodeJS.ProcessEnv = process.env): Promise<HarnessModel[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.models;

    try {
      const models = opencodeModelsFromPayload(await this.listFn(env));
      this.lastError = null;
      this.cache = {
        models,
        expiresAt: now + (models.length > 0 ? this.defaultTtlMs : this.fallbackTtlMs),
        source: 'api',
      };
      return models;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.cache = {
        models: this.fallback,
        expiresAt: now + this.fallbackTtlMs,
        source: 'fallback',
      };
      return this.fallback;
    }
  }

  async getDefaultModel(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
    try {
      const payload = await this.listFn(env, DEFAULT_MODEL_PATH);
      const value = responseData(payload);
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') {
        const id = canonicalModelId(value as OpencodeModelItem);
        if (id) return id;
      }
    } catch {
      // An older OpenCode may not expose the default endpoint; use the first catalog entry.
    }
    const models = await this.listModels(env);
    return models[0]?.id;
  }

  async validateModel(modelId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (!modelId) return false;
    const models = await this.listModels(env);
    return models.some(model => model.id === modelId);
  }

  invalidateCache(): void {
    this.cache = null;
  }

  getCacheSource(): 'api' | 'fallback' | null {
    return this.cache?.source || null;
  }

  /** The last discovered model, for synchronous argument compilation after catalog discovery. */
  getCachedModel(modelId: string): HarnessModel | undefined {
    return this.cache?.models.find(model => model.id === modelId);
  }
}

export const defaultOpencodeCatalog = new OpencodeModelCatalogAdapter();
