// The run controls: start, stop, restart, discard, status and watch, and the run forms of `changes` (changes <slug>,
// changes --all), for pipelines that run in their own worktrees.
import { gitRoot, projectDir } from '../registry/projects.js';
import { SLUG, STAGES } from '../runs/records.js';
import { forceOf } from '../config/settings.js';
import {
  allChanges, discard, restart, runChanges, runContext, runWorktree, start, statusLines, statusRecords, stillGoing, stop, watchDir, watchFrame,
  type Outcome, type RunContext,
} from '../runs/index.js';
import type { ParsedArgs } from './args.js';
import type { Io } from './main.js';

export const RUNS_COMMANDS = ['start', 'stop', 'restart', 'discard', 'status', 'watch'];
export const RUNS_VALUED = ['--from', '--project', '--agent', '--model', '--effort'];
export const RUNS_FLAGS = ['--follow', '--stop', '--all'];

export const RUNS_USAGE = `
  start <slug> [--from <stage>] [--agent <agent>] [--model <model>] [--effort <effort>] [--project <name>]
                                   start (or resume) the pipeline of a backlog item in its own worktree and branch;
                                   exit 3 too many running, 4 already running, 5 already merged
  stop <slug>                      interrupt a running pipeline and everything it started
  restart <slug> [--from <stage>] [--agent <agent>] [--model <model>] [--effort <effort>] [--yes]
                                   stop, discard and start again from scratch (without --yes: show what goes, exit 6)
  discard <slug> [--yes] [--stop]  delete its worktree, branch and run record; the branch tip is saved first
  status [--json]                  one line per recorded run
  watch <slug> [--follow [seconds]]
                                   its status.json, run state, uncommitted files and the end of run.out;
                                   --follow refreshes (every 3 s) until the run ends
  changes <slug> [--json] | changes --all [<slug>...]
                                   files a pipeline changed in its worktree: "<changed> <uncommitted>", or JSON
  (stages: ${STAGES.join(', ')}; the run commands take --project <name>)`;

const USAGE_LINE = 'Usage: ai-sdlc-helper start|stop|restart|discard|watch <slug> ... | status [--json]';

