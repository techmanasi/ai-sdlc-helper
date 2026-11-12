import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { which } from '../../shell.js';
import type { AgentHarness, HarnessDetection, HarnessInvocation, HarnessModel, HarnessResult, StageCompileOptions } from './types.js';

export class AgyHarness implements AgentHarness {
  readonly id = 'agy' as const;
  readonly name = 'Google Antigravity CLI';
  readonly defaultBinary = 'agy';
  /** Gemini ids go to the CLI as they are: no provider indirection. */
  readonly ownsModelIds = true;

  selectStageModel(opts: { configuredModel?: string; configuredEffort?: string }): { model: string; effort?: string } {
    return { model: opts.configuredModel || '', effort: opts.configuredEffort };
  }

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
    } else {
      args.push('--dangerously-skip-permissions');
    }

    if (opts.allowedCommands.length > 0) {
      const perms = opts.allowedCommands.map(agyRule);
      args.push('--settings', JSON.stringify({ permissions: { allow: perms } }));
    }

    args.push('--output-format', agyStreamJson(this.defaultBinary) ? 'stream-json' : 'json');

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

  /**
   * A stream-json run leaves one event per line in <file>. Keep that stream beside it (<file>.stream) and replace <file>
   * with the final result, as `--output-format json` prints it, plus the path of each refused tool. Everything that reads
   * the result file then works the same for both formats. A file that is not a stream is left as it is.
   */
  normalizeOutput(file: string): void {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    const result = streamResult(text);
    if (!result) return;
    fs.writeFileSync(file.replace(/\.json$/, '') + '.stream', text);
    fs.writeFileSync(file, JSON.stringify(result));
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
            tool: String(action.tool || action.tool_name || action.action || 'command'),
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

/**
 * A permission rule in agy's words. The pipeline's rules are Claude tool names: a bare "Bash" means every shell command and
 * "Bash(<target>)" one target. agy asks for "command" permissions and only reads command(<target>), with command(*) for
 * every command; a rule such as command(Bash) matches nothing, so the run was refused again after the user allowed it.
 */
export function agyRule(rule: string): string {
  if (rule === 'Bash') return 'command(*)';
  // A refused agy tool other than a command (read_file, write_file, …) is allowed under its own name, for any target.
  if (/^[a-z]+(?:_[a-z]+)+$/.test(rule)) return `${rule}(*)`;
  const target = rule.match(/^Bash\((.*)\)$/);
  return `command(${target ? target[1] : rule})`;
}

const streamSupport = new Map<string, boolean>();

/**
 * Whether this agy prints `--output-format stream-json` (its --help names it). An older agy, or one that cannot be asked,
 * gets `json`: the run then names a refused tool without its path. SDLC_AGY_OUTPUT=json forces `json`.
 */
export function agyStreamJson(bin: string): boolean {
  if (process.env.SDLC_AGY_OUTPUT === 'json') return false;
  let known = streamSupport.get(bin);
  if (known === undefined) {
    try {
      const r = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 10_000 });
      known = /--output-format[^\n]*stream-json/.test(`${r.stdout || ''}${r.stderr || ''}`);
    } catch { known = false; }
    streamSupport.set(bin, known);
  }
  return known;
}

/**
 * The result of an agy stream-json run: the final `result` event, with `detail` (the path) on each denied action, taken from
 * the failed tool steps (`permission check failed for read_file "<path>": …`). Null when the text is not a stream with a result.
 */
export function streamResult(text: string): Record<string, any> | null {
  let result: Record<string, any> | null = null;
  const refused: Array<{ tool: string; path: string }> = [];
  for (const line of text.split('\n').filter(l => l.trim())) {
    let event: any;
    try { event = JSON.parse(line); } catch { return null; }
    if (!event || typeof event !== 'object' || typeof event.event !== 'string') return null;
    if (event.event === 'result' && event.result && typeof event.result === 'object') result = { ...event.result };
    const step = event.step_update;
    const message = step?.state === 'ERROR' ? step?.tool_info?.error?.message : undefined;
    const m = typeof message === 'string' ? /permission check failed for (\w+) "([^"]*)"/.exec(message) : null;
    if (m) refused.push({ tool: m[1], path: m[2] });
  }
  if (!result) return null;
  const denied: Array<Record<string, any>> = Array.isArray(result.denied_actions) ? result.denied_actions.map((a: any) => ({ ...a })) : [];
  for (const r of refused) {
    const open = denied.find(a => (a.action === r.tool || a.tool === r.tool) && !a.detail);
    if (open) open.detail = r.path; else denied.push({ action: r.tool, detail: r.path });
  }
  if (denied.length) result.denied_actions = denied;
  return result;
}
