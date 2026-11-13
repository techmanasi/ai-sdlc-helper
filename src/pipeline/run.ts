// A pipeline run for one backlog item: settings, slug, branch, baseline, models and status, then the stages from FROM on.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from '../trace.js';
import { fileURLToPath } from 'node:url';
import { exists, shellWord } from '../util.js';
import { onPath } from '../shell.js';
import { codeSearchGuide } from '../config/codeSearch.js';
import { HARNESS_IDS, allowedTools, layout, resolve, type HarnessName } from '../config/settings.js';
import { snapshot } from '../changes/index.js';
import { repoRulesFile } from '../permissions/index.js';
import { Keys, testLayout } from '../testcheck/keys.js';
import { AGENT_STAGES, Exit, FROM_STAGES, SetupError, at, setAside, stamp, stop, tick, type Ctx, type From } from './context.js';
import { spawnAgentProcess, type AgentSpawn } from './agent.js';
import { projectRoot } from '../runs/records.js';
import { Git } from './git.js';
import { envModels, modelEnvOf, registryFile, stageModels } from './models.js';
import { PROMPTS_DIR } from './prompts.js';
import { Status, finalState, previousBranch, previousStage, previousState } from './status.js';
import { isRunBranch } from './branch-move.js';
import { ensurePushable } from './push-check.js';
import { formatRecoveryCli, stageRecoveryHint } from './hints.js';
import { appendRound, priorStarts } from './observe.js';
import { redCommitTestFiles, resultsAt } from './gates.js';
import { adoptKeptAttempt, resolveConflictsStage } from './resolve-conflicts.js';
import {
  implementStage, markStage, planStage, redTestsStage, refuseRedone, resumeAtTests, reviewStage, finaliseStage, specStage,
  testRepairStage,
} from './stages.js';

export interface PipelineOptions {
  /** The project checkout (a worktree or the main one); the run works at the top of its git tree. */
  cwd: string;
  /** The backlog item; default: the first pending item of <backlogDir>/index.md. */
  slug?: string;
  /** The stage to start at; default: env FROM, else spec. */
  from?: string;
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Starts the stage agents (default: `claude` on PATH). */
  spawnAgent?: AgentSpawn;
  promptsDir?: string;
  /** The command the agents run one test file with (default: `ai-sdlc-helper run --file`). */
  testFileCmd?: string;
  /** Aborts the running agent or command (the run then fails). */
  signal?: AbortSignal;
  /** Primary coding agent harness: claude, agy, or codex */
  agent?: 'claude' | 'agy' | 'codex';
  /** --model: the model of every stage (wins over MODEL_<STAGE> and the project's settings). */
  model?: string;
  /** --effort: the effort of every stage. */
  effort?: string;
}

const numberEnv = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const v = env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new SetupError(`ERROR: ${name} must be a whole number above 0 (got "${v}")`);
  return n;
};

/** `ai-sdlc-helper run --file`: the installed command when it is on PATH, else this package's own bin with this Node. */
export function defaultToolCmd(env: NodeJS.ProcessEnv): string {
  if (onPath('ai-sdlc-helper', { env })) return 'ai-sdlc-helper';
  const bin = fileURLToPath(new URL('../bin.js', import.meta.url));
  return exists(bin) ? `${shellWord(process.execPath)} ${shellWord(bin)}` : 'ai-sdlc-helper';
}
export const defaultTestFileCmd = (env: NodeJS.ProcessEnv): string => `${defaultToolCmd(env)} run --file`;
/** The GET-only web read the agents may run (`ai-sdlc-helper fetch <https-url>`). */
export const defaultFetchCmd = (env: NodeJS.ProcessEnv): string => `${defaultToolCmd(env)} fetch`;

