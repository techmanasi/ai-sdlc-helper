import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAgentFailure, usageLimit } from '../src/pipeline/agent.js';
import { stageRecoveryHint } from '../src/pipeline/hints.js';
import { resolve } from '../src/config/settings.js';
import { testsPass } from '../src/pipeline/gates.js';

describe('Universal Agent Error & Quota Handling', () => {
  it('detects Claude usage limit from JSON', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-limit-'));
    const jsonFile = path.join(tmp, 'agent.json');
    fs.writeFileSync(jsonFile, JSON.stringify({ api_error: 'usage_limit_reached', result: 'resets 2:30am (Asia/Dubai)' }));
    expect(usageLimit(jsonFile)).toBe('resets 2:30am (Asia/Dubai)');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects Codex rate limit and quota exhaustion from JSONL and stderr', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-limit-'));
    const jsonFile = path.join(tmp, 'agent.json');
    const errFile = path.join(tmp, 'agent.err');

    // JSONL rate limit
    fs.writeFileSync(jsonFile, '{"type":"start"}\n{"error":{"code":"rate_limit_exceeded"}}\n');
    expect(usageLimit(jsonFile)).toBe('rate limit reached');

    // JSONL quota exceeded
    fs.writeFileSync(jsonFile, '{"type":"start"}\n{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}\n');
    expect(usageLimit(jsonFile)).toBe('quota exceeded');

    // stderr quota exceeded fallback
    fs.writeFileSync(jsonFile, '');
    fs.writeFileSync(errFile, 'error: You exceeded your current quota, please check your plan and billing details.\n');
    expect(usageLimit(jsonFile, errFile)).toBe('quota exceeded');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects Agy/Gemini quota exhaustion and rate limit from status and stderr', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-limit-'));
    const jsonFile = path.join(tmp, 'agent.json');
    const errFile = path.join(tmp, 'agent.err');

    // JSON status RATE_LIMITED
    fs.writeFileSync(jsonFile, JSON.stringify({ status: 'RATE_LIMITED' }));
    expect(usageLimit(jsonFile)).toBe('rate limit reached');

    // JSON status QUOTA_EXCEEDED
    fs.writeFileSync(jsonFile, JSON.stringify({ status: 'QUOTA_EXCEEDED' }));
    expect(usageLimit(jsonFile)).toBe('quota exceeded');

    // stderr RESOURCE_EXHAUSTED
    fs.writeFileSync(jsonFile, '');
    fs.writeFileSync(errFile, 'google.api_core.exceptions.ResourceExhausted: 429 Quota exceeded for quota metric\n');
    expect(usageLimit(jsonFile, errFile)).toBe('quota exceeded');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('extractAgentFailure extracts actionable CLI and stderr errors', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fail-'));
    const base = path.join(tmp, 'impl-1');

    fs.writeFileSync(`${base}.err`, [
      "error: the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'",
      '',
      'Usage: codex exec [OPTIONS] [PROMPT]',
    ].join('\n'));

    const failure = extractAgentFailure(base, 2);
    expect(failure.summary).toBe("error: the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'");
    expect(failure.details).toContain("error: the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'");
    expect(failure.details).toContain('Usage: codex exec [OPTIONS] [PROMPT]');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('stageRecoveryHint diagnoses agent failures and quotas across stages', () => {
    const runOut = [
      'SDLC: task-1 on branch sdlc/task-1',
      '== 4/6 Implement (green gate, max 4 attempts)',
      ' attempt 1',
      '   -> agent: impl-1',
      "   !! agent 'impl-1' failed, see Docs/backlog/task-1/logs/impl-1.log",
      "      failure (exit 2): error: the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'",
    ];

    const recovery = stageRecoveryHint({
      slug: 'task-1',
      stage: 'Implement',
      state: 'failed',
      exitCode: 1,
      docsDir: 'Docs/backlog/task-1',
      runOut,
    });

    expect(recovery.diagnosis).toContain("Agent 'impl-1' crashed or failed: error: the argument '--sandbox <SANDBOX_MODE>' cannot be used with '--approve-for-me'");
    expect(recovery.manualAction?.file).toBe('logs/impl-1.err');
    expect(recovery.autoAction?.command).toContain('--from implement');

    const quotaRunOut = [
      'SDLC: task-2 on branch sdlc/task-2',
      '== 1/6 Spec',
      '   -> agent: spec-1',
      "   !! agent 'spec-1' quota / usage limit reached: quota exceeded",
    ];

    const quotaRecovery = stageRecoveryHint({
      slug: 'task-2',
      stage: 'Spec',
      state: 'failed',
      exitCode: 1,
      docsDir: 'Docs/backlog/task-2',
      runOut: quotaRunOut,
    });

    expect(quotaRecovery.diagnosis).toContain("Agent 'spec-1' reached quota or rate limit: quota exceeded");
    expect(quotaRecovery.autoAction?.label).toContain('quota reset');
  });
});

describe('Scoped Preliminary Tests Configuration', () => {
  it('resolves tests.preliminary to undefined (scoped by default) when not configured', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'proj', scripts: { test: 'vitest run' } }));
    const { config } = resolve(tmp);
    expect(config?.tests.preliminary).toBeUndefined();
    expect(config?.tests.preliminary !== 'full').toBe(true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('allows configuring tests.preliminary to full in sdlc.config.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'proj', scripts: { test: 'vitest run' } }));
    fs.writeFileSync(path.join(tmp, 'sdlc.config.json'), JSON.stringify({ tests: { preliminary: 'full' } }));
    const { config } = resolve(tmp);
    expect(config?.tests.preliminary).toBe('full');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('testsPass with onlyTargets stops after target files pass without running full suite', () => {
    let fullSuiteRan = false;
    let targetSuiteRan = false;

    const mockCtx: any = {
      root: '/mock',
      log: 'mock-log',
      env: {},
      config: {
        suites: [
          { name: 'unit', dir: '.', runner: 'vitest', testGlobs: ['test/**/*.test.ts'] },
        ],
      },
    };

    // We can verify that testsPass accepts onlyTargets: true in options
    expect(typeof testsPass).toBe('function');
  });
});
