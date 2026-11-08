import { describe, expect, it, vi } from 'vitest';
import { CodexModelCatalogAdapter, STATIC_CODEX_MODELS } from '../src/pipeline/harness/codex/catalog.js';
import { CodexHarness } from '../src/pipeline/harness/codex.js';
import { queryOpenAiApiModels } from '../src/pipeline/harness/codex/api.js';
import { queryCodexAppServerModels } from '../src/pipeline/harness/codex/rpc.js';
import type { HarnessModel } from '../src/pipeline/harness/types.js';

describe('CodexModelCatalogAdapter', () => {
  const sampleRpcModels: HarnessModel[] = [
    { id: 'gpt-4o', name: 'OpenAI GPT-4o', harness: 'codex', supportsEffort: false },
    { id: 'o1', name: 'OpenAI o1', harness: 'codex', supportsEffort: true, defaultEffort: 'medium' },
  ];

  const sampleApiModels: HarnessModel[] = [
    { id: 'gpt-4o-mini', name: 'OpenAI gpt-4o-mini', harness: 'codex', supportsEffort: false },
  ];

  it('prefers app-server JSON-RPC when available and caches the result', async () => {
    const rpcFn = vi.fn().mockResolvedValue(sampleRpcModels);
    const apiFn = vi.fn().mockResolvedValue(sampleApiModels);

    const adapter = new CodexModelCatalogAdapter(rpcFn, apiFn);

    const models = await adapter.listModels();
    expect(rpcFn).toHaveBeenCalledTimes(1);
    expect(apiFn).not.toHaveBeenCalled();
    expect(models).toEqual(sampleRpcModels);
    expect(adapter.getCacheSource()).toBe('app-server');

    // Second call should use cache
    const modelsCached = await adapter.listModels();
    expect(rpcFn).toHaveBeenCalledTimes(1);
    expect(modelsCached).toEqual(sampleRpcModels);
  });

  it('falls back to OpenAI API when app-server fails or returns null', async () => {
    const rpcFn = vi.fn().mockResolvedValue(null);
    const apiFn = vi.fn().mockResolvedValue(sampleApiModels);

    const adapter = new CodexModelCatalogAdapter(rpcFn, apiFn);

    const models = await adapter.listModels();
    expect(rpcFn).toHaveBeenCalledTimes(1);
    expect(apiFn).toHaveBeenCalledTimes(1);
    expect(models).toEqual(sampleApiModels);
    expect(adapter.getCacheSource()).toBe('api');
  });

  it('falls back to static defaults when both app-server and API query fail', async () => {
    const rpcFn = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const apiFn = vi.fn().mockRejectedValue(new Error('Network error'));

    const adapter = new CodexModelCatalogAdapter(rpcFn, apiFn);

    const models = await adapter.listModels();
    expect(models).toEqual(STATIC_CODEX_MODELS);
    expect(adapter.getCacheSource()).toBe('fallback');
  });

  it('invalidates cache on invalidateCache() and queries again', async () => {
    const rpcFn = vi
      .fn()
      .mockResolvedValueOnce(sampleRpcModels)
      .mockResolvedValueOnce([
        { id: 'gpt-4o', name: 'OpenAI GPT-4o', harness: 'codex', supportsEffort: false },
      ]);

    const adapter = new CodexModelCatalogAdapter(rpcFn, vi.fn().mockResolvedValue(null));

    const first = await adapter.listModels();
    expect(first).toHaveLength(2);
    expect(rpcFn).toHaveBeenCalledTimes(1);

    adapter.invalidateCache();
    expect(adapter.getCacheSource()).toBeNull();

    const second = await adapter.listModels();
    expect(second).toHaveLength(1);
    expect(rpcFn).toHaveBeenCalledTimes(2);
  });

  it('validates whether a model id is in the catalog', async () => {
    const adapter = new CodexModelCatalogAdapter(
      vi.fn().mockResolvedValue(sampleRpcModels),
      vi.fn().mockResolvedValue(null),
    );

    expect(await adapter.validateModel('gpt-4o')).toBe(true);
    expect(await adapter.validateModel('o1')).toBe(true);
    expect(await adapter.validateModel('non-existent-model')).toBe(false);
  });

  it('provides the default model from the catalog', async () => {
    const adapter = new CodexModelCatalogAdapter(
      vi.fn().mockResolvedValue(sampleRpcModels),
      vi.fn().mockResolvedValue(null),
    );

    expect(await adapter.getDefaultModel()).toBe('gpt-4o');
  });

  it('plugs seamlessly into CodexHarness', async () => {
    const adapter = new CodexModelCatalogAdapter(
      vi.fn().mockResolvedValue(sampleRpcModels),
      vi.fn().mockResolvedValue(null),
    );
    const harness = new CodexHarness(adapter);

    expect(harness.catalog).toBe(adapter);
    expect(await harness.listModels()).toEqual(sampleRpcModels);
  });

  it('queries OpenAI API models when token is available', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'gpt-4o' },
          { id: 'o3-mini' },
          { id: 'text-embedding-3-small' }, // Should be filtered out
        ],
      }),
    });

    const models = await queryOpenAiApiModels(
      { OPENAI_API_KEY: 'test-key' } as unknown as NodeJS.ProcessEnv,
      fakeFetch as unknown as typeof fetch,
    );

    expect(fakeFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
    );
    expect(models?.map((m) => m.id)).toEqual(['gpt-4o', 'o3-mini']);
  });

  it('returns null from queryOpenAiApiModels when no API key is in environment', async () => {
    const models = await queryOpenAiApiModels({} as NodeJS.ProcessEnv);
    expect(models).toBeNull();
  });

  it('gracefully handles missing codex binary in queryCodexAppServerModels', async () => {
    const models = await queryCodexAppServerModels({
      binaryPath: '/nonexistent/path/to/codex-binary',
      timeoutMs: 500,
    });
    expect(models).toBeNull();
  });
});
