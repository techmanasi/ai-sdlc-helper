import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { runAgent } from '../../src/pipeline/agent.js';
import type { Ctx } from '../../src/pipeline/context.js';
import { readReviewRounds, reviewLoop } from '../../src/pipeline/review-gate.js';
import { redTestsStage } from '../../src/pipeline/stages.js';
import { tmp } from '../helpers.js';

vi.mock('../../src/pipeline/agent.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/pipeline/agent.js')>(),
  runAgent: vi.fn(),
}));
vi.mock('../../src/pipeline/stages.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/pipeline/stages.js')>(),
  redTestsStage: vi.fn(),
}));

describe('Review admission with persisted history', () => {
  it.each([
    { name: 'legacy ordinal at the limit', outcomes: ['fix loop 2 of 3', 'fixed'], max: 2, next: 0 },
    { name: 'legacy ordinal followed by ambiguous fixed rounds', outcomes: ['fix loop 2 of 3', 'fixed', 'fixed'], max: 3, next: 3 },
    { name: 'unreserved and final rounds', outcomes: ['changes requested', 'fixed', 'passed', 'stopped: 2 fix loop(s) used, findings still open'], max: 1, next: 1 },
  ])('uses the recorded count for $name', async ({ outcomes, max, next }) => {
    const root = tmp('review-history-');
    const log = 'logs';
    try {
      fs.mkdirSync(path.join(root, log));
      const history = outcomes.map((outcome, i) => ({
        round: i + 1, verdict: outcome === 'passed' ? 'pass' : 'changes', findings: [], outcome,
      }));
      fs.writeFileSync(path.join(root, log, 'review-rounds.json'), JSON.stringify(history));
      const ctx = {
        root, log, docs: '.', slug: 'sum', config: { review: { mode: 'single', maxLoops: max, syncEachRound: true } },
        status: { write: vi.fn() }, out: vi.fn(), err: vi.fn(), git: { run: vi.fn(() => '') },
      } as unknown as Ctx;
      vi.mocked(runAgent).mockImplementationOnce(async () => {
        fs.writeFileSync(path.join(root, 'review.json'), JSON.stringify({
          verdict: 'changes', blockers: [{ file: 'sum.ts', criterion: 'addition', reason: 'incorrect result' }], missingTests: [],
        }));
      });
      // Observe the reservation exactly when control passes to Red tests.
      const pause = new Error('entered Red tests');
      vi.mocked(redTestsStage).mockReset().mockRejectedValue(pause);
      const sync = vi.fn(async () => {});
      const attempt = reviewLoop(ctx, sync);
      if (next) {
        await expect(attempt).rejects.toBe(pause);
        expect(sync.mock.calls).toEqual([['red-tests']]);
        expect(readReviewRounds(root, log).pop()).toMatchObject({ loop: next, outcome: `fix loop ${next} of ${max}` });
      } else {
        await expect(attempt).rejects.toMatchObject({ reason: expect.stringContaining(`REVIEW NOT RESOLVED after ${max} fix loop(s)`) });
        expect(sync).not.toHaveBeenCalled();
        expect(redTestsStage).not.toHaveBeenCalled();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
