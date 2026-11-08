import fs from 'node:fs';
import { spawn } from 'node:child_process';

export interface AgentRequest {
  command?: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: string;
  stderr: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type AgentSpawn = (req: AgentRequest) => Promise<number>;

const timeoutOf = (req: AgentRequest): number => {
  const value = req.timeoutMs ?? Number(req.env.SDLC_AGENT_TIMEOUT_MS || 0);
  return Number.isFinite(value) && value > 0 ? value : 30 * 60 * 1000;
};

/** Agent-neutral child-process supervision for non-interactive CLIs. */
export const spawnAgentProcess: AgentSpawn = req => new Promise(resolve => {
  let out = -1;
  let err = -1;
  try {
    out = fs.openSync(req.stdout, 'w');
    err = req.stderr === req.stdout ? out : fs.openSync(req.stderr, 'w');
  } catch (e) {
    try { if (out >= 0) fs.closeSync(out); } catch { /* ignore */ }
    resolve(127);
    return;
  }
  let done = false;
  let timer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let forcedCode: number | undefined;
  let abortListener: (() => void) | undefined;
  const finish = (code: number) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    if (abortListener) req.signal?.removeEventListener('abort', abortListener);
    fs.closeSync(out);
    if (err !== out) fs.closeSync(err);
    resolve(forcedCode ?? code);
  };
  const terminate = () => {
    if (!child || done) return;
    if (forcedCode !== undefined) return;
    forcedCode = 1;
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    forceTimer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* already exited */ } }, 1000);
    forceTimer.unref?.();
  };
  try {
    child = spawn(req.command || 'claude', req.args, { cwd: req.cwd, env: req.env, stdio: ['pipe', out, err] });
    child.stdin?.end();
    child.on('error', e => { try { fs.writeSync(err, `${e.message}\n`); } catch { /* closed */ } finish(127); });
    child.on('close', code => finish(code === null ? 1 : code));
    abortListener = terminate;
    req.signal?.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(() => {
      try { fs.writeSync(err, `agent process timed out after ${timeoutOf(req)}ms\n`); } catch { /* closed */ }
      terminate();
    }, timeoutOf(req));
    timer.unref?.();
    if (req.signal?.aborted) terminate();
  } catch (e) {
    try { fs.writeSync(err, `${e instanceof Error ? e.message : String(e)}\n`); } catch { /* closed */ }
    finish(127);
  }
});

export const spawnClaude = spawnAgentProcess;
