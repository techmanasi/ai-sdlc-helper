import fs from 'node:fs';
import path from 'node:path';
import type {
  Anomaly,
  Bottleneck,
  PerformanceProfile,
  StageTelemetry,
} from './types.js';

function readJsonSafe(file: string): any {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {
    /* ignore malformed json */
  }
  return null;
}

function readTextSafe(file: string): string {
  try {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, 'utf8');
    }
  } catch {
    /* ignore read errors */
  }
  return '';
}

/**
 * Analyzes execution traces in an item's docs directory (`Docs/backlog/<slug>`)
 * and derives a structured performance profile with critical path attribution,
 * bottleneck diagnosis, and stage invariant anomaly detection.
 */
export function analyzeRun(docsDir: string, slug?: string): PerformanceProfile {
  const resolvedSlug = slug || path.basename(docsDir);
  const logsDir = path.join(docsDir, 'logs');
  const status = readJsonSafe(path.join(logsDir, 'status.json')) || {};
  const runOut = readTextSafe(path.join(logsDir, 'run.out'));
  const permissions = readJsonSafe(path.join(logsDir, 'permissions.json')) || {};

  const stages: StageTelemetry[] = [];
  const bottlenecks: Bottleneck[] = [];
  const anomalies: Anomaly[] = [];

  let totalAgentComputeMs = 0;
  let totalSubprocessMs = 0;
  let totalCostUsd = 0;
  const totalTokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    thinking: 0,
    total: 0,
  };

  // 1. Scan and parse all agent JSONL / JSON files in logs directory
  const files = fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [];
  const agentLogFiles = files.filter(f => f.endsWith('.json') && !['status.json', 'permissions.json', 'tests.json', 'red.json', 'baseline.json', 'stage-files.json', 'finalise-options.json'].includes(f));

  for (const f of agentLogFiles) {
    const raw = readJsonSafe(path.join(logsDir, f));
    if (!raw || typeof raw !== 'object') continue;

    const stageName = f.replace(/\.json$/, '');
    const durationMs = typeof raw.duration_ms === 'number' ? raw.duration_ms : (raw.duration_api_ms || 0);
    const usage = raw.usage || {};
    const model = (status.models && status.models[stageName]?.model) || raw.model || '';

    const stageTok = {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
      cacheCreation: usage.cache_creation_input_tokens || 0,
      thinking: usage.output_tokens_details?.thinking_tokens || 0,
    };

    const cost = typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : 0;
    const denials = Array.isArray(raw.permission_denials) ? raw.permission_denials.length : 0;

    totalAgentComputeMs += durationMs;
    totalCostUsd += cost;
    totalTokens.input += stageTok.input;
    totalTokens.output += stageTok.output;
    totalTokens.cacheRead += stageTok.cacheRead;
    totalTokens.cacheCreation += stageTok.cacheCreation;
    totalTokens.thinking += stageTok.thinking;
    totalTokens.total += (stageTok.input + stageTok.output + stageTok.cacheRead + stageTok.cacheCreation);

    stages.push({
      stage: stageName,
      agent: stageName,
      model,
      durationMs,
      attempts: 1,
      tokens: stageTok,
      costUsd: cost,
      permissionDenials: denials,
      status: denials > 0 ? 'paused' : 'passed',
    });

    // Check for TTFT latency lag
    if (typeof raw.ttft_ms === 'number' && raw.ttft_ms > 10000) {
      bottlenecks.push({
        type: 'ttft_lag',
        stage: stageName,
        description: `High Time-to-First-Token (${(raw.ttft_ms / 1000).toFixed(1)}s)`,
        impactMs: raw.ttft_ms,
        suggestion: 'Enable prompt cache warming or reduce unneeded system context',
      });
    }

    // Check for token bloat
    if (stageTok.input > 60000) {
      bottlenecks.push({
        type: 'token_bloat',
        stage: stageName,
        description: `Stage input token usage is high (${stageTok.input.toLocaleString()} tokens)`,
        impactTokens: stageTok.input,
        suggestion: 'Narrow code search files or prune irrelevant test log histories',
      });
    }

    // Check for tool denials
    if (denials > 0) {
      bottlenecks.push({
        type: 'permission_denial',
        stage: stageName,
        description: `Agent experienced ${denials} permission denial(s) requiring human authorization`,
        suggestion: 'Review and pre-approve safe bash tools or use permit rules',
      });
    }
  }

  // 2. Analyze test runner logs
  const testsJson = readJsonSafe(path.join(logsDir, 'tests.json'));
  const redJson = readJsonSafe(path.join(logsDir, 'red.json'));

  if (testsJson && typeof testsJson.duration === 'number') {
    totalSubprocessMs += testsJson.duration * 1000;
  }
  if (redJson && typeof redJson.duration === 'number') {
    totalSubprocessMs += redJson.duration * 1000;
  }

  // 3. Stage Invariant & Anomaly Evaluation
  // Invariant A: Red-tests must fail with at least one failure
  if (redJson) {
    if (redJson.failed === 0 && redJson.syntaxErrors === 0) {
      anomalies.push({
        stage: 'red-tests',
        type: 'invariant_violation',
        severity: 'error',
        details: 'Red tests passed unexpectedly before any implementation was written',
        isExpectedTddFailure: false,
      });
    } else if (redJson.failed > 0) {
      anomalies.push({
        stage: 'red-tests',
        type: 'invariant_violation',
        severity: 'info',
        details: `Red tests failed cleanly with ${redJson.failed} expected failure(s)`,
        isExpectedTddFailure: true,
      });
    }
  }

  // Invariant B: Spec pause verification
  if (runOut.includes('PAUSED: new questions in')) {
    const hasQuestions = fs.existsSync(path.join(docsDir, 'questions.md'));
    const isAutoAccept = (process.env.SDLC_AUTO_ACCEPT === '1');
    if (!hasQuestions) {
      anomalies.push({
        stage: 'spec',
        type: 'unhandled_pause',
        severity: 'warning',
        details: 'Pipeline paused for questions but questions.md was not generated',
        isExpectedTddFailure: false,
      });
    } else if (!isAutoAccept) {
      bottlenecks.push({
        type: 'human_pause',
        stage: 'spec',
        description: 'Spec stage paused for human answer confirmation',
        suggestion: 'Enable SDLC_AUTO_ACCEPT=1 to allow autonomous suggested answer acceptance',
      });
    }
  }

  // Invariant C: Implement attempts
  const attemptsMatches = runOut.match(/^\s*attempt \d+/gm);
  if (attemptsMatches && attemptsMatches.length > 2) {
    bottlenecks.push({
      type: 'retry_loop',
      stage: 'implement',
      description: `Implement required ${attemptsMatches.length} retry attempts to achieve green test gate`,
      suggestion: 'Steer prompt with targeted failure traces or increase model reasoning effort',
    });
  }

  // Invariant D: Permission denials in permission state
  if (Array.isArray(permissions.denied) && permissions.denied.length > 0) {
    for (const d of permissions.denied) {
      anomalies.push({
        stage: d.stage || 'implement',
        type: 'invariant_violation',
        severity: 'warning',
        details: `Command denied by permission policy: ${d.tool} (${d.detail})`,
        isExpectedTddFailure: false,
      });
    }
  }

  const humanPauseMs = bottlenecks.some(b => b.type === 'human_pause') ? 120000 : 0;
  const totalDurationMs = totalAgentComputeMs + totalSubprocessMs + humanPauseMs;

  return {
    slug: resolvedSlug,
    totalDurationMs,
    criticalPath: {
      agentComputeMs: totalAgentComputeMs,
      subprocessMs: totalSubprocessMs,
      humanPauseMs,
      otherMs: Math.max(0, totalDurationMs - (totalAgentComputeMs + totalSubprocessMs + humanPauseMs)),
    },
    totalTokens,
    totalCostUsd,
    stages,
    bottlenecks,
    anomalies,
  };
}
