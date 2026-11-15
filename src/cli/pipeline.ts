// The pipeline command: one SDLC run (Spec to Finalise) for a backlog item, in a project checkout.
import path from 'node:path';
import { alive } from '../runs/records.js';
import { forceOf } from '../config/settings.js';
import { runPipeline } from '../pipeline/run.js';
import { parseArgs } from './args.js';
import type { Io } from './main.js';

export const PIPELINE_COMMANDS = ['pipeline'];
export const PIPELINE_VALUED = ['--from', '--cwd', '--agent', '--model', '--effort'];
export const PIPELINE_FLAGS: string[] = [];

export const PIPELINE_USAGE = `  pipeline [slug] [--from spec|plan|red-tests|implement|test-repair|review|finalise] [--agent claude|agy|codex]
           [--model <model>] [--effort low|medium|high|xhigh|max] [--cwd <checkout>]
                                   run the SDLC pipeline for a backlog item (default: the first pending one) in the
                                   checkout (default: the current folder); FROM=<stage> in the environment works too.
                                   --agent, --model and --effort (or SDLC_FORCE_AGENT, SDLC_FORCE_MODEL, SDLC_FORCE_EFFORT) apply
                                   to every stage of this run and win over the project's settings (--agent=codex works too).
                                   Exit 0 finalised, 1 failed, 2 paused (questions to answer, refused actions to decide)`;

const SIGNALS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };

/** Runs `pipeline` (<argv> starts with it). Returns the exit code; a signal stops the agent and fails the run. */
export async function pipeline(argv: string[], valued: string[], io: Io): Promise<number> {
  const a = parseArgs(argv, valued);
  const [, slug, extra] = a.positional;
  if (extra !== undefined) { io.err(`ERROR: pipeline takes one slug, got: ${a.positional.slice(1).join(' ')}`); return 2; }
  for (const o of ['--from', '--cwd', '--agent', '--model', '--effort']) if (a.value(o) === '') { io.err(`ERROR: ${o} needs a value`); return 2; }
  const { force, problem } = forceOf(n => a.value(n), io.env || process.env);
  if (problem) { io.err(`ERROR: ${problem}`); return 2; }
  const cwd = path.resolve(io.cwd || process.cwd(), a.value('--cwd') || '.');
  const controller = new AbortController();
  let signalled = 0;
  let signalName = '';
  const handlers = Object.entries(SIGNALS).map(([name, n]) => {
    const h = () => { if (!signalled) { signalled = 128 + n; signalName = name; } controller.abort(); };
    process.on(name, h);
    return () => process.off(name, h);
  });
  // Started by a run supervisor (SDLC_SUPERVISOR_PID): when it is killed from outside, nothing is left to record this
  // run or stop it, so the run stops itself. A pipeline started from a terminal has no such variable and is not watched.
  const env = io.env || process.env;
  let gone = 0;
  const supervisor = Number(env.SDLC_SUPERVISOR_PID);
  let watch: NodeJS.Timeout | undefined;
  if (Number.isInteger(supervisor) && supervisor > 1) {
    const parent = process.ppid;
    const lost = () => !alive(supervisor) || (process.ppid !== parent && process.ppid !== supervisor);
    const every = Number(env.SDLC_SUPERVISOR_CHECK_MS) > 0 ? Number(env.SDLC_SUPERVISOR_CHECK_MS) : 5000;
    watch = setInterval(() => { if (!gone && lost()) { gone = supervisor; controller.abort(); } }, every);
    watch.unref();
  }
  try {
    const code = await runPipeline({
      cwd, slug, from: a.value('--from'), agent: force.agent as any, model: force.model, effort: force.effort, env: io.env || process.env, out: l => io.out(l), err: l => io.err(l), signal: controller.signal, stoppedBy: () => (signalled ? { name: signalName, code: signalled } : gone ? { name: 'supervisor', code: 1, line: stage => `supervisor ${gone} is gone: stopping the run (it was killed from outside) during ${stage}` } : undefined),
    });
    return signalled || (gone ? 1 : code);
  } finally {
    if (watch) clearInterval(watch);
    for (const off of handlers) off();
  }
}
