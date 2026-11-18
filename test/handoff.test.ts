import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { consumeHandoff, readHandoff, takeHandoff, writeHandoff, writeUserNote } from '../src/pipeline/handoff.js';
import { tmp } from './helpers.js';

const ctx = () => ({ root: tmp('sdlc-handoff-'), log: 'work/items/x/logs' });
const raw = (c: { root: string; log: string }) => JSON.parse(fs.readFileSync(path.join(c.root, c.log, 'handoff.json'), 'utf8'));

describe('handoff', () => {
  test('a written finding is taken by a start at its stage, as one labelled block', () => {
    const c = ctx();
    writeHandoff(c, { to: 'plan', from: 'Red tests', reason: 'RED GATE FAILED: 1 new test(s) already pass' });
    const h = takeHandoff(c, 'plan');
    expect(h).toMatchObject({ to: 'plan', finding: { from: 'Red tests', reason: 'RED GATE FAILED: 1 new test(s) already pass' } });
    expect(h!.text).toBe('Why this stage is running again (from the pipeline, Red tests):\nRED GATE FAILED: 1 new test(s) already pass');
    expect(raw(c).finding.at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  test('the prompt holds the finding first and the user instruction second, as separate labelled blocks', () => {
    const c = ctx();
    writeHandoff(c, { to: 'plan', from: 'Red tests', reason: 'why' });
    writeUserNote(c, { to: 'plan', text: '  keep it small  ' });
    expect(takeHandoff(c, 'plan')!.text).toBe('Why this stage is running again (from the pipeline, Red tests):\nwhy\n\nInstruction from the user:\nkeep it small');
  });

  test('a user note alone gives only its block; an empty note writes nothing', () => {
    const c = ctx();
    writeUserNote(c, { to: 'spec', text: '   ' });
    expect(readHandoff(c)).toBeNull();
    writeUserNote(c, { to: 'spec', text: 'narrow it' });
    expect(takeHandoff(c, 'spec')!.text).toBe('Instruction from the user:\nnarrow it');
  });

  test('writing a user note never edits the finding, and its stage overrides `to`', () => {
    const c = ctx();
    writeHandoff(c, { to: 'plan', from: 'Red tests', reason: 'why' });
    const finding = raw(c).finding;
    writeUserNote(c, { to: 'spec', text: 'redo' });
    expect(raw(c)).toMatchObject({ to: 'spec', finding, user: { note: 'redo' } });
  });

  test('a harness stop replaces the finding and keeps the note for the same stage, clears it for another', () => {
    const c = ctx();
    writeHandoff(c, { to: 'plan', from: 'Red tests', reason: 'first' });
    writeUserNote(c, { to: 'plan', text: 'mine' });
    writeHandoff(c, { to: 'plan', from: 'Red tests', reason: 'second' });
    expect(raw(c)).toMatchObject({ to: 'plan', finding: { reason: 'second' }, user: { note: 'mine' } });
    writeHandoff(c, { to: 'red-tests', from: 'Red tests', reason: 'third' });
    expect(raw(c).user).toBeUndefined();
    expect(raw(c).finding.reason).toBe('third');
  });

  test('a start at an earlier stage still takes it; a start after its stage does not', () => {
    const c = ctx();
    writeHandoff(c, { to: 'plan', from: 'Red tests', reason: 'why' });
    expect(takeHandoff(c, 'spec')).not.toBeNull();
    expect(takeHandoff(c, 'red-tests')).toBeNull();
    expect(takeHandoff(c, 'implement')).toBeNull();
  });

  test('a stage without the placeholder, an unreadable file and a missing file give nothing', () => {
    const c = ctx();
    expect(takeHandoff(c, 'spec')).toBeNull();
    writeHandoff(c, { to: 'finalise', from: 'x', reason: 'why' });
    expect(takeHandoff(c, 'spec')).toBeNull();
    fs.writeFileSync(path.join(c.root, c.log, 'handoff.json'), 'not json');
    expect(takeHandoff(c, 'spec')).toBeNull();
  });

  test('once consumed nothing is taken and the file is in logs/previous', () => {
    const c = ctx();
    writeHandoff(c, { to: 'plan', from: 'Red tests', reason: 'first' });
    consumeHandoff(c);
    expect(takeHandoff(c, 'plan')).toBeNull();
    const prev = path.join(c.root, c.log, 'previous');
    const dirs = fs.readdirSync(prev);
    expect(dirs).toHaveLength(1);
    expect(fs.existsSync(path.join(prev, dirs[0], 'handoff.json'))).toBe(true);
  });
});