/** The first pending item ("- [ ] `slug`") of a backlog index, or ''. */
export function firstPending(indexFile: string): string {
  if (!exists(indexFile)) return '';
  const line = fs.readFileSync(indexFile, 'utf8').split('\n').find(l => l.startsWith('- [ ]'));
  const m = line && line.match(/^- \[ \] `([^`]+)`/);
  return m ? m[1] : '';
}

const gitTop = (dir: string): string => {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : dir;
};

/**
 * Runs the pipeline. Resolves the exit code: 0 done (finalised, and brought up to date with the base when pushed), 1 failed, 2 paused for the developer (Spec or Plan
 * questions, refused agent actions). Once the item's log folder exists, its status.json holds the final state.
 */
export async function runPipeline(opts: PipelineOptions): Promise<number> {
  const out = opts.out || ((l: string) => { process.stdout.write(`${l}\n`); });
  const err = opts.err || ((l: string) => { process.stderr.write(`${l}\n`); });
  const callerEnv = opts.env || process.env;
  const from = (opts.from || callerEnv.FROM || 'spec') as From;
  if (!FROM_STAGES.includes(from)) {
    out(`ERROR: unknown FROM=${from} (use spec, plan, red-tests, implement, test-repair, review, finalise or resolve-conflicts)`);
    return 1;
  }
  // FROM says where THIS run starts; nothing it starts (tests, agents, pipelines the tests start) inherits it.
  const env: NodeJS.ProcessEnv = { ...callerEnv };
  delete env.FROM;
  let ctx: Ctx | null = null;
  let code = 0;
  let reason: string | undefined;
  try {
    ctx = await setup(opts, from, env, out, err);
    // Resolved model and effort of every stage, for the status file (and a bad value fails here, before any agent).
    ctx.status.models = stageModels(modelEnvOf(ctx));
    ctx.status.write();
    await stages(ctx);
  } catch (e) {
    if (e instanceof Exit) { code = e.code; reason = e.reason; }
    else {
      code = 1;
      const msg = (e as Error).message;
      err(e instanceof SetupError || /^ERROR/.test(msg) ? msg : `ERROR: ${msg}`);
    }
  } finally {
    if (ctx) {
      markStage(ctx, ctx.status.stage);
      Object.assign(ctx.status, { state: finalState(code), agent: '', model: '', effort: '', attempt: '', step: null });
      ctx.status.write();
      if (code !== 0) {
        try {
          const hint = stageRecoveryHint({
            slug: ctx.slug,
            stage: ctx.status.stage,
            state: finalState(code),
            exitCode: code,
            docsDir: ctx.docs,
            runOut: [...(ctx.failLog && fs.existsSync(ctx.failLog) ? fs.readFileSync(ctx.failLog, 'utf8').split('\n') : []), ...(reason ? [reason] : [])],
            hasTestIssues: fs.existsSync(path.join(ctx.docs, 'test-issues.md')),
          });
          out(formatRecoveryCli(hint));
        } catch { /* ignore recovery format error */ }
      }
    }
  }
  return code;
}

/** Everything before the first stage. Returns the run's context once its status file is being written. */
async function setup(opts: PipelineOptions, from: From, env: NodeJS.ProcessEnv, out: (l: string) => void, err: (l: string) => void): Promise<Ctx> {
  const root = gitTop(path.resolve(opts.cwd));
  const say: Pick<Ctx, 'out'> = { out };
  const limits = { maxAttempts: numberEnv(env, 'MAX_ATTEMPTS', 4), maxTurns: numberEnv(env, 'MAX_TURNS', 40), maxRepairTests: numberEnv(env, 'MAX_REPAIR_TESTS', 3) };
  // Project settings: sdlc.config.json completed by detection. The code search note is shown with the code search below.
  const { config, errors, warnings } = resolve(root, { env, agentFrom: projectRoot(root, env) });
  const searchNote = warnings.filter(w => w.includes('code search uses Grep and Glob'));
  for (const w of warnings.filter(x => !searchNote.includes(x))) out(`WARNING: ${w}`);
  if (!config) {
    for (const e of errors) out(`ERROR: ${e}`);
    return stop(say, 'ERROR: fix the project settings above (ai-sdlc-helper show)');
  }
  // AGENT_<STAGE> picks one stage's harness for this run, as MODEL_<STAGE> does its model.
  for (const st of AGENT_STAGES) {
    const v = env[`AGENT_${st.toUpperCase().replace(/-/g, '_')}`];
    if (!v) continue;
    if (!(HARNESS_IDS as readonly string[]).includes(v)) stop(say, `ERROR: AGENT_${st.toUpperCase().replace(/-/g, '_')} must be one of ${HARNESS_IDS.join(', ')} (got ${v})`);
    config.agent.stages = { ...config.agent.stages, [st]: { ...(config.agent.stages[st] || {}), harness: v as HarnessName } };
  }
  // --agent forces one harness for every stage, ahead of agent.stages. The project's model and effort were chosen for its
  // own harness, so they are dropped when another one is forced (--model and --effort still apply).
  if (opts.agent) {
    if (opts.agent !== config.agent.harness) { config.agent.model = null; config.agent.effort = null; }
    config.agent.harness = opts.agent;
    config.agent.stages = {};
  }
  const lay = layout(config);
  const backlog = `${config.backlogDir}/index.md`;
  const slug = opts.slug || firstPending(path.join(root, backlog));
  if (!slug) stop(say, `Usage: ai-sdlc-helper pipeline <slug> (or add a pending item to ${backlog})`);
  const docs = `${config.backlogDir}/${slug}`;
  if (!exists(path.join(root, docs, 'brief.md'))) stop(say, `Missing ${docs}/brief.md`);
  const log = `${docs}/logs`;
  fs.mkdirSync(path.join(root, log), { recursive: true });
  // The logs folder ignores itself: the run's logs never show in git status and are never committed, whatever the
  // project's own .gitignore says.
  const logIgnore = path.join(root, log, '.gitignore');
  if (!exists(logIgnore)) fs.writeFileSync(logIgnore, '*\n');

  // Code search: the indexer in use (its tools and commands for the agents, its guide for {{CODE_SEARCH}}), else Grep and Glob.
  fs.writeFileSync(path.join(root, log, 'code-search.txt'), searchNote.map(w => `NOTE: ${w}\n`).join(''));
  for (const w of searchNote) out(`NOTE: ${w}`);
  const search = { codeSearch: config.agent.codeSearch, indexer: config.agent.codeIndexer, warning: null };
  const testFileCmd = opts.testFileCmd || defaultTestFileCmd(env);
  const fetchCmd = defaultFetchCmd(env);

  const status = new Status(path.join(root, log, 'status.json'), slug);
  const priorStage = previousStage(status.file);
  // Read before status.write() below replaces the file: how the previous start ended.
  const priorState = previousState(status.file);
  const prior = priorStarts(path.join(root, log));
  const runNumber = prior.count + 1;
  const previousRun = runNumber > 1 ? {
    ...(prior.stage || priorStage ? { stage: prior.stage || priorStage } : {}),
    ...(priorState ? { state: priorState } : {}),
    ...(prior.at ? { at: prior.at } : {}),
  } : undefined;
  status.runNumber = runNumber;
  status.previousRun = previousRun;
  const git = new Git(root, env);
  // A run that moved to <prefix><slug>_N stays there on a resume: the worktree's branch is the run's branch.
  const defaultBranch = `${config.git.branchPrefix}${slug}`;
  const current = (git.tryRun('symbolic-ref', '--short', '-q', 'HEAD') || '').trim();
  const branch = current && isRunBranch(current, config.git.branchPrefix, slug) ? current : defaultBranch;
  const moved = previousBranch(status.file);
  if (branch !== defaultBranch) {
    status.branch = branch;
    if (moved.movedFrom) status.movedFrom = moved.movedFrom;
  }
  const ctx: Ctx = {
    root, config, layout: lay, slug, from, fromN: FROM_STAGES.indexOf(from) + 1, docs, log, backlog,
    branch, ...(status.movedFrom ? { movedFrom: { branch: status.movedFrom.branch, pr: status.movedFrom.pr, reason: status.movedFrom.reason } } : {}), env, envModels: envModels(root, env), force: { ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}) }, registryFile: registryFile(env), limits,
    priorStage, runNumber, previousRun, git, keys: new Keys(testLayout(config), root), status, spawnAgent: opts.spawnAgent || spawnAgentProcess, signal: opts.signal,
    promptsDir: opts.promptsDir || PROMPTS_DIR, guide: codeSearchGuide(search, root),
    allowed: [...new Set([...allowedTools(config), `Bash(${testFileCmd}:*)`, `Bash(${fetchCmd}:*)`])], testFileCmd, fetchCmd,
    // Repository-wide allow rules live in the main working tree, so every worktree run sees them.
    permRepo: repoRulesFile(root),
    redSha: '', lockSha: '', origRedSha: '', failLog: `${log}/tests.log`, out, err,
  };
  status.write();
  return ctx;
}

async function stages(ctx: Ctx): Promise<void> {
  const { git, fromN } = ctx;
  git.checkoutBranch(ctx.branch);
  // "Fix with Implement": the kept merged result becomes the branch before anything else touches the logs it ended with.
  if (ctx.env.SDLC_ON_ATTEMPT === '1') adoptKeptAttempt(ctx);
  await tick();
  ctx.out(`SDLC: ${ctx.slug} on branch ${ctx.branch}`);
  const trigger = ctx.env.SDLC_RUN_TRIGGER === 'ui' ? 'ui' : 'cli';
  const n = ctx.runNumber ?? 1;
  if (n > 1) {
    const p = ctx.previousRun || {};
    ctx.out(`Start ${n} of this item, started from the ${trigger === 'ui' ? 'web UI' : 'command line'}: the previous start ended ${p.state || 'without a recorded state'} at ${p.stage || 'no stage'}${p.at ? ` (${p.at})` : ''}`);
  }
  appendRound(at(ctx, ctx.log), {
    kind: 'run', at: stamp(), from: ctx.from, n, trigger,
    ...(n > 1 && ctx.previousRun ? { previous: ctx.previousRun } : {}),
  });
  // A previous run's test logs describe another state of the code: this run writes its own before anyone reads them. They are moved
  // aside, not deleted: a run never throws its logs away.
  setAside(ctx, ['tests.log', 'tests.json', 'integration.log'].map(f => `${ctx.log}/${f}`));

  // Baseline of already-dirty files, so Finalise commits only what this cycle changed (never the developer's own work).
  const baseline = path.join(ctx.root, ctx.log, 'baseline.json');
  if (fromN === 1) snapshot(baseline, { root: ctx.root });
  else if (!exists(baseline)) {
    ctx.out('WARNING: no baseline from the original run; changes made before this resume are treated as pre-existing and will not be committed');
    snapshot(baseline, { root: ctx.root });
  }
  await tick();
  if (fromN === 2 || fromN === 3) refuseRedone(ctx);

  if (fromN <= 1) await specStage(ctx);
  if (fromN <= 2) await planStage(ctx);
  // The push check: before Red tests commits and pushes anything, the branch is made pushable (or the run moves to a new
  // branch). After refuseRedone, so a refused start changes nothing. (A kept attempt, SDLC_ON_ATTEMPT=1, starts at
  // Implement only: adoptKeptAttempt stops any other start, so it never gets here.)
  if (fromN <= 3) await ensurePushable(ctx, { resume: 'red-tests', fresh: ctx.from === 'spec' || ctx.from === 'plan' });
  if (fromN <= 3) await redTestsStage(ctx);
  else resumeAtTests(ctx);
  ctx.origRedSha = ctx.redSha;
  await tick();

  if (fromN <= 5) {
    const redJson = path.join(ctx.root, ctx.log, 'red.json');
    if (!fs.existsSync(redJson)) {
      resultsAt(ctx, ctx.redSha, `${ctx.log}/red.json`, redCommitTestFiles(ctx));
    }
    await tick();
    const green = fromN <= 4 ? await implementStage(ctx) : false;
    if (!green) {
      if (!exists(path.join(ctx.root, ctx.docs, 'test-issues.md'))) {
        stop(ctx, `GREEN GATE FAILED after ${ctx.limits.maxAttempts} attempts and no test defect was claimed. See ${ctx.failLog}`);
      }
      await testRepairStage(ctx);
    }
  }
  if (fromN <= 6) await reviewStage(ctx);
  if (fromN <= 7) await finaliseStage(ctx);
  await resolveConflictsStage(ctx);
}
