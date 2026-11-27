import { describe, it, expect } from 'vitest';
import { agentChanged, defaultChoiceLabel, filterModels, pickProblem } from '../web/ui/src/stageAgent.js';

const catalog = {
  agy: [{ id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)', supportsEffort: false, supportedEfforts: [] }],
  codex: [{ id: 'gpt-5', name: 'GPT-5', supportsEffort: true, supportedEfforts: ['low', 'high'] }],
  claude: [{ id: 'opus', name: 'Opus', supportsEffort: true }],
};

describe('stage agent change', () => {
  it('detects an agent that differs from the recorded one', () => {
    expect(agentChanged('claude', 'agy')).toBe(true);
    expect(agentChanged('agy', 'agy')).toBe(false);
    expect(agentChanged('', 'agy')).toBe(false);
  });
  it('drops the old agent value from the default label after a change', () => {
    expect(defaultChoiceLabel('gemini-3.8-flash-medium', true)).toBe('default');
    expect(defaultChoiceLabel('gemini-3.8-flash-medium', false)).toBe('default (gemini-3.8-flash-medium)');
  });
  it('blocks a model or effort the agent does not offer', () => {
    const owns = (a: string) => a !== 'claude';
    expect(pickProblem('Implement', { agent: 'claude', model: 'gemini-3.8-flash-medium' }, catalog, owns)).toBe('');
    expect(pickProblem('Implement', { agent: 'codex', model: 'gemini-3.8-flash-medium' }, catalog, owns)).toContain('not offered by codex');
    expect(pickProblem('Implement', { agent: 'codex', model: 'gpt-5', effort: 'max' }, catalog, owns)).toContain('effort max');
    expect(pickProblem('Implement', { agent: 'codex', model: 'gpt-5', effort: 'low' }, catalog, owns)).toBe('');
    expect(pickProblem('Implement', { agent: 'codex' }, catalog, owns)).toBe('');
  });
});

const models = [
  { id: 'claude/opus-4-6', name: 'Opus 4.6', displayName: 'opus', providerId: 'anthropic', providerName: 'Anthropic' },
  { id: 'claude/sonnet-4-6', name: 'Sonnet 4.6', displayName: 'sonnet', providerId: 'anthropic', providerName: 'Anthropic' },
  { id: 'opencode-go/kimi-k3.1-pro', name: 'Kimi K3.1 Pro', providerId: 'openrouter', providerName: 'OpenRouter' },
];

describe('model listbox filter', () => {
  it('keeps every model for an empty query', () => {
    const groups = filterModels(models, '   ');
    expect(groups.flatMap(g => g.models)).toEqual(models);
    expect(filterModels([{ id: 'gpt-5', name: 'GPT-5' }], '').map(g => g.name)).toEqual(['Models']);
  });
  it('matches ids, names and providers without regard to case or surrounding spaces', () => {
    const flat = (q: string) => filterModels(models, q).flatMap(g => g.models);
    expect(flat(' KIMI ').map(m => m.id)).toEqual(['opencode-go/kimi-k3.1-pro']);
    expect(flat('OPUS').map(m => m.id)).toEqual(['claude/opus-4-6']);
    expect(flat('openrouter').map(m => m.id)).toEqual(['opencode-go/kimi-k3.1-pro']);
  });
  it('groups matches by provider or harness when the catalog carries one', () => {
    const groups = filterModels(models, '');
    expect(groups.map(g => g.name)).toEqual(['Anthropic', 'OpenRouter']);
    expect(groups.map(g => g.models.length)).toEqual([2, 1]);
    expect(filterModels([{ id: 'gpt-5', name: 'GPT-5', harness: 'codex' }], '').map(g => g.name)).toEqual(['codex']);
  });
  it('returns no groups when nothing matches', () => {
    expect(filterModels(models, 'no-such-model')).toEqual([]);
  });
});
