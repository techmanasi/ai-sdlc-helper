import { describe, expect, test } from 'vitest';
import { handoffBlocks, MAX_NOTE, noteError, noteToSend } from '../web/ui/src/handoff.js';

describe('handoffBlocks', () => {
  test('the pipeline finding is its own line with its origin; the user note is separate', () => {
    const b = handoffBlocks({ handoff: { to: 'plan', finding: { from: 'Red tests', reason: 'RED GATE FAILED' }, user: { note: 'keep it small', at: 't' } } });
    expect(b.finding).toBe('From the pipeline (Red tests): RED GATE FAILED');
    expect(b.note).toBe('keep it small');
    expect(b.label('Plan')).toBe('Instruction for the Plan agent (optional)');
  });
  test('no handoff gives empty parts', () => {
    expect(handoffBlocks({ handoff: null })).toMatchObject({ finding: '', note: '' });
    expect(handoffBlocks({ handoff: { to: 'spec', user: { note: 'x', at: 't' } } }).finding).toBe('');
  });
});

describe('noteError', () => {
  test('empty and long-enough notes pass; one over the limit says how long it is', () => {
    expect(noteError('')).toBe('');
    expect(noteError(`  ${'x'.repeat(MAX_NOTE)}  `)).toBe('');
    expect(noteError('x'.repeat(MAX_NOTE + 1))).toBe(`${MAX_NOTE + 1} characters; at most ${MAX_NOTE}`);
  });
  test('noteToSend trims and drops an empty note', () => {
    expect(noteToSend('  hi ')).toBe('hi');
    expect(noteToSend('   ')).toBeUndefined();
  });
});
