import { describe, expect, it } from 'vitest';
import {
  applyPromptMutation,
  evaluatePareto,
  runBenchmarkSuite,
  type Mutation,
  type TaskEvaluation,
} from '../src/optimizer/index.js';

describe('Auto-SDLC Optimizer & Benchmark Runner', () => {
  const sampleMutation: Mutation = {
    id: 'mut-tighten-implement-tests',
    description: 'Instruct implement agent to run only affected tests rather than full suite',
    type: 'prompt_directive',
    targetStage: 'implement',
    payload: {
      directive: 'Run only test files matching the changed source before gating.',
    },
    createdAt: '2026-10-31T10:00:00Z',
  };

  it('promotes candidate mutation when it achieves Pareto superiority with zero regressions', () => {
    const baseline: TaskEvaluation[] = [
      { taskId: 'task-1', passed: true, durationMs: 20000, totalTokens: 50000, attempts: 2, errors: [] },
      { taskId: 'task-2', passed: true, durationMs: 30000, totalTokens: 60000, attempts: 1, errors: [] },
    ];

    const mutated: TaskEvaluation[] = [
      { taskId: 'task-1', passed: true, durationMs: 14000, totalTokens: 42000, attempts: 1, errors: [] }, // 30% faster, fewer attempts
      { taskId: 'task-2', passed: true, durationMs: 22000, totalTokens: 51000, attempts: 1, errors: [] }, // ~26% faster
    ];

    const delta = evaluatePareto(baseline, mutated, sampleMutation.id);

    expect(delta.isParetoSuperior).toBe(true);
    expect(delta.verdict).toBe('promote');
    expect(delta.baselineSuccessRate).toBe(1.0);
    expect(delta.mutatedSuccessRate).toBe(1.0);
    expect(delta.successRateDelta).toBe(0);
    expect(delta.latencyDeltaPct).toBeGreaterThan(0.20);
    expect(delta.tokenDeltaPct).toBeGreaterThan(0.10);
    expect(delta.attemptDelta).toBe(1);
    expect(delta.rejectionReason).toBeUndefined();
  });

  it('discards mutation immediately if any regression is detected', () => {
    const baseline: TaskEvaluation[] = [
      { taskId: 'task-1', passed: true, durationMs: 20000, totalTokens: 50000, attempts: 1, errors: [] },
      { taskId: 'task-2', passed: true, durationMs: 20000, totalTokens: 50000, attempts: 1, errors: [] },
    ];

    // task-2 regressed (passed in baseline, failed in mutated)
    const mutated: TaskEvaluation[] = [
      { taskId: 'task-1', passed: true, durationMs: 10000, totalTokens: 25000, attempts: 1, errors: [] },
      { taskId: 'task-2', passed: false, durationMs: 12000, totalTokens: 25000, attempts: 2, errors: ['Failed assertion'] },
    ];

    const delta = evaluatePareto(baseline, mutated, sampleMutation.id);

    expect(delta.isParetoSuperior).toBe(false);
    expect(delta.verdict).toBe('discard');
    expect(delta.rejectionReason).toContain('Regression detected in 1 task(s): task-2');
  });

  it('discards mutation if no performance or cost gain is achieved', () => {
    const baseline: TaskEvaluation[] = [
      { taskId: 'task-1', passed: true, durationMs: 10000, totalTokens: 20000, attempts: 1, errors: [] },
    ];

    // Equivalent duration and tokens
    const mutated: TaskEvaluation[] = [
      { taskId: 'task-1', passed: true, durationMs: 9900, totalTokens: 19800, attempts: 1, errors: [] },
    ];

    const delta = evaluatePareto(baseline, mutated, sampleMutation.id);

    expect(delta.isParetoSuperior).toBe(false);
    expect(delta.verdict).toBe('discard');
    expect(delta.rejectionReason).toContain('No significant performance or efficiency gain');
  });

  it('executes full benchmark replay suite across tasks', async () => {
    const tasks = ['b-1', 'b-2'];
    const mockExecutor = async (taskId: string, m?: Mutation): Promise<TaskEvaluation> => {
      const isMutated = !!m;
      return {
        taskId,
        passed: true,
        durationMs: isMutated ? 12000 : 18000,
        totalTokens: isMutated ? 30000 : 40000,
        attempts: 1,
        errors: [],
      };
    };

    const delta = await runBenchmarkSuite(tasks, sampleMutation, mockExecutor);
    expect(delta.verdict).toBe('promote');
    expect(delta.latencyDeltaPct).toBeCloseTo(0.333, 2);
    expect(delta.tokenDeltaPct).toBeCloseTo(0.25, 2);
  });

  it('injects prompt steering directive without corrupting template', () => {
    const base = 'You are an Implement Agent.\nWrite clean code.';
    const patched = applyPromptMutation(base, sampleMutation);

    expect(patched).toContain(base);
    expect(patched).toContain('## Auto-SDLC Optimizer Directive (mut-tighten-implement-tests)');
    expect(patched).toContain('Run only test files matching the changed source before gating.');
  });
});
