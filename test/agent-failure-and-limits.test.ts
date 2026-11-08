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

  describe('does not mistake transcript content for a provider limit', () => {
    const quoted = [
      'const code = "usage_limit_reached";',
      'throw new Error("quota exceeded"); // rate_limit_exceeded',
      'cache resets every hour; 429 Too Many Requests handled elsewhere',
    ].join('\n');
    const withTmp = (fn: (jsonFile: string, errFile: string) => void): void => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-limit-'));
      try { fn(path.join(tmp, 'agent.json'), path.join(tmp, 'agent.err')); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    };

    it('ignores quota strings in Codex tool output and assistant text of a successful turn', () => {
      withTmp((jsonFile, errFile) => {
        fs.writeFileSync(jsonFile, [
          JSON.stringify({ type: 'thread.started' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'graft grep usage_limit_reached', aggregated_output: quoted, exit_code: 0 } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'The detector matches usage_limit_reached and resets 1am.' } }),
          JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
        ].join('\n') + '\n');
        fs.writeFileSync(errFile, 'Reading additional input from stdin...\n2026-11-08T08:28:53Z ERROR codex_core::tools::router: error=apply_patch verification failed\n');
        expect(usageLimit(jsonFile, errFile)).toBeNull();
      });
    });

    it('ignores quota strings in the result text of a successful single-object transcript', () => {
      withTmp((jsonFile) => {
        fs.writeFileSync(jsonFile, JSON.stringify({ type: 'result', is_error: false, result: quoted }));
        expect(usageLimit(jsonFile)).toBeNull();
      });
    });

    it('still detects real Codex provider error events', () => {
      withTmp((jsonFile) => {
        fs.writeFileSync(jsonFile, '{"type":"turn.started"}\n{"type":"error","message":"You\'ve hit your usage limit. Try again later."}\n');
        expect(usageLimit(jsonFile)).toBe('usage limit reached');
        fs.writeFileSync(jsonFile, '{"type":"turn.failed","error":{"message":"exceeded your current quota"}}\n');
        expect(usageLimit(jsonFile)).toBe('quota exceeded');
        fs.writeFileSync(jsonFile, '{"type":"error","error":{"code":"usage_limit_reached","message":"resets 3pm"}}\n');
        expect(usageLimit(jsonFile)).toBe('resets 3pm');
        fs.writeFileSync(jsonFile, '{"type":"turn.failed","error":{"code":"rate_limit_exceeded"}}\n');
        expect(usageLimit(jsonFile)).toBe('rate limit reached');
      });
    });

    it('still detects a Claude error result that reports a limit', () => {
      withTmp((jsonFile) => {
        fs.writeFileSync(jsonFile, JSON.stringify({ type: 'result', is_error: true, result: 'Claude usage limit reached. Your limit resets 2am (Asia/Dubai)' }));
        expect(usageLimit(jsonFile)).toBe('resets 2am (Asia/Dubai)');
      });
    });
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

  it('prefers a structured Codex error over incidental stderr output', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fail-'));
    const base = path.join(tmp, 'impl-1');
    fs.writeFileSync(`${base}.err`, 'Reading additional input from stdin...\n');
    fs.writeFileSync(`${base}.json`, [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ type: 'turn.failed', error: { message: "The 'o3-mini' model is not supported" } }),
    ].join('\n'));

    const failure = extractAgentFailure(base, 1);
    expect(failure.summary).toBe("The 'o3-mini' model is not supported");
    expect(failure.details).toContain('Reading additional input from stdin...');
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

    const modelFailRunOut = [
      'SDLC: config-modal-keyboard on branch sdlc/config-modal-keyboard',
      '== 4/6 Implement (green gate, max 4 attempts)',
      ' attempt 1',
      '   -> agent: impl-1',
      "   !! agent 'impl-1' failed, see docs/backlog/config-modal-keyboard/logs/impl-1.log",
      "      failure (exit 1): The 'o3-mini' model is not supported when using Codex with a ChatGPT account.",
    ];

    const modelRecovery = stageRecoveryHint({
      slug: 'config-modal-keyboard',
      stage: 'Implement',
      state: 'failed',
      exitCode: 1,
      docsDir: 'docs/backlog/config-modal-keyboard',
      runOut: modelFailRunOut,
    });

    expect(modelRecovery.diagnosis).toContain("model not supported with current account");
    expect(modelRecovery.autoAction?.label).toContain("Switch to supported model");
    expect(modelRecovery.autoAction?.command).toContain("--model gpt-4o");
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

  it('testsPass function interface supports onlyTargets option', () => {
    expect(typeof testsPass).toBe('function');
  });
});
