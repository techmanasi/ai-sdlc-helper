import type {
  BenchmarkDelta,
  Mutation,
  TaskEvaluation,
  TaskExecutor,
} from './types.js';

/**
 * Computes multi-objective Pareto metrics comparing candidate mutation outcomes
 * against the frozen baseline. Enforces hard zero-regression constraints.
 */
export function evaluatePareto(
  baseline: TaskEvaluation[],
  mutated: TaskEvaluation[],
  mutationId: string,
): BenchmarkDelta {
  const n = baseline.length;
  if (n === 0 || mutated.length !== n) {
    throw new Error('Baseline and mutated runs must contain identical task counts');
  }

  const basePassed = baseline.filter(t => t.passed).length;
  const mutPassed = mutated.filter(t => t.passed).length;

  const baseRate = basePassed / n;
  const mutRate = mutPassed / n;
  const rateDelta = mutRate - baseRate;

  // Check for regressions: any task that passed in baseline but failed in mutated
  const regressions = mutated.filter(m => {
    const b = baseline.find(t => t.taskId === m.taskId);
    return b && b.passed && !m.passed;
  });

  if (regressions.length > 0) {
    return {
      mutationId,
      baselineSuccessRate: baseRate,
      mutatedSuccessRate: mutRate,
      successRateDelta: rateDelta,
      latencyDeltaPct: 0,
      tokenDeltaPct: 0,
      attemptDelta: 0,
      isParetoSuperior: false,
      verdict: 'discard',
      rejectionReason: `Regression detected in ${regressions.length} task(s): ${regressions.map(r => r.taskId).join(', ')}`,
    };
  }

  // Aggregate latencies and tokens
  const baseDuration = baseline.reduce((sum, t) => sum + t.durationMs, 0);
  const mutDuration = mutated.reduce((sum, t) => sum + t.durationMs, 0);
  const latencyDeltaPct = baseDuration > 0 ? (baseDuration - mutDuration) / baseDuration : 0;

  const baseTokens = baseline.reduce((sum, t) => sum + t.totalTokens, 0);
  const mutTokens = mutated.reduce((sum, t) => sum + t.totalTokens, 0);
  const tokenDeltaPct = baseTokens > 0 ? (baseTokens - mutTokens) / baseTokens : 0;

  const baseAttempts = baseline.reduce((sum, t) => sum + t.attempts, 0);
  const mutAttempts = mutated.reduce((sum, t) => sum + t.attempts, 0);
  const attemptDelta = baseAttempts - mutAttempts;

  // Pareto Superiority Rule:
  // 1. Success rate must not decrease (rateDelta >= 0, checked above via regressions)
  // 2. Must achieve at least 5% latency reduction OR 8% token savings OR fewer retry attempts
  const isParetoSuperior = rateDelta >= 0 && (latencyDeltaPct >= 0.05 || tokenDeltaPct >= 0.08 || attemptDelta > 0);

  return {
    mutationId,
    baselineSuccessRate: baseRate,
    mutatedSuccessRate: mutRate,
    successRateDelta: rateDelta,
    latencyDeltaPct,
    tokenDeltaPct,
    attemptDelta,
    isParetoSuperior,
    verdict: isParetoSuperior ? 'promote' : 'discard',
    rejectionReason: isParetoSuperior ? undefined : 'No significant performance or efficiency gain achieved',
  };
}

/**
 * Executes a full benchmark replay comparing baseline vs candidate mutation.
 */
export async function runBenchmarkSuite(
  taskIds: string[],
  mutation: Mutation,
  executor: TaskExecutor,
): Promise<BenchmarkDelta> {
  const baselineRuns: TaskEvaluation[] = [];
  const mutatedRuns: TaskEvaluation[] = [];

  for (const taskId of taskIds) {
    const baseRes = await executor(taskId, undefined);
    baselineRuns.push(baseRes);

    const mutRes = await executor(taskId, mutation);
    mutatedRuns.push(mutRes);
  }

  return evaluatePareto(baselineRuns, mutatedRuns, mutation.id);
}

/**
 * Injects a prompt steering directive safely into a template.
 */
export function applyPromptMutation(basePrompt: string, mutation: Mutation): string {
  if (mutation.type !== 'prompt_directive' || !mutation.payload.directive) {
    return basePrompt;
  }
  return `${basePrompt}\n\n## Auto-SDLC Optimizer Directive (${mutation.id})\n${mutation.payload.directive}\n`;
}
