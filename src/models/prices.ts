// What a model's tokens cost, so a round whose agent reports tokens but no cost (codex, agy, a custom agent) still gets a
// dollar figure. The prices come from OpenCode's model list (`opencode api get /api/model`), which carries a price per
// million tokens for every model it knows, from every provider; without OpenCode there is no table and rounds show tokens.

import { which } from '../shell.js';
import { queryOpencodeApi } from '../pipeline/harness/opencode/catalog.js';

/** US dollars per million tokens. */
export interface Price { input: number; output: number; cacheRead: number; cacheWrite: number }
/** Prices by `provider/model` (as OpenCode names them) and by the bare model id. */
export type PriceTable = Map<string, Price>;

/** The token split of a round, as the round rows hold it. */
export interface TokenSplit { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Providers that sell their own models, tried first for a bare model id; resellers last. */
const FIRST_PARTY = ['openai', 'anthropic', 'google', 'deepseek', 'xai', 'mistral', 'zai', 'moonshotai'];
const rank = (provider: string): number => {
  const i = FIRST_PARTY.indexOf(provider);
  if (i >= 0) return i;
  return provider === 'openrouter' ? 1000 : 100;
};

/**
 * The price table from OpenCode's model list: the payload of `/api/model` (an array, or `{ data: [...] }`). A model with
 * several price tiers takes its base tier (the one without a context `tier`). A bare id (`gpt-6.1-terra`, or the last
 * part of `openai/gpt-6.1-terra`) maps to the first-party provider's price when several providers sell it.
 */
export function pricesFromOpencode(payload: unknown): PriceTable {
  const list = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : [];
  const table: PriceTable = new Map();
  const bare = new Map<string, { price: Price; rank: number }>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const m = item as { providerID?: unknown; modelID?: unknown; cost?: unknown };
    const provider = typeof m.providerID === 'string' ? m.providerID : '';
    const model = typeof m.modelID === 'string' ? m.modelID : '';
    if (!provider || !model) continue;
    const tiers = Array.isArray(m.cost) ? m.cost : m.cost && typeof m.cost === 'object' ? [m.cost] : [];
    const base = tiers.find(t => t && typeof t === 'object' && !(t as { tier?: unknown }).tier) as Record<string, unknown> | undefined;
    if (!base) continue;
    const input = num(base.input);
    const output = num(base.output);
    if (input === null || output === null) continue;
    const cache = base.cache && typeof base.cache === 'object' ? base.cache as Record<string, unknown> : {};
    const price: Price = { input, output, cacheRead: num(cache.read) ?? input, cacheWrite: num(cache.write) ?? input };
    table.set(`${provider}/${model}`, price);
    const id = model.split('/').pop() as string;
    const r = rank(provider);
    const had = bare.get(id);
    if (!had || r < had.rank) bare.set(id, { price, rank: r });
  }
  for (const [id, { price }] of bare) if (!table.has(id)) table.set(id, price);
  return table;
}

/**
 * The price of the model a round ran with: the exact `provider/model` first, then the bare id. Claude Code's short names
 * (`sonnet-5.5`) and dotted versions (`claude-sonnet-5.5`) are also tried as OpenCode spells them (`claude-sonnet-5-5`).
 * Null when the model is unknown.
 */
export function priceOf(model: string | null | undefined, table: PriceTable): Price | null {
  if (!model || !table.size) return null;
  const id = model.trim();
  const last = id.split('/').pop() as string;
  const tries = [id, last];
  for (const name of [last, `claude-${last}`]) tries.push(name.replace(/(\d)\.(\d)/g, '$1-$2'));
  for (const t of tries) {
    const p = table.get(t);
    if (p) return p;
  }
  return null;
}

/** True when every rate is zero: a free model, whose rounds show tokens only. */
export const isFree = (p: Price): boolean => p.input === 0 && p.output === 0 && p.cacheRead === 0 && p.cacheWrite === 0;

/**
 * What a round's tokens cost at <price>, in dollars; null when the round reported no token split. Harnesses count the
 * cache two ways: OpenAI's input includes the cached tokens, Anthropic's does not. A cache read no larger than the input
 * is taken as part of it (OpenAI); a larger one cannot be, so it is counted on top (Anthropic).
 */
export function estimateUsd(t: TokenSplit, price: Price): number | null {
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  const cacheRead = t.cacheRead ?? 0;
  const cacheWrite = t.cacheWrite ?? 0;
  if (!input && !output && !cacheRead && !cacheWrite) return null;
  const fresh = cacheRead <= input ? input - cacheRead : input;
  return (fresh * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1e6;
}

let current: PriceTable = new Map();
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** The table loaded last; empty until `loadPrices` has finished once (or when OpenCode is not installed). */
export const pricesNow = (): PriceTable => current;

/**
 * Load the table from OpenCode once, and again when it is older than <maxAgeMs>. A missing OpenCode leaves the table
 * empty and is not an error; a failing one throws so the caller can show it.
 */
export async function loadPrices(query: () => Promise<unknown>, opts: { maxAgeMs?: number; now?: number } = {}): Promise<PriceTable> {
  const now = opts.now ?? Date.now();
  if (loadedAt && now - loadedAt < (opts.maxAgeMs ?? 6 * 3600_000)) return current;
  if (!loading) {
    loading = (async () => {
      try {
        current = pricesFromOpencode(await query());
        loadedAt = now;
      } finally {
        loading = null;
      }
    })();
  }
  await loading;
  return current;
}

/** Forget the loaded table (tests). */
export function resetPrices(table: PriceTable = new Map()): void {
  current = table;
  loadedAt = 0;
  loading = null;
}

/**
 * Load the table from the OpenCode on this machine (the UI server does this at start and every few hours). Resolves to
 * the table; empty, and no error, when OpenCode is not installed.
 */
export async function loadOpencodePrices(env: NodeJS.ProcessEnv = process.env, opts: { maxAgeMs?: number } = {}): Promise<PriceTable> {
  if (!env.OPENCODE && !which('opencode', { env })) return current;
  return loadPrices(() => queryOpencodeApi(env, '/api/model'), opts);
}
