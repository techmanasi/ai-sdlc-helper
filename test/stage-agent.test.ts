import { describe, it, expect } from 'vitest';
import { agentChanged, defaultChoiceLabel, pickProblem } from '../web/ui/src/stageAgent';

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
