export interface Mutation {
  id: string;
  description: string;
  type: 'prompt_directive' | 'model_routing' | 'gate_policy';
  targetStage: 'spec' | 'plan' | 'red-tests' | 'implement' | 'test-repair' | 'review' | 'finalise';
  payload: {
    directive?: string;
    model?: string;
    effort?: string;
    options?: Record<string, unknown>;
  };
  createdAt: string;
}

export interface TaskEvaluation {
  taskId: string;
  passed: boolean;
  durationMs: number;
  totalTokens: number;
  attempts: number;
  errors: string[];
}

export interface BenchmarkDelta {
  mutationId: string;
  baselineSuccessRate: number;
  mutatedSuccessRate: number;
  successRateDelta: number;
  latencyDeltaPct: number;
  tokenDeltaPct: number;
  attemptDelta: number;
  isParetoSuperior: boolean;
  verdict: 'promote' | 'discard';
  rejectionReason?: string;
}

export type TaskExecutor = (taskId: string, mutation?: Mutation) => Promise<TaskEvaluation>;
