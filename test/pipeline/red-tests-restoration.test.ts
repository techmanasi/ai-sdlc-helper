import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { runAgent } from '../../src/pipeline/agent.js';
import { Exit } from '../../src/pipeline/context.js';
import { readReviewRounds } from '../../src/pipeline/review-gate.js';
import { DOCS, LOG, SLUG, fixture, git, pipeline } from '../pipeline-fixture.js';

vi.mock('../../src/pipeline/agent.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/pipeline/agent.js')>(), runAgent: vi.fn(),
}));
const seeded = vi.hoisted(() => new WeakSet<object>());
vi.mock('../../src/pipeline/branch-sync.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/pipeline/branch-sync.js')>(),
  syncBranch: vi.fn(async (ctx: { promptExtra?: Record<string, string> }) => {
    if (!seeded.has(ctx)) {
      ctx.promptExtra = { OTHER: 'kept' };
      seeded.add(ctx);
    }
  }),
}));

const finding = { file: 'sum.mjs', criterion: 'sum', reason: 'cover the result', kind: 'missing-test', status: 'open' };
const round = (outcome: string, n = 1) => ({
  round: n, verdict: outcome === 'passed' ? 'pass' : 'changes', outcome,
  findings: outcome === 'passed' ? [] : [finding, { ...finding, kind: 'blocker', reason: 'handle negative numbers' }],
});

async function resume(history: ReturnType<typeof round>[] | undefined) {
  const f = fixture();
  git(f.dir, 'switch', '-qc', `feature/${SLUG}`);
  fs.mkdirSync(path.join(f.dir, LOG), { recursive: true });
  fs.writeFileSync(path.join(f.dir, DOCS, 'plan-1.md'), 'plan');
  git(f.dir, 'add', DOCS);
  git(f.dir, 'commit', '-qm', `[red-tests] test(${SLUG}): add failing tests`);
  if (history) fs.writeFileSync(path.join(f.dir, LOG, 'review-rounds.json'), JSON.stringify(history));
  const observed: Record<string, string>[] = [];
  vi.mocked(runAgent).mockImplementation(async (ctx, _name, stage) => {
    if (stage !== 'red-tests') throw new Error(`unexpected agent ${stage}`);
    observed.push({ ...ctx.promptExtra });
    throw new Exit(1, 'captured Red tests input', 'red-tests');
  });
  const result = await pipeline(f, { SDLC_REVIEW_MAX_LOOPS: '2' }, { from: 'red-tests' });
  return { observed, result, history: readReviewRounds(f.dir, LOG) };
}

describe('Red tests startup with persisted Review findings', () => {
  it.each(['fix loop 1 of 2', 'changes requested'])('restores open findings for %s and reserves the round once', async outcome => {
    const restored = await resume([round(outcome)]);
    expect(restored.observed).toHaveLength(1);
    expect(restored.observed[0]).toMatchObject({ OTHER: 'kept', REVIEW_FINDINGS: expect.stringContaining('cover the result') });
    const prompt = restored.observed[0].REVIEW_FINDINGS;
    expect(prompt).toContain('handle negative numbers');
    expect(prompt).toMatch(/blocker[\s\S]*fail/i);
    expect(prompt).toMatch(/missing.test[\s\S]*pass/i);
    expect(prompt).toMatch(/wrong finding|already satisfied/i);
    expect(prompt).toMatch(/(fresh|new|unique)[^\n]*(title|name)/i);
    expect(prompt).toMatch(/import[^\n]*(inside|within)|(?:inside|within)[^\n]*import/i);
    if (outcome === 'changes requested') expect(restored.history[0]).toMatchObject({ loop: 1, outcome: 'fix loop 1 of 2' });
  });

  it.each(['passed', 'fixed', 'implement-skipped', 'stopped: 2 fix loop(s) used, findings still open', 'absent history'])(
    'switches from active findings to the initial gate for %s', async outcome => {
      const active = round('fix loop 1 of 2');
      const open = await resume([active]);
      const final = await resume(outcome === 'absent history' ? undefined : [active, round(outcome, 2)]);
      expect(open.observed[0]?.REVIEW_FINDINGS).toContain('cover the result');
      expect(final.observed).toHaveLength(1);
      expect(final.observed[0]).toMatchObject({ OTHER: 'kept' });
      expect(final.observed[0].REVIEW_FINDINGS).toBeUndefined();
    },
  );

  it('checks the limit before restoring a changes round that never reserved a slot', async () => {
    const stopped = await resume([round('fix loop 2 of 2'), round('changes requested', 2)]);
    expect(stopped.result.stdout).toContain('REVIEW NOT RESOLVED after 2 fix loop(s)');
    expect(stopped.observed).toEqual([]);
  });
});
