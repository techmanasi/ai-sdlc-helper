import { describe, expect, it } from 'vitest';
import { filterModels, nextIndex } from '../web/ui/src/modelFilter.js';

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

  it('returns an empty list when no model matches', () => {
    expect(filterModels(models, 'not-a-model')).toEqual([]);
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
