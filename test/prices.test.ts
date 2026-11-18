import { afterEach, describe, expect, test } from 'vitest';
import { estimateUsd, isFree, loadPrices, priceOf, pricesFromOpencode, pricesNow, resetPrices } from '../src/models/prices.js';
import { runTimeline } from '../src/runs/timeline.js';

// The shape `opencode api get /api/model` returns: a price per million tokens, and a dearer tier past a context size.
const PAYLOAD = {
  data: [
    { providerID: 'openrouter', modelID: 'openai/gpt-6.1-terra', cost: [{ input: 9, output: 9, cache: { read: 9, write: 9 } }] },
    { providerID: 'openai', modelID: 'gpt-6.1-terra', cost: [{ input: 1, output: 5, cache: { read: 0.05, write: 1.25 } }, { tier: { type: 'context', size: 272000 }, input: 2, output: 7.5, cache: { read: 0.1, write: 2.5 } }] },
    { providerID: 'opencode', modelID: 'claude-sonnet-5-5', cost: [{ input: 2, output: 10, cache: { read: 0.1, write: 2.5 } }] },
    { providerID: 'opencode', modelID: 'deepseek-v4.1-flash-free', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] },
    { providerID: 'opencode', modelID: 'no-price' },
  ],
};

afterEach(() => resetPrices());

describe('model prices', () => {
  test('reads base-tier prices by provider/model and by bare id, preferring the first-party provider', () => {
    const t = pricesFromOpencode(PAYLOAD);
    expect(t.get('openai/gpt-6.1-terra')).toEqual({ input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 });
    expect(priceOf('gpt-6.1-terra', t)).toEqual({ input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 });
    expect(priceOf('openrouter/openai/gpt-6.1-terra', t)?.input).toBe(9);
    expect(priceOf('no-price', t)).toBeNull();
    expect(priceOf('', t)).toBeNull();
    expect(pricesFromOpencode('junk').size).toBe(0);
  });

  test("finds Claude Code's short and dotted model names", () => {
    const t = pricesFromOpencode(PAYLOAD);
    expect(priceOf('sonnet-5.5', t)?.output).toBe(10);
    expect(priceOf('claude-sonnet-5.5', t)?.output).toBe(10);
  });

  test('a free model costs nothing', () => {
    const p = priceOf('opencode/deepseek-v4.1-flash-free', pricesFromOpencode(PAYLOAD))!;
    expect(isFree(p)).toBe(true);
    expect(estimateUsd({ input: 5000, output: 100, cacheRead: null, cacheWrite: null }, p)).toBe(0);
  });

  test('cached tokens inside the input (OpenAI) are priced at the cache rate, not twice', () => {
    const p = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 };
    // 1M input of which 600k cached, 100k output: 400k×1 + 600k×0.1 + 100k×5 per million.
    expect(estimateUsd({ input: 1_000_000, output: 100_000, cacheRead: 600_000, cacheWrite: null }, p)).toBeCloseTo(0.4 + 0.06 + 0.5);
    // A cache read larger than the input is on top of it (Anthropic).
    expect(estimateUsd({ input: 1000, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, p)).toBeCloseTo(0.001 + 0.1);
    expect(estimateUsd({ input: null, output: null, cacheRead: null, cacheWrite: null }, p)).toBeNull();
  });

  test('loads once, keeps the table, and loads again when it is old', async () => {
    let calls = 0;
    const query = async () => { calls++; return PAYLOAD; };
    expect(pricesNow().size).toBe(0);
    await loadPrices(query, { now: 1000 });
    await loadPrices(query, { now: 2000, maxAgeMs: 10_000 });
    expect(calls).toBe(1);
    expect(pricesNow().has('gpt-6.1-terra')).toBe(true);
    await loadPrices(query, { now: 20_000, maxAgeMs: 10_000 });
    expect(calls).toBe(2);
  });

  test('a failing load throws and leaves the table as it was', async () => {
    await expect(loadPrices(async () => { throw new Error('opencode broke'); })).rejects.toThrow('opencode broke');
    expect(pricesNow().size).toBe(0);
  });
});

describe('the timeline prices rounds that report tokens but no cost', () => {
  const t = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}`;
  const table = pricesFromOpencode(PAYLOAD);
  const round = (at: number, model: string, usage: Record<string, unknown> | undefined, tokens = 0) =>
    ({ kind: 'agent', at: t(at), stage: 'implement', agent: 'implement', durationSec: 1, turns: 1, tokens, model, ...(usage ? { usage } : {}) });

  test('a codex round is estimated at its model price; a reported cost is kept as it is', () => {
    const tl = runTimeline([
      { kind: 'stage', at: t(0), stage: 'Implement' },
      round(1, 'gpt-6.1-terra', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: null, costUsd: null }, 1_000_000),
      round(2, 'sonnet-5.5', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 }, 15),
    ], undefined, table);
    expect(tl.stages[0].usage).toMatchObject({ costUsd: 1.25, estimatedUsd: 1, unpriced: 0 });
    expect(tl.usage).toMatchObject({ costUsd: 1.25, estimatedUsd: 1, unpriced: 0 });
  });

  test('a free model costs 0, an unknown model is counted as unpriced, a round with only a total is priced as input', () => {
    const tl = runTimeline([
      { kind: 'stage', at: t(0), stage: 'Implement' },
      round(1, 'opencode/deepseek-v4.1-flash-free', { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: null }, 550),
      round(2, 'mystery-model', { input: 500, output: 50, cacheRead: null, cacheWrite: null, costUsd: null }, 550),
      round(3, 'gpt-6.1-terra', undefined, 1_000_000),
    ], undefined, table);
    expect(tl.usage).toMatchObject({ costUsd: 1, estimatedUsd: 1, unpriced: 1 });
  });

  test('without a price table nothing is estimated', () => {
    const tl = runTimeline([{ kind: 'stage', at: t(0), stage: 'Implement' }, round(1, 'gpt-6.1-terra', { input: 10, output: 5, cacheRead: null, cacheWrite: null, costUsd: null }, 15)]);
    expect(tl.usage).toMatchObject({ costUsd: null, estimatedUsd: 0, unpriced: 1 });
  });
});
