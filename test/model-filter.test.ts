import { describe, expect, it } from 'vitest';
import { configValue, filterModels, nextIndex } from '../web/ui/src/modelFilter.js';

const models = [
  { id: 'opencode/claude-fable-5-2', name: 'Claude Fable 5.2' },
  { id: 'opencode-go/kimi-k3.1-pro', name: 'Kimi K3.1 Pro' },
  { id: 'opencode-go/gemini-3.1-pro', name: 'Gemini 3.1 Pro Preview' },
];

describe('filterModels', () => {
  it('returns the full list for an empty or whitespace query', () => {
    expect(filterModels(models, '')).toEqual(models);
    expect(filterModels(models, '   ')).toEqual(models);
  });

  it('matches id and name substrings case-insensitively and trims the query', () => {
    expect(filterModels(models, ' FABLE ').map(model => model.id)).toEqual(['opencode/claude-fable-5-2']);
    expect(filterModels(models, 'KIMI').map(model => model.id)).toEqual(['opencode-go/kimi-k3.1-pro']);
    expect(filterModels(models, 'preview').map(model => model.id)).toEqual(['opencode-go/gemini-3.1-pro']);
    expect(filterModels(models, 'OPENCODE-GO')).toHaveLength(2);
  });

  it('matches a provider display name and a provider label too', () => {
    const routed = [
      { id: 'openrouter/openai/gpt-6.2-sol-pro', name: 'GPT-6.2 Sol Pro', displayName: 'openai/gpt-6.2-sol-pro', providerName: 'openrouter' },
      { id: 'opencode/gpt-6.2-sol', name: 'GPT-6.2 Sol', displayName: 'gpt-6.2-sol', providerName: 'opencode' },
    ];
    expect(filterModels(routed, 'openai/gpt-6.2-sol-pro').map(model => model.id)).toEqual(['openrouter/openai/gpt-6.2-sol-pro']);
    expect(filterModels(routed, 'openrouter').map(model => model.id)).toEqual(['openrouter/openai/gpt-6.2-sol-pro']);
  });

  it('returns an empty list when no model matches', () => {
    expect(filterModels(models, 'not-a-model')).toEqual([]);
  });
});

describe('configValue', () => {
  it('names a model by its display name when it is unique in the catalog', () => {
    const routed = [
      { id: 'openrouter/openai/gpt-6.2-sol-pro', displayName: 'openai/gpt-6.2-sol-pro' },
      { id: 'opencode/gpt-6.2-sol', displayName: 'gpt-6.2-sol' },
    ];
    expect(configValue(routed[0], routed)).toBe('openai/gpt-6.2-sol-pro');
    expect(configValue(routed[1], routed)).toBe('gpt-6.2-sol');
  });

  it('falls back to the provider-routed id when providers share the display name', () => {
    const routed = [
      { id: 'opencode/kimi-k3', displayName: 'kimi-k3' },
      { id: 'opencode-go/kimi-k3', displayName: 'kimi-k3' },
    ];
    expect(configValue(routed[0], routed)).toBe('opencode/kimi-k3');
    expect(configValue(routed[1], routed)).toBe('opencode-go/kimi-k3');
  });

  it('uses the id when the model has no display name', () => {
    expect(configValue(models[0], models)).toBe('opencode/claude-fable-5-2');
  });
});

describe('nextIndex', () => {
  it('moves by one and wraps at both ends', () => {
    expect(nextIndex(0, 1, 3)).toBe(1);
    expect(nextIndex(2, 1, 3)).toBe(0);
    expect(nextIndex(0, -1, 3)).toBe(2);
  });

  it('stays at zero for an empty list', () => {
    expect(nextIndex(0, 1, 0)).toBe(0);
    expect(nextIndex(4, -1, 0)).toBe(0);
  });
});
