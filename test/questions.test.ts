import { describe, expect, test } from 'vitest';
import { withAnswerLines } from '../src/pipeline/questions.js';

describe('withAnswerLines', () => {
  test('adds an empty Answer line to a block that lacks one', () => {
    const out = withAnswerLines('### Q1: A\nbody\n\n### Q2: B\nbody\n**Answer:**\n');
    expect(out.split('\n').filter(l => l === '**Answer:**')).toHaveLength(2);
    expect(out.indexOf('**Answer:**')).toBeLessThan(out.indexOf('### Q2'));
  });

  test('keeps existing answers untouched', () => {
    const text = '### Q1: A\nbody\n**Answer:** yes\n\n### Q2: B\n**Answer:** no\n';
    expect(withAnswerLines(text)).toBe(text);
  });

  test('is idempotent', () => {
    const once = withAnswerLines('### Q1: A\nbody\n\n### Q2: B\n**Answer:** x\n');
    expect(withAnswerLines(once)).toBe(once);
  });

  test('preserves the text before the first question', () => {
    const out = withAnswerLines('# Questions\n\nintro\n\n### Q1: A\nbody\n');
    expect(out.startsWith('# Questions\n\nintro\n\n### Q1: A\n')).toBe(true);
    expect(out).toContain('**Answer:**');
  });

  test('returns the input unchanged when there are no questions', () => {
    const text = '# Questions\n\nnothing here\n';
    expect(withAnswerLines(text)).toBe(text);
  });
});
