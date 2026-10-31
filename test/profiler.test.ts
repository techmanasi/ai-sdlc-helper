import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { analyzeRun } from '../src/profiler/index.js';

describe('Profiler & Execution Trace Analyzer', () => {
  it('analyzes execution traces and isolates bottlenecks and invariant anomalies', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profiler-test-'));
    const logs = path.join(tmp, 'logs');
    fs.mkdirSync(logs, { recursive: true });

    // 1. Mock status.json
    fs.writeFileSync(path.join(logs, 'status.json'), JSON.stringify({
      slug: 'feature-cart',
      state: 'running',
      stage: 'Implement',
      models: {
        'spec-1': { model: 'opus', effort: 'medium' },
        'impl-1': { model: 'sonnet', effort: 'medium' },
      },
    }));

    // 2. Mock spec-1.json with high TTFT and high input tokens
    fs.writeFileSync(path.join(logs, 'spec-1.json'), JSON.stringify({
      duration_ms: 15400,
      ttft_ms: 12500, // Trigger TTFT bottleneck
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 65000, // Trigger token bloat
        output_tokens: 1200,
        cache_read_input_tokens: 40000,
        cache_creation_input_tokens: 1000,
      },
      permission_denials: [],
    }));

    // 3. Mock impl-1.json with tool permission denials
    fs.writeFileSync(path.join(logs, 'impl-1.json'), JSON.stringify({
      duration_ms: 8200,
      ttft_ms: 1100,
      total_cost_usd: 0.12,
      usage: {
        input_tokens: 15000,
        output_tokens: 800,
      },
      permission_denials: [
        { tool: 'Bash', detail: 'npm install lodash' },
      ],
    }));

    // 4. Mock red.json with clean expected TDD failure
    fs.writeFileSync(path.join(logs, 'red.json'), JSON.stringify({
      passed: 12,
      failed: 2,
      skipped: 0,
      duration: 1.45,
    }));

    // 5. Mock run.out with pause output
    fs.writeFileSync(path.join(logs, 'run.out'), [
      '== 1/6 Spec',
      'PAUSED: new questions in docs/backlog/feature-cart/questions.md.',
      '== 4/6 Implement',
      ' attempt 1',
      ' attempt 2',
      ' attempt 3',
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'questions.md'), '# Questions\n');

    const profile = analyzeRun(tmp, 'feature-cart');

    expect(profile.slug).toBe('feature-cart');
    expect(profile.criticalPath.agentComputeMs).toBe(15400 + 8200);
    expect(profile.criticalPath.subprocessMs).toBeCloseTo(1450, 0);
    expect(profile.totalCostUsd).toBeCloseTo(0.37, 2);
    expect(profile.totalTokens.input).toBe(65000 + 15000);

    // Bottlenecks identified
    expect(profile.bottlenecks.some(b => b.type === 'ttft_lag')).toBe(true);
    expect(profile.bottlenecks.some(b => b.type === 'token_bloat')).toBe(true);
    expect(profile.bottlenecks.some(b => b.type === 'permission_denial')).toBe(true);
    expect(profile.bottlenecks.some(b => b.type === 'retry_loop')).toBe(true);
    expect(profile.bottlenecks.some(b => b.type === 'human_pause')).toBe(true);

    // Invariant evaluation
    const tddAnomaly = profile.anomalies.find(a => a.stage === 'red-tests');
    expect(tddAnomaly).toBeDefined();
    expect(tddAnomaly?.isExpectedTddFailure).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('flags unexpected red test pass as a defect anomaly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'profiler-anomaly-'));
    const logs = path.join(tmp, 'logs');
    fs.mkdirSync(logs, { recursive: true });

    // Red tests passed with 0 failures: violates red gate invariant
    fs.writeFileSync(path.join(logs, 'red.json'), JSON.stringify({
      passed: 15,
      failed: 0,
      syntaxErrors: 0,
      duration: 1.2,
    }));

    const profile = analyzeRun(tmp, 'flawed-task');
    const anomaly = profile.anomalies.find(a => a.stage === 'red-tests');
    expect(anomaly).toBeDefined();
    expect(anomaly?.severity).toBe('error');
    expect(anomaly?.isExpectedTddFailure).toBe(false);
    expect(anomaly?.details).toContain('Red tests passed unexpectedly');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
