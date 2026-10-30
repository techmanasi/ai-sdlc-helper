// The pipeline command: one SDLC run (Spec to Ship) for a backlog item, in a project checkout.
import path from 'node:path';
import { runPipeline } from '../pipeline/run.js';
import { parseArgs } from './args.js';
import type { Io } from './main.js';

export const PIPELINE_COMMANDS = ['pipeline'];
export const PIPELINE_VALUED = ['--from', '--cwd', '--agent'];
export const PIPELINE_FLAGS: string[] = [];

export const PIPELINE_USAGE = `  pipeline [slug] [--from spec|plan|red-tests|implement|test-repair|review|finalise] [--agent claude|agy|codex] [--cwd <checkout>]
                                   run the SDLC pipeline for a backlog item (default: the first pending one) in the
                                   checkout (default: the current folder); FROM=<stage> in the environment works too.
                                   Exit 0 finalised, 1 failed, 2 paused (questions to answer, refused actions to decide)`;

const SIGNALS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

/** Runs `pipeline` (<argv> starts with it). Returns the exit code; a signal stops the agent and fails the run. */
export async function pipeline(argv: string[], valued: string[], io: Io): Promise<number> {
  const a = parseArgs(argv, valued);
  const [, slug, extra] = a.positional;
  if (extra !== undefined) { io.err(`ERROR: pipeline takes one slug, got: ${a.positional.slice(1).join(' ')}`); return 2; }
  for (const o of ['--from', '--cwd', '--agent']) if (a.value(o) === '') { io.err(`ERROR: ${o} needs a value`); return 2; }
  const agentVal = a.value('--agent');
  if (agentVal && !['claude', 'agy', 'codex'].includes(agentVal)) {
    io.err(`ERROR: --agent must be one of claude, agy, codex (got ${agentVal})`);
    return 2;
  }
  const cwd = path.resolve(io.cwd || process.cwd(), a.value('--cwd') || '.');
  const controller = new AbortController();
  let signalled = 0;
  const handlers = Object.entries(SIGNALS).map(([name, n]) => {
    const h = () => { signalled = 128 + n; controller.abort(); };
    process.on(name, h);
    return () => process.off(name, h);
  });
  try {
    const code = await runPipeline({
      cwd, slug, from: a.value('--from'), agent: agentVal as any, env: io.env || process.env, out: l => io.out(l), err: l => io.err(l), signal: controller.signal,
    });
    return signalled || code;
  } finally {
    for (const off of handlers) off();
  }
}
