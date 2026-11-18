import { describe, expect, test } from 'vitest';
import { discardableStage } from '../src/runs/discardable.js';

describe('the stage a stage discard may take back', () => {
  test('a stopped run: the stage it is at, whatever its state', () => {
    expect(discardableStage({ state: 'failed', stage: 'Red tests' }, { Spec: [], Plan: [], 'Red tests': [] })).toBe('Red tests');
    expect(discardableStage({ state: 'paused', stage: 'Plan' }, null)).toBe('Plan');
    expect(discardableStage({ state: 'done', stage: 'Review' }, {})).toBe('Review');
  });
  test('a ready run: the latest stage before the discarded one that still has work', () => {
    expect(discardableStage({ state: 'ready', stage: 'Red tests' }, { Spec: ['a'], Plan: ['b'] })).toBe('Plan');
    expect(discardableStage({ state: 'ready', stage: 'Implement' }, { Spec: ['a'], 'Red tests': ['t'] })).toBe('Red tests');
    expect(discardableStage({ state: 'ready', stage: 'Plan' }, { Spec: ['a'], Implement: ['x'] })).toBe('Spec'); // never a later stage
    expect(discardableStage({ state: 'ready', stage: 'Spec' }, { Spec: ['a'] })).toBe('');
    expect(discardableStage({ state: 'ready', stage: 'Plan' }, null)).toBe('');
  });
});
