export type BottleneckType =
  | 'ttft_lag'
  | 'token_bloat'
  | 'retry_loop'
  | 'subprocess_sluggish'
  | 'permission_denial'
  | 'human_pause';

export interface Bottleneck {
  type: BottleneckType;
  stage: string;
  description: string;
  impactMs?: number;
  impactTokens?: number;
  suggestion: string;
}

export type AnomalyType =
  | 'invariant_violation'
  | 'syntax_crash'
  | 'test_regression'
  | 'unhandled_pause'
  | 'timeout';

export interface Anomaly {
  stage: string;
  type: AnomalyType;
  severity: 'info' | 'warning' | 'error';
  details: string;
  isExpectedTddFailure: boolean;
}

export interface StageTelemetry {
  stage: string;
  agent?: string;
  model?: string;
  durationMs: number;
  attempts: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    thinking: number;
  };
  costUsd: number;
  permissionDenials: number;
  status: 'passed' | 'failed' | 'paused';
}

export interface PerformanceProfile {
  slug: string;
  totalDurationMs: number;
  criticalPath: {
    agentComputeMs: number;
    subprocessMs: number;
    humanPauseMs: number;
    otherMs: number;
  };
  totalTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    thinking: number;
    total: number;
  };
  totalCostUsd: number;
  stages: StageTelemetry[];
  bottlenecks: Bottleneck[];
  anomalies: Anomaly[];
}
