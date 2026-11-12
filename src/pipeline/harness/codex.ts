import { which } from '../../shell.js';
import type { AgentHarness, HarnessDetection, HarnessInvocation, HarnessModel, HarnessResult, ModelCatalogAdapter, StageCompileOptions } from './types.js';
import { defaultCodexCatalog, CodexModelCatalogAdapter, STATIC_CODEX_MODELS } from './codex/catalog.js';

export { defaultCodexCatalog, CodexModelCatalogAdapter, STATIC_CODEX_MODELS };

export class CodexHarness implements AgentHarness {
  readonly id = 'codex' as const;
  readonly name = 'OpenAI Codex CLI';
  readonly defaultBinary = 'codex';
  readonly catalog: ModelCatalogAdapter;
  /** Codex model ids go to the CLI as they are: no provider indirection. */
  readonly ownsModelIds = true;

  constructor(catalog: ModelCatalogAdapter = defaultCodexCatalog) {
    this.catalog = catalog;
  }

  selectStageModel(opts: { configuredModel?: string; configuredEffort?: string }): { model: string; effort?: string } {
    return { model: opts.configuredModel || '', effort: opts.configuredEffort };
  }

  async detect(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetection> {
    const bin = which(this.defaultBinary, { env });
    if (!bin) {
      return { installed: false, error: 'codex binary not found on PATH' };
    }
    return { installed: true, path: bin };
  }

  async listModels(env: NodeJS.ProcessEnv = process.env): Promise<HarnessModel[]> {
    return this.catalog.listModels(env);
  }

  /**
   * Compiles stage arguments for Codex CLI.
   *
   * Permission Architecture Mapping:
   * - Claude CLI accepts granular command whitelists via `--allowedTools <tool1> <tool2> ...`
   *   and execution modes (`acceptEdits` vs `bypassPermissions`).
   * - Antigravity CLI (`agy`) accepts `--settings {"permissions":{"allow":["command(...)"]}}`
   *   and `--mode accept-edits` or `--dangerously-skip-permissions`.
   * - OpenAI Codex CLI does not support arbitrary per-command CLI whitelist flags. Instead,
   *   permissions and sandbox policies are mapped as follows:
   *   1) When `mode === 'acceptEdits'`: Codex runs with `--approve-for-me`, routing approval requests
   *      through automatic review within its `workspace-write` sandbox.
   *   2) When `mode !== 'acceptEdits'` (e.g. `bypassPermissions`): Codex runs with
   *      `--dangerously-bypass-approvals-and-sandbox` to allow operations on protected files/paths.
   *   3) For read-only stages (audit): Codex runs with `-s read-only`.
   *   4) Tool/command denials and sandbox policy violations are emitted in the JSONL stream as
   *      `tool_denial`, `action: denied`, `approval.rejected`, or `command_execution` failure events.
   *      These are extracted and tracked by `extract()` and `CodexHarness.parseOutput()`.
   */
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
      args.push('--approve-for-me');
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

  compileAuditArgs(opts: { prompt: string; model?: string; effort?: string; cwd?: string }): HarnessInvocation {
    const args: string[] = ['exec'];
    if (opts.cwd) args.push('-C', opts.cwd);
    if (opts.model) args.push('-m', opts.model);
    if (opts.effort) args.push('-c', `model_reasoning_effort="${opts.effort}"`);
    args.push('-s', 'read-only', '--json', opts.prompt);
    return { command: this.defaultBinary, args, env: {} };
  }

  parseOutput(stdoutText: string, stderrText: string): HarnessResult {
    const denials: Array<{ tool: string; detail: string; rule: string }> = [];
    const messages: string[] = [];
    const deltaParts: string[] = [];
    let rateLimitedUntil: Date | null = null;
    let rawJson: Record<string, unknown> | undefined;

    // Codex outputs JSONL events when run with --json
    const lines = stdoutText.split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        rawJson = event;

        // 1. Capture assistant messages across variations:
        // - Modern Codex CLI: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
        if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
          const item = event.item as Record<string, unknown>;
          const itemType = item.type;
          if (itemType === 'agent_message' || itemType === 'message') {
            if (typeof item.text === 'string' && item.text) {
              messages.push(item.text);
            } else if (typeof item.content === 'string' && item.content) {
              messages.push(item.content);
            } else if (Array.isArray(item.content)) {
              const str = item.content
                .map((c: unknown) => (typeof c === 'string' ? c : (c as Record<string, unknown>)?.text || ''))
                .join('');
              if (str) messages.push(str);
            }
          }
        } else if (event.type === 'message' || event.type === 'response') {
          // - Standard / legacy message events
          if (typeof event.content === 'string' && event.content) {
            messages.push(event.content);
          } else if (typeof event.message?.content === 'string' && event.message.content) {
            messages.push(event.message.content);
          } else if (Array.isArray(event.content)) {
            const str = event.content
              .map((c: unknown) => (typeof c === 'string' ? c : (c as Record<string, unknown>)?.text || ''))
              .join('');
            if (str) messages.push(str);
          } else if (Array.isArray(event.message?.content)) {
            const str = event.message.content
              .map((c: unknown) => (typeof c === 'string' ? c : (c as Record<string, unknown>)?.text || ''))
              .join('');
            if (str) messages.push(str);
          } else if (typeof event.text === 'string' && event.text) {
            messages.push(event.text);
          }
        } else if (event.type === 'item.delta' || event.type === 'content_block_delta' || event.type === 'message_delta') {
          // - Streaming deltas (exclude reasoning deltas)
          const evType = String(event.type || '');
          const itemObj = (event.item && typeof event.item === 'object' ? event.item : {}) as Record<string, unknown>;
          const deltaObj = (event.delta && typeof event.delta === 'object' ? event.delta : {}) as Record<string, unknown>;
          if (!evType.includes('reasoning') && itemObj.type !== 'reasoning' && deltaObj.type !== 'reasoning') {
            const delta = typeof event.delta === 'string'
              ? event.delta
              : typeof deltaObj.text === 'string'
              ? deltaObj.text
              : typeof (itemObj.delta as Record<string, unknown>)?.text === 'string'
              ? (itemObj.delta as Record<string, unknown>).text
              : '';
            if (delta) deltaParts.push(String(delta));
          }
        }

        // 2. Capture tool denials, approval rejections, and sandbox policy violations
        if (
          event.type === 'tool_denial' ||
          event.action === 'denied' ||
          event.type === 'permission_denial' ||
          event.type === 'approval.rejected' ||
          (event.type === 'item.completed' &&
            (event.item as Record<string, unknown>)?.type === 'command_execution' &&
            ((event.item as Record<string, unknown>).status === 'denied' ||
              ((event.item as Record<string, unknown>).exit_code === 126 &&
                /denied/i.test(String((event.item as Record<string, unknown>).aggregated_output || ''))))) ||
          (event.type === 'command_execution' && (event.status === 'denied' || event.status === 'rejected'))
        ) {
          const itemObj = (event.item && typeof event.item === 'object' ? event.item : {}) as Record<string, unknown>;
          const toolInput = (event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {}) as Record<string, unknown>;
          let tool = String(event.tool || event.tool_name || (itemObj.type === 'command_execution' ? 'Bash' : itemObj.type) || 'command');
          const detail = String(event.command || event.detail || itemObj.command || toolInput.command || toolInput.file_path || '');
          if (tool === 'command') tool = 'Bash';
          denials.push({
            tool,
            detail,
            rule: String(event.rule || itemObj.rule || 'sandbox-policy'),
          });
        }

        // 3. Capture rate limits and quota exhaustion
        const errObj = (event.error && typeof event.error === 'object' ? event.error : {}) as Record<string, unknown>;
        if (
          errObj.code === 'rate_limit_exceeded' ||
          event.code === 'rate_limit' ||
          errObj.type === 'rate_limit_error' ||
          errObj.code === 'insufficient_quota' ||
          errObj.code === 'quota_exceeded' ||
          event.code === 'quota_exceeded' ||
          event.status === 'RATE_LIMITED' ||
          event.status === 'QUOTA_EXCEEDED' ||
          (typeof errObj.message === 'string' && /rate limit|insufficient_quota|quota exceeded/i.test(errObj.message))
        ) {
          rateLimitedUntil = new Date(Date.now() + 5 * 60 * 1000);
        }
      } catch {
        // Non-JSON line, keep as plain text fallback
        if (messages.length === 0 && deltaParts.length === 0) {
          messages.push(line);
        }
      }
    }

    let text = messages.length > 0 ? messages.join('\n\n') : deltaParts.join('');
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
