import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG_FILE, exists, type Json } from '../util.js';
import { codeIndexers, codeSearchErrors, codeSearchFor, onPath, runnableBuild, unavailable } from './codeSearch.js';

export type OpStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'timeout';
export interface SetupOperation {
  status: OpStatus;
  indexer: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  error: string | null;
  output: string[];
}
export const SETUP_INDEXERS = ['graft', 'graphify'] as const;

const MAX_LINES = 100;
const MAX_BYTES = 32 * 1024;
// Starting a freshly written executable can take several hundred ms; a shorter limit would only kill healthy builds.
const MIN_TIMEOUT_MS = 1500;

export class SetupError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

const idle = (): SetupOperation => ({ status: 'idle', indexer: null, startedAt: null, endedAt: null, exitCode: null, error: null, output: [] });

/** The project's settings file as JSON: lenient (malformed or invalid code search settings read as empty). */
function readFileLenient(root: string): Json {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
    if (!file || typeof file !== 'object' || Array.isArray(file)) return {};
    return codeSearchErrors(file).length ? {} : file;
  } catch { return {}; }
}

export function inspectCodeSearch(root: string, env: NodeJS.ProcessEnv) {
  const file = readFileLenient(root);
  const all = codeIndexers(file);
  const found = codeSearchFor(root, file, env);
  return {
    configured: (file.agent && file.agent.codeSearch) || 'auto',
    active: { codeSearch: found.codeSearch, indexer: found.indexer ? found.indexer.name : null, warning: found.warning },
    indexers: SETUP_INDEXERS.filter(name => all[name]).map(name => {
      const ix = all[name];
      return {
        name,
        command: ix.command || '',
        installed: Boolean(ix.command && onPath(ix.command, env)),
        index: ix.index || '',
        indexed: Boolean(ix.index && exists(path.join(root, ix.index))),
        build: ix.build || '',
        setup: ix.setup || '',
        runnable: runnableBuild(ix) !== null,
      };
    }),
  };
}

export interface CodeSetup {
  operation(root: string): SetupOperation;
  start(root: string, indexer: unknown): SetupOperation;
}

export function createCodeSetup(opts: { env: NodeJS.ProcessEnv; timeoutMs?: number; killGraceMs?: number }): CodeSetup {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const operations = new Map<string, SetupOperation>();

  const operation = (root: string): SetupOperation => {
    const op = operations.get(root);
    return op ? { ...op, output: [...op.output] } : idle();
  };

  function start(root: string, indexer: unknown): SetupOperation {
    if (typeof indexer !== 'string' || !(SETUP_INDEXERS as readonly string[]).includes(indexer)) {
      throw new SetupError(400, "indexer must be 'graft' or 'graphify'");
    }
    const configFile = path.join(root, CONFIG_FILE);
    let file: Json = {};
    if (fs.existsSync(configFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        file = parsed;
      } catch { throw new SetupError(400, 'sdlc.config.json is not valid JSON; fix it first'); }
    }
    const ix = codeIndexers(codeSearchErrors(file).length ? {} : file)[indexer];
    if (!ix.command || !onPath(ix.command, opts.env)) {
      throw new SetupError(400, `${indexer} is not installed (no ${ix.command || '?'} command)`, { setup: ix.setup || '' });
    }
    const run = runnableBuild(ix);
    if (!run) throw new SetupError(400, `${indexer} has no build command defined`, { setup: ix.setup || '' });
    const current = operations.get(root);
    if (current && current.status === 'running') {
      throw new SetupError(409, 'a code indexer build is already in progress for this project');
    }

    const op: SetupOperation = { ...idle(), status: 'running', indexer, startedAt: new Date().toISOString() };
    operations.set(root, op);
    const lines: string[] = [];
    let partial = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const trim = () => {
      while (lines.length > MAX_LINES) lines.shift();
      while (lines.length > 1 && Buffer.byteLength(lines.join('\n')) > MAX_BYTES) lines.shift();
      op.output = [...lines];
    };
    const feed = (chunk: Buffer) => {
      const parts = (partial + chunk.toString('utf8')).split(/\r?\n/);
      partial = parts.pop() || '';
      lines.push(...parts);
      trim();
    };
    const finish = (status: OpStatus, error: string | null, exitCode: number | null = op.exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (partial) { lines.push(partial); partial = ''; trim(); }
      op.status = status;
      op.error = error;
      op.exitCode = exitCode;
      op.endedAt = new Date().toISOString();
    };

    const child = spawn(run.program, run.args, { cwd: root, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    // The limit counts from the moment the process is running, not from the request for it.
    let timer: NodeJS.Timeout | undefined;
    child.on('spawn', () => {
      if (settled) return;
      timer = setTimeout(() => {
        // A process that already exited is waiting only for its output to drain; let close decide.
        if (settled || child.exitCode !== null || child.signalCode !== null) return;
        finish('timeout', 'Build timed out after 10 minutes');
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { child.kill('SIGKILL'); }, killGraceMs);
      }, Math.max(timeoutMs, MIN_TIMEOUT_MS));
    });
    child.on('error', e => { clearTimeout(killTimer); finish('failed', `Could not start ${run.program}: ${e.message}`); });
    child.on('close', code => {
      clearTimeout(killTimer);
      if (settled) return;
      if (code !== 0) return finish('failed', `Build failed with exit code ${code}`, code);
      if (unavailable(ix, root, opts.env)) return finish('failed', 'Build exited successfully, but index files were not found', 0);
      try {
        const next = { ...file, agent: { ...(file.agent || {}), codeSearch: indexer } };
        fs.writeFileSync(configFile, JSON.stringify(next, null, 2) + '\n');
      } catch (e) {
        return finish('failed', `Index was built successfully, but saving configuration to sdlc.config.json failed: ${(e as Error).message}`, 0);
      }
      finish('succeeded', null, 0);
    });
    return operation(root);
  }

  return { operation, start };
}
