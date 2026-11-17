import { describe, expect, test } from 'vitest';
import { costLog, costMarkdown, costText, timeText, tokenText } from '../src/runs/cost-log.js';
import type { Price, PriceTable } from '../src/models/prices.js';

const price = (input: number, output: number): Price => ({ input, output, cacheRead: input / 10, cacheWrite: input });
const prices: PriceTable = new Map([['gpt-6.1-terra', price(1, 8)], ['free-model', price(0, 0)]]);

const claude = (stage: string, at: string, cost: number) => ({
  kind: 'agent', at, stage, agent: stage, durationSec: 60, turns: 3, tokens: 1500, model: 'sonnet',
  usage: { input: 500, output: 1000, cacheRead: 0, cacheWrite: 0, costUsd: cost },
});
const codex = (stage: string, at: string) => ({
  kind: 'agent', at, stage, agent: stage, durationSec: 120, turns: 1, tokens: 1_001_000, model: 'gpt-6.1-terra',
  usage: { input: 1_000_000, output: 1000, cacheRead: 0, cacheWrite: null, costUsd: null },
});

const rows = [
  { kind: 'run', at: '2026-11-17T10:00:00', from: 'spec', n: 1 },
  { kind: 'stage', at: '2026-11-17T10:00:00', stage: 'Spec' },
  claude('spec', '2026-11-17T10:01:00', 0.25),
  { kind: 'stage', at: '2026-11-17T10:02:00', stage: 'Plan' },
  claude('plan', '2026-11-17T10:03:00', 0.5),
  { kind: 'stage', at: '2026-11-17T10:05:00', stage: 'Red tests' },
  // killed here: no end row
  { kind: 'run', at: '2026-11-17T11:00:00', from: 'red-tests', n: 2 },
  { kind: 'stage', at: '2026-11-17T11:00:00', stage: 'Red tests' },
  codex('red-tests', '2026-11-17T11:02:00'),
  { kind: 'stage', at: '2026-11-17T11:04:00', stage: 'Implement' },
  { kind: 'agent', at: '2026-11-17T11:05:00', stage: 'implement', agent: 'implement', durationSec: 30, tokens: 400, model: 'free-model', usage: { input: 300, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: null } },
  { kind: 'end', at: '2026-11-17T11:06:00', state: 'done', stage: 'Implement' },
];

describe('costLog', () => {
  const log = costLog(rows, { slug: 'demo', prices, now: '2026-11-17T12:00:00' });

  test('splits the rows into runs, with how each ended and its wall time', () => {
    expect(log.runs.map(r => [r.n, r.from, r.state, r.wallSec])).toEqual([
      [1, 'spec', 'stopped', 5 * 60],
      [2, 'red-tests', 'done', 6 * 60],
    ]);
  });

  test('each run has its stages with time, rounds, models and cost', () => {
    const [first, second] = log.runs;
    expect(first.stages.map(s => [s.stage, s.wallSec, s.usage.rounds, s.models, s.usage.costUsd])).toEqual([
      ['Spec', 120, 1, ['sonnet'], 0.25],
      ['Plan', 180, 1, ['sonnet'], 0.5],
      ['Red tests', 0, 0, [], null],
    ]);
    const red = second.stages[0];
    // 1M input at $1/M plus 1k output at $8/M, estimated
    expect(red.usage.costUsd).toBeCloseTo(1.008, 6);
    expect(red.usage.estimatedUsd).toBeCloseTo(1.008, 6);
    expect(second.stages[1].usage.costUsd).toBe(0);
  });

  test('the task total adds every run, by stage and overall', () => {
    expect(log.stages.map(s => [s.stage, s.passes, s.usage.rounds])).toEqual([
      ['Spec', 1, 1], ['Plan', 1, 1], ['Red tests', 2, 1], ['Implement', 1, 1],
    ]);
    expect(log.usage.rounds).toBe(4);
    expect(log.usage.costUsd).toBeCloseTo(1.758, 6);
    expect(log.usage.estimatedUsd).toBeCloseTo(1.008, 6);
    expect(log.wallSec).toBe(11 * 60);
    expect(log.priced).toBe(true);
  });

  test('without a price table the codex round is unpriced and only the reported cost counts', () => {
    const bare = costLog(rows, { slug: 'demo' });
    expect(bare.priced).toBe(false);
    expect(bare.usage.costUsd).toBeCloseTo(0.75, 6);
    expect(bare.usage.unpriced).toBe(2);
  });

  test('a run still going counts its open stage up to now', () => {
    const live = costLog(rows.slice(0, 9), { slug: 'demo', now: '2026-11-17T11:10:00' });
    const last = live.runs[1];
    expect([last.state, last.ended, last.stages[0].wallSec]).toEqual([null, null, 600]);
  });

  test('rows written before run rows existed form run 0', () => {
    const old = costLog([claude('spec', '2026-11-17T09:00:00', 0.1)], { slug: 'demo' });
    expect(old.runs.map(r => [r.n, r.stages.map(s => s.stage)])).toEqual([[0, ['Spec']]]);
  });
});

describe('cost text', () => {
  test('dollars, estimates, free and no cost', () => {
    const u = costLog(rows, { slug: 'demo', prices }).usage;
    expect(costText(u)).toBe('≈$1.76');
    expect(costText({ ...u, estimatedUsd: 0 })).toBe('$1.76');
    expect(costText({ ...u, costUsd: 0 })).toBe('free');
    expect(costText({ ...u, costUsd: 0.004, estimatedUsd: 0 })).toBe('<$0.01');
    expect(costText({ ...u, costUsd: null })).toBe('no price');
    expect(costText({ ...u, costUsd: null, tokens: 0, input: 0, output: 0 })).toBe('—');
  });

  test('tokens and time', () => {
    expect([tokenText(950), tokenText(6000), tokenText(12_300_000)]).toEqual(['950', '6.0k', '12.30M']);
    expect([timeText(12), timeText(245), timeText(3720)]).toEqual(['12s', '4m 05s', '1h 02m']);
  });

  test('cost.md carries the total and a row per stage and per run', () => {
    const md = costMarkdown(costLog(rows, { slug: 'demo', prices, now: '2026-11-17T12:00:00' }));
    const lines = md.split('\n');
    expect(lines).toContain('**Total: ≈$1.76 · 1.00M tokens · 11m 00s run time · 4m 30s agent time · 2 runs**');
    expect(lines).toContain('| Red tests | 2 | 4m 00s | 2m 00s | 1 | gpt-6.1-terra | 1.00M | 1.0k | 0 | 0 | 1.00M | ≈$1.01 |');
    expect(lines).toContain('| Implement | 1 | 2m 00s | 30s | 1 | free-model | 300 | 100 | 0 | 0 | 400 | free |');
    expect(lines).toContain('| 1 | 2026-11-17 10:00 | spec | stopped | 5m 00s | 2 | 3.0k | $0.75 |');
  });
});
