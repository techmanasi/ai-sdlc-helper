import { describe, expect, test, vi } from 'vitest';
import { fixture, pipeline } from './pipeline-fixture.js';

// A run is a chain of git and test subprocesses: give the runner room to report.
vi.setConfig({ testTimeout: 60_000 });

describe('a stage whose agent wrote no artifact', () => {
  test('Spec says what the agent said and where its log is, instead of stopping blankly', async () => {
    const f = fixture({ spec: 'true' });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Spec not produced: spec-1 said "spec done" (see work/items/add-sum/logs/spec-1.log)');
  });

  test('Plan does the same', async () => {
    const f = fixture({ plan: 'true' });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Plan not produced: plan said "plan done" (see work/items/add-sum/logs/plan.log)');
  });
});
