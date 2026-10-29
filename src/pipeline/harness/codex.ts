import { which } from '../../shell.js';
import type { AgentHarness, HarnessDetection, HarnessInvocation, HarnessModel, HarnessResult, StageCompileOptions } from './types.js';

export class CodexHarness implements AgentHarness {
  readonly id = 'codex' as const;
  readonly name = 'OpenAI Codex CLI';
  readonly defaultBinary = 'codex';

  async detect(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetection> {
    const bin = which(this.defaultBinary, { env });
    if (!bin) {
      return { installed: false, error: 'codex binary not found on PATH' };
    }
    return { installed: true, path: bin };
  }

  async listModels(_env: NodeJS.ProcessEnv = process.env): Promise<HarnessModel[]> {
    return [
      { id: 'o3-mini', name: 'OpenAI o3-mini', harness: this.id, supportsEffort: true, defaultEffort: 'high', description: 'Recommended: fast, high-reasoning coding model with configurable effort' },
      { id: 'o1', name: 'OpenAI o1', harness: this.id, supportsEffort: true, defaultEffort: 'medium', description: 'Deep reasoning for complex planning and debugging' },
      { id: 'gpt-4o', name: 'OpenAI GPT-4o', harness: this.id, supportsEffort: false, description: 'High-throughput multimodal engineering model' },
    ];
  }

  compileStageArgs(opts: StageCompileOptions): HarnessInvocation {
    const args: string[] = ['exec'];

    if (opts.cwd) {
      args.push('-C', opts.cwd);
    }

    if (opts.model) {
      args.push('-m', opts.model);
    }

    if (opts.effort) {
      args.push('-c', `model_reasoning_effort="${opts.effort}"`);
    }

    if (opts.mode === 'acceptEdits') {
      args.push('-s', 'workspace-write', '--approve-for-me');
    } else {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    args.push('--json');
    args.push(opts.prompt);

    return {
      command: this.defaultBinary,
      args,
      env: {},
    };
  }

  compileAuditArgs(opts: { prompt: string; model: string; effort?: string; cwd?: string }): HarnessInvocation {
    const args: string[] = ['exec'];
    if (opts.cwd) args.push('-C', opts.cwd);
    if (opts.model) args.push('-m', opts.model);
    if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
    args.push('-s', 'read-only', '--json', opts.prompt);
    return { command: this.defaultBinary, args, env: {} };
  }

  parseOutput(stdoutText: string, stderrText: string): HarnessResult {
    const denials: Array<{ tool: string; detail: string; rule: string }> = [];
    let text = '';
    let rateLimitedUntil: Date | null = null;
    let rawJson: Record<string, unknown> | undefined;

    // Codex outputs JSONL events when run with --json
    const lines = stdoutText.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        rawJson = event;

        // Capture assistant message delta / text
        if (event.type === 'message' || event.type === 'response') {
          if (typeof event.content === 'string') {
            text = event.content;
          } else if (event.message?.content) {
            text = String(event.message.content);
          }
        } else if (event.type === 'tool_denial' || event.action === 'denied') {
          denials.push({
            tool: String(event.tool || 'command'),
            detail: String(event.command || event.detail || ''),
            rule: String(event.rule || 'sandbox-policy'),
          });
        } else if (event.error?.code === 'rate_limit_exceeded' || event.code === 'rate_limit') {
          rateLimitedUntil = new Date(Date.now() + 5 * 60 * 1000);
        }
      } catch {
        // Non-JSON line, keep as plain text fallback
        if (!text) text = line;
      }
    }

    if (!text && stdoutText.trim()) {
      text = stdoutText.trim();
    }

    return {
      text,
      exitCode: stderrText.length > 0 && !stdoutText ? 1 : 0,
      denials,
      rateLimitedUntil,
      rawJson,
    };
  }
}
