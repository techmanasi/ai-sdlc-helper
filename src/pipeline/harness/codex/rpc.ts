import { spawn } from 'node:child_process';
import { which } from '../../../shell.js';
import type { HarnessModel } from '../types.js';

export interface CodexAppServerModel {
  id: string;
  model: string;
  displayName?: string;
  description?: string;
  supportedReasoningEfforts?: Array<{ effort: string; description?: string }>;
  defaultReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  isDefault?: boolean;
  hidden?: boolean;
}

export interface QueryCodexAppServerOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  binaryPath?: string;
}

/**
 * Queries the running or local `codex app-server` via JSON-RPC 2.0 stdio
 * to obtain the authenticated model catalog for the active session.
 */
export async function queryCodexAppServerModels(
  opts: QueryCodexAppServerOptions = {},
): Promise<HarnessModel[] | null> {
  const timeoutMs = opts.timeoutMs ?? 3500;
  const env = opts.env || process.env;
  const bin = opts.binaryPath || which('codex', { env }) || 'codex';

  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    let buffer = '';

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (proc) {
        try {
          proc.stdin?.end();
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        // Force kill if still open after short grace period
        const p = proc;
        setTimeout(() => {
          try {
            p.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, 500).unref?.();
        proc = null;
      }
    };

    const finish = (result: HarnessModel[] | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    try {
      proc = spawn(bin, ['app-server'], {
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      return finish(null);
    }

    timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    proc.on('error', () => {
      finish(null);
    });

    proc.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            // Handshake initialized; request model list
            proc?.stdin?.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'model/list',
                params: {},
              }) + '\n',
            );
          } else if (msg.id === 2) {
            if (msg.error) {
              return finish(null);
            }
            const rawModels: CodexAppServerModel[] = Array.isArray(msg.result?.data)
              ? msg.result.data
              : [];

            const models: HarnessModel[] = rawModels
              .filter((m) => !m.hidden)
              .map((m) => ({
                id: m.id || m.model,
                name: m.displayName || m.id || m.model,
                harness: 'codex',
                supportsEffort:
                  Array.isArray(m.supportedReasoningEfforts) &&
                  m.supportedReasoningEfforts.length > 0,
                defaultEffort: m.defaultReasoningEffort,
                description: m.description,
              }));

            return finish(models.length > 0 ? models : null);
          }
        } catch {
          /* ignore non-JSON logging from CLI */
        }
      }
    });

    // Send initialize request
    try {
      proc.stdin?.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'ai-sdlc-helper', version: '1.0' } },
        }) + '\n',
      );
    } catch {
      finish(null);
    }
  });
}