const print = (io: Io, o: Outcome): number => {
  for (const l of o.out) io.out(l);
  for (const l of o.err) io.err(l);
  return o.code;
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The run context for --project <name> (or the project holding the current folder). */
function context(a: ParsedArgs, io: Io): RunContext {
  const env = io.env || process.env;
  return runContext(projectDir(a.value('--project'), io.cwd || process.cwd(), env), env);
}

const badSlug = (io: Io, slug: string | undefined): boolean => {
  if (slug === undefined) { io.err(USAGE_LINE); return true; }
  if (!SLUG.test(slug)) { io.err(`Invalid slug '${slug}': lowercase letters, digits and dashes only`); return true; }
  return false;
};

/** Runs one of RUNS_COMMANDS. Returns the exit code (2 for a usage error). */
export async function runs(a: ParsedArgs, io: Io): Promise<number> {
  const env = io.env || process.env;
  const [cmd, slug, ...extra] = a.positional;
  if (a.value('--project') === '') { io.err('ERROR: --project needs a value'); return 2; }
  const from = a.value('--from') ?? (env.FROM || undefined);
  if (from !== undefined && !(STAGES as readonly string[]).includes(from)) {
    io.err(`ERROR: --from must be one of ${STAGES.join(', ')}${a.value('--from') === undefined ? ` (from FROM=${from})` : ''}`);
    return 2;
  }
  // The run's own agent, model and effort come from the flags only: SDLC_FORCE_* in the shell reaches the pipeline as it is.
  for (const o of ['--agent', '--model', '--effort']) if (a.value(o) === '') { io.err(`ERROR: ${o} needs a value`); return 2; }
  const { force, problem } = forceOf(n => a.value(n), {});
  if (problem) { io.err(`ERROR: ${problem}`); return 2; }
  if (Object.keys(force).length && cmd !== 'start' && cmd !== 'restart') { io.err('ERROR: --agent, --model and --effort go with start and restart'); return 2; }
  try {
    if (cmd === 'status') {
      if (slug !== undefined) { io.err(USAGE_LINE); return 2; }
      const ctx = context(a, io);
      if (a.flag('--json')) io.out(JSON.stringify(statusRecords(ctx)));
      else for (const l of statusLines(ctx)) io.out(l);
      return 0;
    }
    if (badSlug(io, slug)) return 2;
    if (extra.length && !(cmd === 'watch' && a.flag('--follow') && extra.length === 1)) { io.err(USAGE_LINE); return 2; }
    const ctx = context(a, io);
    switch (cmd) {
      case 'start': return print(io, start(ctx, slug, { from, force }));
      case 'stop': return print(io, await stop(ctx, slug));
      case 'restart': return print(io, await restart(ctx, slug, { from, force, yes: a.flag('--yes') }));
      case 'discard': return print(io, await discard(ctx, slug, { yes: a.flag('--yes'), stop: a.flag('--stop') }));
      default: { // watch
        const seconds = extra[0] === undefined ? 3 : Number(extra[0]);
        if (!/^\d+(\.\d+)?$/.test(extra[0] ?? '3') || !(seconds > 0)) { io.err(`Invalid interval '${extra[0]}': a positive number of seconds`); return 2; }
        const here = gitRoot(io.cwd || process.cwd(), env) || io.cwd || process.cwd();
        const dir = watchDir(ctx, slug, here);
        if (!dir) { io.err(`No pipeline for ${slug}`); return 1; }
        if (!a.flag('--follow')) { for (const l of watchFrame(ctx, slug, dir)) io.out(l); return 0; }
        for (;;) {
          const going = stillGoing(ctx, slug); // read before the frame, so the last frame shows how the run ended
          io.out(`\x1b[H\x1b[2J${watchFrame(ctx, slug, dir).join('\n')}`);
          if (!going) return 0;
          await sleep(seconds * 1000);
        }
      }
    }
  } catch (e) {
    io.err(`ERROR: ${(e as Error).message}`);
    return 1;
  }
}

/**
 * `changes <slug> [--json]` and `changes --all [<slug>...]`: the files a pipeline changed in its own worktree.
 * <a> is the parsed command line, `changes` first.
 */
export function runsChanges(a: ParsedArgs, io: Io): number {
  const slugs = a.positional.slice(1);
  try {
    if (a.flag('--all')) {
      const bad = slugs.find(s => !SLUG.test(s));
      if (bad) { io.err(`Invalid slug '${bad}': lowercase letters, digits and dashes only`); return 2; }
      io.out(JSON.stringify({ runs: allChanges(context(a, io), slugs) }));
      return 0;
    }
    if (slugs.length !== 1) { io.err('Usage: ai-sdlc-helper changes <slug> [--json] | changes --all [<slug>...]'); return 2; }
    const [slug] = slugs;
    if (badSlug(io, slug)) return 2;
    const c = runChanges(context(a, io), slug);
    if ('error' in c) { io.err(c.error); return 1; }
    io.out(a.flag('--json')
      ? JSON.stringify({ slug, worktree: c.worktree, changed: c.changed, uncommitted: c.uncommitted, files: c.files.slice(0, 50) })
      : `${c.changed} ${c.uncommitted}`);
    return 0;
  } catch (e) {
    io.err(`ERROR: ${(e as Error).message}`);
    return 1;
  }
}

/** The checkout holding <slug>'s run, for permit: its worktree when it has one, else null. */
export function runCheckout(dir: string, slug: string, env: NodeJS.ProcessEnv): string | null {
  try {
    return runWorktree(runContext(dir, env), slug);
  } catch {
    return null;
  }
}
