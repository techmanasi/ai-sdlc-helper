// The commands for a project's pipeline files: changes, permissions, permit, model and backlog.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exists, readSettings } from '../util.js';
import { changed, mark, mirror, snapshot } from '../changes/index.js';
import { decide, permissionsMain, repoRulesFile } from '../permissions/index.js';
import { modelsMain } from '../models/index.js';
import { backlogMain, backlogPlace } from '../backlog/index.js';
import { projectDir } from '../registry/projects.js';
import { parseArgs } from './args.js';
import { runCheckout, runsChanges } from './runs.js';
import { mainTree, readRecord, registryDir } from '../runs/records.js';
import type { Io } from './main.js';

export const TOOL_COMMANDS = ['changes', 'permissions', 'permit', 'model', 'backlog'];
export const TOOL_VALUED = ['--status', '--endpoint', '--key-env', '--models'];
export const TOOL_FLAGS = ['--effort'];

export const TOOL_USAGE = `
  changes snapshot|mirror|changed <baseline.json>
  changes mark <stage-files.json> [stage]
                                   the files a cycle changed (run in the project): record, mirror .env keys, list, per stage
  permissions extract|args|mode|list|decide ...
                                   the actions stage agents were refused, and the rules their runs get
  permit <slug> allow|always|deny [n|all] [--project <name>]
                                   decide the actions a pipeline's agent was refused (in its run's worktree when it
                                   has one; always saves the rule in the main working tree); prints how many are still pending
  model path | list [--json] | get <provider> | remove <provider> | test <provider>/<model>
  model add <provider> --endpoint <url> --key-env <VAR> --models a,b [--effort]
  model add-model|remove-model <provider> <model>
                                   the user-level model registry (custom providers)
  backlog [status[,status...]] [--status <list>] [--json]
                                   the backlog items with their status`;

const CHANGES_SUBS = ['snapshot', 'mirror', 'changed', 'mark'];
const CHANGES_USAGE = 'usage: ai-sdlc-helper changes snapshot|mirror|changed <baseline.json> | mark <stage-files.json> [stage] | <slug> [--json] | --all [<slug>...]';
const PERMIT_USAGE = 'Usage: ai-sdlc-helper permit <slug> allow|always|deny [n|all]';

/** The project root for <dir>: the top of its git work tree, else <dir> itself. */
function gitRoot(dir: string): string {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : dir;
}

/** The index of the command word in <argv>: the first word that is neither an option nor an option's value. */
const commandAt = (argv: string[], valued: string[]): number =>
  argv.findIndex((a, i) => !a.startsWith('--') && !valued.includes(argv[i - 1]));

function changes(io: Io, cwd: string, [sub, file, stage]: string[]): number {
  const root = gitRoot(cwd);
  const settings = readSettings(root);
  const finalise = settings.finalise || settings.ship || {};
  const opts = { root, maxBytes: Number.isInteger(finalise.maxFileBytes) ? finalise.maxFileBytes : undefined };
  const target = file && path.resolve(cwd, file);
  if (sub === 'mark' && target) mark(target, stage || '', opts);
  else if (sub === 'snapshot' && target) snapshot(target, opts);
  else if (sub === 'mirror' && target) mirror(target, opts, line => io.err(line));
  else if (sub === 'changed' && target) io.out(JSON.stringify(changed(target, opts)));
  else { io.err(CHANGES_USAGE); return 1; }
  return 0;
}

/** Decides a pipeline's refused actions: in its run's worktree when it has one, else in this checkout. */
function permit(io: Io, cwd: string, args: string[], env: NodeJS.ProcessEnv): number {
  const a = parseArgs(args, ['--project']);
  if (a.value('--project') === '') { io.err('ERROR: --project needs a value'); return 2; }
  if (a.positional.length < 2 || a.positional.length > 3) { io.err(PERMIT_USAGE); return 2; }
  const [slug, choice, which = 'all'] = a.positional;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { io.err(`Invalid slug '${slug}': lowercase letters, digits and dashes only`); return 2; }
  const root = a.value('--project') !== undefined ? projectDir(a.value('--project'), cwd, env) : gitRoot(cwd);
  const docs = path.join(runCheckout(root, slug, env) || root, backlogPlace(root).backlogDir, slug);
  if (!exists(docs)) { io.err(`No pipeline for ${slug}`); return 1; }
  // Saved rules belong to the run's project: the checkout that started it (an older record: the main working tree).
  const rec = readRecord(registryDir(root), slug);
  const home = rec && rec.worktree ? (typeof rec.root === 'string' && rec.root ? rec.root : mainTree(root, env)) : root;
  io.out(String(decide(path.join(docs, 'logs', 'permissions.json'), which, choice, repoRulesFile(home))));
  return 0;
}

/** Runs one of TOOL_COMMANDS from the full command line <argv>. Returns the exit code. */
export async function projectTool(argv: string[], valued: string[], io: Io): Promise<number> {
  const env = io.env || process.env;
  const cwd = io.cwd || process.cwd();
  const at = commandAt(argv, valued);
  const cmd = argv[at];
  const rest = [...argv.slice(0, at), ...argv.slice(at + 1)];
  try {
    switch (cmd) {
      case 'changes': {
        const c = parseArgs(argv, valued);
        // changes <slug> and changes --all are the run forms; the rest are the sub-commands of a cycle's files.
        if (c.flag('--all') || (c.positional.length === 2 && !CHANGES_SUBS.includes(c.positional[1]))) return runsChanges(c, io);
        return changes(io, cwd, rest);
      }
      case 'permissions': permissionsMain(rest, line => io.out(line), cwd); return 0;
      case 'permit': return permit(io, cwd, rest, env);
      case 'model': return await modelsMain(rest, { env, out: line => io.out(line), err: line => io.err(line) });
      case 'backlog': {
        const root = gitRoot(cwd);
        const lines = (send: (t: string) => void) => (text: string) => send(text.replace(/\n$/, ''));
        return backlogMain(rest, backlogPlace(root), { out: lines(t => io.out(t)), err: lines(t => io.err(t)) });
      }
      default: io.err(`ERROR: unknown command "${cmd}"`); return 2;
    }
  } catch (e) {
    io.err(cmd === 'permissions' ? (e as Error).message : `ERROR: ${(e as Error).message}`);
    return 1;
  }
}
