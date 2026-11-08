import type { HarnessModel, ModelCatalogAdapter } from '../types.js';
import { queryCodexAppServerModels } from './rpc.js';
import { queryOpenAiApiModels } from './api.js';

export const STATIC_CODEX_MODELS: HarnessModel[] = [
  {
    id: 'gpt-4o',
    name: 'OpenAI GPT-4o',
    harness: 'codex',
    supportsEffort: false,
    description: 'High-throughput multimodal engineering model',
  },
  {
    id: 'o1',
    name: 'OpenAI o1',
    harness: 'codex',
    supportsEffort: true,
    defaultEffort: 'medium',
    description: 'Deep reasoning for complex planning and debugging',
  },
  {
    id: 'o3-mini',
    name: 'OpenAI o3-mini',
    harness: 'codex',
    supportsEffort: true,
    defaultEffort: 'high',
    description: 'Fast, high-reasoning coding model with configurable effort',
  },
];

interface CatalogCache {
  models: HarnessModel[];
  expiresAt: number;
  source: 'app-server' | 'api' | 'fallback';
}

export class CodexModelCatalogAdapter implements ModelCatalogAdapter {
  readonly harnessId = 'codex' as const;

  private cache: CatalogCache | null = null;
  private readonly defaultTtlMs = 60 * 60 * 1000; // 1 hour for authenticated catalogs
  private readonly fallbackTtlMs = 10 * 1000; // 10s for unauthenticated fallbacks

  constructor(
    private readonly queryRpc = queryCodexAppServerModels,
    private readonly queryApi = queryOpenAiApiModels,
  ) {}

  /**
   * Retrieves the supported model catalog for the Codex CLI.
   * Priority:
   * 1. Valid cached entry
   * 2. Live JSON-RPC query via `codex app-server` (supports active ChatGPT session & OAuth)
   * 3. Direct `/v1/models` API query if OPENAI_API_KEY is available
   * 4. Static fallback models
   */
  async listModels(env: NodeJS.ProcessEnv = process.env): Promise<HarnessModel[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.models;
    }

    // Method 1: Query local codex app-server JSON-RPC interface
    try {
      const rpcModels = await this.queryRpc({ env });
      if (rpcModels && rpcModels.length > 0) {
        this.cache = {
          models: rpcModels,
          expiresAt: now + this.defaultTtlMs,
          source: 'app-server',
        };
        return rpcModels;
      }
    } catch {
      /* fallback to method 2 */
    }

    // Method 2: Query Models Endpoint directly via API key if configured
    try {
      const apiModels = await this.queryApi(env);
      if (apiModels && apiModels.length > 0) {
        this.cache = {
          models: apiModels,
          expiresAt: now + this.defaultTtlMs,
          source: 'api',
        };
        return apiModels;
      }
    } catch {
      /* fallback to defaults */
    }

    // Fallback: Default safe models
    this.cache = {
      models: STATIC_CODEX_MODELS,
      expiresAt: now + this.fallbackTtlMs,
      source: 'fallback',
    };
    return STATIC_CODEX_MODELS;
  }

  async getDefaultModel(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
    const models = await this.listModels(env);
    return models[0]?.id;
  }

  async validateModel(modelId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (!modelId) return false;
    const models = await this.listModels(env);
    return models.some((m) => m.id === modelId);
  }

  /**
   * Invalidate the model cache immediately.
   * Must be called when Codex rejects a model execution (e.g. model not supported for ChatGPT account).
   */
  invalidateCache(): void {
    this.cache = null;
  }

  getCacheSource(): 'app-server' | 'api' | 'fallback' | null {
    return this.cache?.source || null;
  }
}

export const defaultCodexCatalog = new CodexModelCatalogAdapter();
