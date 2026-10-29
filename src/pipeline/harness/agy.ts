import { which } from '../../shell.js';
import type { AgentHarness, HarnessDetection, HarnessInvocation, HarnessModel, HarnessResult, StageCompileOptions } from './types.js';

export class AgyHarness implements AgentHarness {
  readonly id = 'agy' as const;
  readonly name = 'Google Antigravity CLI';
  readonly defaultBinary = 'agy';

  async detect(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetection> {
    const bin = which(this.defaultBinary, { env });
    if (!bin) {
      return { installed: false, error: 'agy binary not found on PATH' };
    }
    return { installed: true, path: bin };
  }

  async listModels(_env: NodeJS.ProcessEnv = process.env): Promise<HarnessModel[]> {
    return [
      { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)', harness: this.id, supportsEffort: true, defaultEffort: 'high', description: 'Recommended: extreme speed, high reasoning, 1M context' },
      { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)', harness: this.id, supportsEffort: true, defaultEffort: 'medium', description: 'Balanced speed and reasoning' },
      { id: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro', harness: this.id, supportsEffort: true, defaultEffort: 'high', description: 'Deep reasoning for complex architectural refactoring' },
      { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', harness: this.id, supportsEffort: true, defaultEffort: 'medium', description: 'Open-weight foundation model via Antigravity runtime' },
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
      args.push('--mode', 'accept-edits');
    }

    if (opts.allowedCommands.length > 0) {
      const perms = opts.allowedCommands.map(cmd => `command(${cmd})`);
      args.push('--settings', JSON.stringify({ permissions: { allow: perms } }));
    }

    args.push('--output-format', 'json');

    return {
      command: this.defaultBinary,
      args,
      env: {},
    };
  }

  compileAuditArgs(opts: { prompt: string; model: string; effort?: string; cwd?: string }): HarnessInvocation {
    const args: string[] = ['-p', opts.prompt, '--output-format', 'json'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    return { command: this.defaultBinary, args, env: {} };
  }

  parseOutput(stdoutText: string, stderrText: string): HarnessResult {
    const denials: Array<{ tool: string; detail: string; rule: string }> = [];
    let text = stdoutText;
    let rateLimitedUntil: Date | null = null;
    let rawJson: Record<string, unknown> | undefined;

    try {
      rawJson = JSON.parse(stdoutText);
      if (rawJson && typeof rawJson.response === 'string') {
        text = rawJson.response;
      }
      if (rawJson && Array.isArray(rawJson.denied_actions)) {
        for (const action of rawJson.denied_actions) {
          denials.push({
            tool: String(action.tool || 'command'),
            detail: String(action.detail || action.command || ''),
            rule: String(action.rule || ''),
          });
        }
      }
      if (rawJson && (rawJson.status === 'RATE_LIMITED' || rawJson.status === 'QUOTA_EXCEEDED')) {
        rateLimitedUntil = new Date(Date.now() + 5 * 60 * 1000);
      }
    } catch {
      // Not JSON output
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
