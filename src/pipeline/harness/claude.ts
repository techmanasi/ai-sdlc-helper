import { which } from '../../shell.js';
import type { AgentHarness, HarnessDetection, HarnessInvocation, HarnessModel, HarnessResult, StageCompileOptions } from './types.js';

export class ClaudeHarness implements AgentHarness {
  readonly id = 'claude' as const;
  readonly name = 'Anthropic Claude Code';
  readonly defaultBinary = 'claude';

  async detect(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetection> {
    const bin = which(this.defaultBinary, { env });
    if (!bin) {
      return { installed: false, error: 'claude binary not found on PATH' };
    }
    return { installed: true, path: bin };
  }

  async listModels(_env: NodeJS.ProcessEnv = process.env): Promise<HarnessModel[]> {
    return [
      { id: 'opus', name: 'Claude Opus 4.6', harness: this.id, supportsEffort: true, defaultEffort: 'medium', description: 'Anthropic flagship reasoning model' },
      { id: 'sonnet', name: 'Claude Sonnet 4.6', harness: this.id, supportsEffort: true, defaultEffort: 'medium', description: 'Fast and capable architectural & coding model' },
      { id: 'haiku', name: 'Claude Haiku 4.5', harness: this.id, supportsEffort: false, description: 'High-speed, low-latency utility model' },
    ];
  }

  compileStageArgs(opts: StageCompileOptions): HarnessInvocation {
    const args: string[] = ['-p', opts.prompt];

    if (opts.model) {
      args.push('--model', opts.model);
    }
    if (opts.effort) {
      args.push('--effort', opts.effort);
    }

    if (opts.mode === 'acceptEdits') {
      args.push('--permission-mode', 'acceptEdits');
    } else {
      args.push('--permission-mode', opts.mode || 'bypass');
    }

    if (opts.allowedCommands.length > 0) {
      args.push('--allowedTools', ...opts.allowedCommands);
    }

    args.push('--output-format', 'json');

    if (opts.maxTurns) {
      args.push('--max-turns', String(opts.maxTurns));
    }

    return {
      command: this.defaultBinary,
      args,
      env: {},
    };
  }

  compileAuditArgs(opts: { prompt: string; model: string; effort?: string; cwd?: string }): HarnessInvocation {
    const args: string[] = ['-p', opts.prompt];
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    args.push('--allowedTools', 'Read', 'Glob', 'Grep', '--max-turns', '15');
    return { command: this.defaultBinary, args, env: {} };
  }

  parseOutput(stdoutText: string, stderrText: string): HarnessResult {
    const denials: Array<{ tool: string; detail: string; rule: string }> = [];
    let text = stdoutText;
    let rateLimitedUntil: Date | null = null;
    let rawJson: Record<string, unknown> | undefined;

    try {
      rawJson = JSON.parse(stdoutText);
      if (rawJson && typeof rawJson.result === 'string') {
        text = rawJson.result;
      }
      if (rawJson && rawJson.api_error === 'usage_limit_reached') {
        rateLimitedUntil = new Date(Date.now() + 5 * 60 * 1000);
      }
    } catch {
      // Not JSON output, keep raw stdout text
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
