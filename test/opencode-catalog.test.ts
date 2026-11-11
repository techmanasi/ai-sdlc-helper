import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OpencodeModelCatalogAdapter } from '../src/pipeline/harness/opencode/catalog.js';
import { OpencodeHarness } from '../src/pipeline/harness/opencode.js';
import type { HarnessModel } from '../src/pipeline/harness/types.js';

const fixture = () => JSON.parse(fs.readFileSync(path.resolve('test/fixtures/opencode/model-list.json'), 'utf8'));

describe('OpencodeModelCatalogAdapter', () => {
  it('unwraps data, keeps both Console providers and composes canonical ids', async () => {
    const adapter = new OpencodeModelCatalogAdapter(async () => fixture());
    const models = await adapter.listModels();

    expect(models.map(model => model.id)).toEqual([
      'opencode/claude-fable-5-2',
      'opencode-go/kimi-k3.1-pro',
      'opencode-go/gemini-3.1-pro',
      'opencode/legacy-model',
    ]);
    expect(models.every(model => model.harness === 'opencode')).toBe(true);
    expect(models[0]).toMatchObject({
      name: 'Claude Fable 5.2',
      supportsEffort: true,
      defaultEffort: 'high',
      description: 'claude-fable',
    });
    expect(models[1]).toMatchObject({ supportsEffort: true, defaultEffort: 'medium' });
    expect(models[2]).toMatchObject({ supportsEffort: false, defaultEffort: undefined });
    expect(models.some(model => model.id.includes('openrouter') || model.id.includes('ollama'))).toBe(false);
  });

  it('caches a live result and reports its source', async () => {
    const listFn = vi.fn(async () => fixture());
    const adapter = new OpencodeModelCatalogAdapter(listFn);

    const first = await adapter.listModels();
    const second = await adapter.listModels();
    expect(second).toBe(first);
    expect(listFn).toHaveBeenCalledTimes(1);
    expect(adapter.getCacheSource()).toBe('api');
    expect(adapter.lastError).toBeNull();
  });

  it('invalidates the cache and queries again', async () => {
    const listFn = vi.fn(async () => fixture());
    const adapter = new OpencodeModelCatalogAdapter(listFn);
    await adapter.listModels();

    adapter.invalidateCache();
    expect(adapter.getCacheSource()).toBeNull();
    await adapter.listModels();
    expect(listFn).toHaveBeenCalledTimes(2);
  });

  it('returns the injected fallback and lastError on discovery failure', async () => {
    const fallback: HarnessModel[] = [
      { id: 'opencode/fallback', name: 'Fallback', harness: 'opencode', supportsEffort: false },
    ];
    const adapter = new OpencodeModelCatalogAdapter(async () => { throw new Error('not authenticated'); }, fallback);

    expect(await adapter.listModels()).toBe(fallback);
    expect(adapter.getCacheSource()).toBe('fallback');
    expect(adapter.lastError).toBe('not authenticated');
  });

  it('uses the default endpoint, then falls back to the first listed model', async () => {
    const listFn = vi.fn(async (_env: NodeJS.ProcessEnv, endpoint?: string) => {
      if (endpoint === '/api/model/default') return { data: fixture().data[1] };
      return fixture();
    });
    const adapter = new OpencodeModelCatalogAdapter(listFn);
    expect(await adapter.getDefaultModel()).toBe('opencode-go/kimi-k3.1-pro');
    expect(listFn).toHaveBeenCalledWith(process.env, '/api/model/default');

    const noDefault = new OpencodeModelCatalogAdapter(async () => { throw new Error('unknown endpoint'); });
    // A failing default and list query is graceful and has no invented default.
    expect(await noDefault.getDefaultModel()).toBeUndefined();

    const firstOnly = new OpencodeModelCatalogAdapter(async (_env, endpoint) => {
      if (endpoint) throw new Error('unknown endpoint');
      return fixture();
    });
    expect(await firstOnly.getDefaultModel()).toBe('opencode/claude-fable-5-2');
  });

  it('validates only ids in the filtered catalog', async () => {
    const adapter = new OpencodeModelCatalogAdapter(async () => fixture());
    expect(await adapter.validateModel('opencode/claude-fable-5-2')).toBe(true);
    expect(await adapter.validateModel('claude-fable-5-2')).toBe(false);
    expect(await adapter.validateModel('nex-agi/nex-n2.6')).toBe(false);
    expect(await adapter.validateModel('')).toBe(false);
  });

  it('plugs into the harness without exposing provider-specific catalog details', async () => {
    const adapter = new OpencodeModelCatalogAdapter(async () => fixture());
    const harness = new OpencodeHarness(adapter);
    expect(harness.catalog).toBe(adapter);
    expect((await harness.listModels()).map(model => model.id)).toContain('opencode-go/kimi-k3.1-pro');
  });
});
