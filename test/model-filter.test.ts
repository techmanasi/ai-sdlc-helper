import { describe, expect, it } from 'vitest';
import { filterModels } from '../web/ui/src/modelFilter.js';

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
