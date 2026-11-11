import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Status } from '../src/pipeline/status.js';
import { STEPS } from '../src/pipeline/steps.js';
import { stepOf } from '../src/runs/view.js';
import { elapsedText, stepBanner } from '../web/ui/src/stages.js';
import { fixture, pipeline, statusOf } from './pipeline-fixture.js';

afterEach(() => { vi.restoreAllMocks(); return new Promise<void>(resolve => { setImmediate(resolve); }); });
vi.setConfig({ testTimeout: 300_000 });

const tmpStatus = (stage: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-'));
  const s = new Status(path.join(dir, 'status.json'), 'x', 1);
  s.stage = stage;
  return { s, file: s.file, dir };
};

describe('the table of steps', () => {
  test('keys are unique within a stage and no label shows an internal name', () => {
    for (const [stage, list] of Object.entries(STEPS)) {
      expect(new Set(list.map(d => d.key)).size, stage).toBe(list.length);
      for (const d of list) expect(d.label, `${stage}/${d.key}`).not.toMatch(/precheck|namecheck|redcheck|diffcheck|resultsNow|\.json|\.sh\b/);
    }
    expect(STEPS['Test repair']).toHaveLength(12);
  });
});

describe('Status.beginStep', () => {
  test('writes the step i of n with its label, and an unknown key or the same step again writes nothing', () => {
    const { s, file } = tmpStatus('Test repair');
    const write = vi.spyOn(s, 'write');
    s.beginStep('nope');
    expect(write).not.toHaveBeenCalled();
    s.beginStep('precheck');
    s.beginStep('precheck');
    expect(write).toHaveBeenCalledTimes(1);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(j.step).toMatchObject({ i: 3, n: 12, label: 'Checking each claimed test really fails' });
    expect(typeof j.step.started).toBe('string');
  });

  test('a stage with no table writes nothing, and a failing write never throws', () => {
    const { s } = tmpStatus('Resolve conflicts');
    const write = vi.spyOn(s, 'write');
    s.beginStep('agent');
    expect(write).not.toHaveBeenCalled();
    s.stage = 'Spec';
    write.mockImplementation(() => { throw new Error('disk full'); });
    expect(() => s.beginStep('agent')).not.toThrow();
  });

  test('a status line without a step has no step key', () => {
    const { s } = tmpStatus('Spec');
    expect('step' in s.line()).toBe(false);
  });

  test('performance: a write carrying the step takes well under a millisecond', () => {
    const { s } = tmpStatus('Test repair');
    s.step = { i: 5, n: 12, label: 'Repairing the claimed tests', started: '2026-01-01T00:00:00' };
    const N = 300;
    const t0 = performance.now();
    for (let k = 0; k < N; k++) s.write();
    const perWrite = (performance.now() - t0) / N;
    console.log(`Status.write() with a step: ${perWrite.toFixed(3)} ms per write`);
    expect(perWrite).toBeLessThan(1);
  });
});

describe('what the run view and banner do with a step', () => {
  const step = { i: 3, n: 12, label: 'Checking each claimed test really fails', started: '2026-01-01T10:00:00' };

  test('stepOf keeps a well-formed step and drops a missing or malformed one', () => {
    expect(stepOf(step)).toEqual({ step });
    expect(stepOf(undefined)).toEqual({});
    expect(stepOf(null)).toEqual({});
    expect(stepOf({ ...step, i: 'x' })).toEqual({});
    expect(stepOf({ ...step, label: '' })).toEqual({});
    expect(stepOf({ i: 1, n: 2, label: 'a' })).toEqual({});
  });

  test('a running run with a step shows label, step i of n, stage and progress', () => {
    expect(stepBanner({ state: 'running', stage: 'Test repair', step })).toEqual({
      label: step.label, position: 'step 3 of 12', stage: 'Test repair', percent: 17, started: step.started,
    });
    expect(stepBanner({ state: 'running', stage: '5/7 Test repair', step })?.stage).toBe('Test repair');
  });

  test('no step, or a run that is not running (paused, failed, done, stopped), shows no banner', () => {
    expect(stepBanner({ state: 'running', stage: 'Spec' })).toBeNull();
    for (const state of ['paused', 'failed', 'done', 'stopped', 'not started']) expect(stepBanner({ state, stage: 'Spec', step }), state).toBeNull();
    expect(stepBanner({ state: 'running', stage: 'Spec', step: { ...step, i: 13 } })).toBeNull();
  });

  test('elapsed time reads as seconds then minutes, and is empty for a bad time', () => {
    const t = Date.parse('2026-01-01T10:00:00');
    expect(elapsedText('2026-01-01T10:00:00', t + 12_000)).toBe('12s');
    expect(elapsedText('2026-01-01T10:00:00', t + 65_000)).toBe('1m 05s');
    expect(elapsedText('2026-01-01T10:00:00', t - 5_000)).toBe('0s');
    expect(elapsedText('', t)).toBe('');
  });
});

describe('through a real pipeline run', () => {
  const CLAIMING = { FAKE_EXPECT: '6', FAKE_CLAIM: '1', MAX_ATTEMPTS: '1' };

  test('every step a stage names is in the table, in order, every table step is used, and writes stay bounded', async () => {
    const seen: Array<[string, string]> = [];
    const orig = Status.prototype.beginStep;
    vi.spyOn(Status.prototype, 'beginStep').mockImplementation(function (this: Status, key: string) { seen.push([this.stage, key]); orig.call(this, key); });
    let writes = 0;
    const origWrite = Status.prototype.write;
    vi.spyOn(Status.prototype, 'write').mockImplementation(function (this: Status) { writes++; origWrite.call(this); });

    const f = fixture();
    const r = await pipeline(f, CLAIMING);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'test-audit', 'review']);

    for (const [stage, key] of seen) expect(STEPS[stage]?.some(d => d.key === key), `${stage}/${key}`).toBe(true);
    for (const [stage, list] of Object.entries(STEPS)) {
      const used = seen.filter(([s]) => s === stage).map(([, k]) => k);
      expect(used.filter(k => !list.some(d => d.key === k)), stage).toEqual([]);
      const order = used.map(k => list.findIndex(d => d.key === k));
      expect([...order].sort((a, b) => a - b), `${stage} out of order`).toEqual(order);
      const only = ({ Plan: ['answers'], Implement: ['baseline'] } as Record<string, string[]>)[stage] ?? []; // only when a run starts from that stage
      expect(list.map(d => d.key).filter(k => !used.includes(k) && !only.includes(k)), `${stage} steps never reported`).toEqual([]);
    }
    // one write per step, plus a few per stage for the stage itself: far from a per-second rate
    const steps = Object.values(STEPS).reduce((n, l) => n + l.length, 0);
    expect(writes).toBeLessThanOrEqual(steps + 8 * Object.keys(STEPS).length);
    console.log(`status writes in a full run: ${writes} (${steps} steps)`);
    expect(statusOf(f.dir).step).toBeUndefined();
    expect(statusOf(f.dir).state).toBe('done');
  });

  test('a rejected repair leaves a failed status with no step (the banner does not stay on a dead run)', async () => {
    const f = fixture();
    const r = await pipeline(f, { ...CLAIMING, FAKE_REPAIR_FAILS: '1' });
    expect(r.status).toBe(1);
    const st = statusOf(f.dir);
    expect(st.state).toBe('failed');
    expect(st.step).toBeUndefined();
  });
});
