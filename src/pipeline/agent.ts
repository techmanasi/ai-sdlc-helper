// Stage agents: headless `claude -p` with the stage's prompt, model, tools and permission mode; the transcript is kept
// and whatever the agent was refused is recorded for the developer to allow or deny.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { extract, modeFor, rulesFor } from '../permissions/index.js';
import { testDir, testFramework } from '../config/settings.js';
import { at, stamp, stop, stopIfAborted, tick, type AgentStage, type Ctx } from './context.js';
import { modelFlags, providerEnv, stageModel } from './models.js';
import { manualInput, prCommentsInput, renderPrompt } from './prompts.js';
import { resumeHint } from './hints.js';
import { DefaultHarnessRegistry } from './harness/registry.js';

const defaultRegistry = new DefaultHarnessRegistry();

/**
 * The reset text ("resets 1:10am (Asia/Dubai)") when an agent's `--output-format json` result says it hit the account's
 * usage limit, else null.
 */
export function usageLimit(jsonFile: string): string | null {
  try {
    const raw = fs.readFileSync(jsonFile, 'utf8');
    try {
      const d = JSON.parse(raw);
      if (d.api_error === 'usage_limit_reached') {
        const m = /resets[^\n"\\]*/.exec(String(d.result || ''));
        return m ? m[0].trim() : 'resets later';
      }
      if (d.error?.code === 'rate_limit_exceeded' || d.code === 'rate_limit') {
        return 'rate limit reached';
      }
    } catch {
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.error?.code === 'rate_limit_exceeded' || event.code === 'rate_limit') {
            return 'rate limit reached';
          }
        } catch {
          /* ignore non-JSON */
        }
      }
    }
    return null;
  } catch { return null; }
}

/** How long a usage limit is waited out: SDLC_LIMIT_RETRY seconds between tries (300), SDLC_LIMIT_MAX_WAIT in all (6 h). */
export function limitWait(env: NodeJS.ProcessEnv): { retry: number; maxWait: number } {
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return { retry: num(env.SDLC_LIMIT_RETRY, 300), maxWait: num(env.SDLC_LIMIT_MAX_WAIT, 21600) };
}

/** Waits <seconds>, or less when the run is aborted. */
const sleep = (seconds: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const t = setTimeout(done, seconds * 1000);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done);
});

/** Plan reads the published docs and type definitions of a new library from the web (it is installed only in Implement). */
export const PLAN_TOOLS = ['WebFetch', 'WebSearch', 'mcp__context7'];

/** One agent process: command, arguments, and the files its output goes to (one file when both are the same). */
export interface AgentRequest {
  command?: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: string;
  stderr: string;
  signal?: AbortSignal;
}

/** Starts an agent and resolves with its exit code. Tests pass a stand-in. */
export type AgentSpawn = (req: AgentRequest) => Promise<number>;

/** Runs an agent process (`claude`, `codex`, `agy`, etc. from the request environment's PATH). */
export const spawnClaude: AgentSpawn = req => new Promise(resolve => {
  const out = fs.openSync(req.stdout, 'w');
  const err = req.stderr === req.stdout ? out : fs.openSync(req.stderr, 'w');
  let done = false;
  const finish = (code: number) => {
    if (done) return;
    done = true;
    fs.closeSync(out);
    if (err !== out) fs.closeSync(err);
    resolve(code);
  };
  const bin = req.command || 'claude';
  const child = spawn(bin, req.args, { cwd: req.cwd, env: req.env, stdio: ['ignore', out, err], signal: req.signal });
  child.on('error', e => { try { fs.writeSync(err, `${e.message}\n`); } catch { /* closed */ } finish(127); });
  child.on('close', code => finish(code === null ? 1 : code));
});

/** The {{PLACEHOLDER}} values of the run's prompts. */
export function promptValues(ctx: Ctx): Record<string, string> {
  return {
    DOCS: ctx.docs, LOG: ctx.log, TEST_DIR: testDir(ctx.config.suites[0]), TEST_CMD: ctx.layout.testCmd, TEST_FILE_CMD: ctx.testFileCmd, FETCH_CMD: ctx.fetchCmd,
    RED_SHA: ctx.redSha, SLUG: ctx.slug, TEST_FRAMEWORK: testFramework(ctx.config), TEST_FILES: ctx.layout.testFiles || `${testDir(ctx.config.suites[0])}/`,
  };
}

/** The model flags and provider environment of <stage>; prints the model line and records it in the status. */
export function stageFlags(ctx: Ctx, stage: AgentStage): { args: string[]; env: Record<string, string>; model: string; effort: string; hasEffort: boolean } {
  const sm = stageModel(stage, { env: ctx.env, fromFile: ctx.envModels, registryFile: ctx.registryFile });
  ctx.status.model = sm.model;
  ctx.status.effort = sm.effort;
  ctx.out(sm.provider.effortFlag ? `   model=${sm.model} effort=${sm.effort}` : `   model=${sm.model} (provider without effort)`);
  return { args: modelFlags(sm), env: providerEnv(sm.provider), model: sm.provider.model, effort: sm.effort, hasEffort: sm.provider.effortFlag };
}

/**
 * Runs the agent of <stage>, logged as <name> (<log>/<name>.json, .err and .log). Exits 2 when it was refused an action
 * (recorded in permissions.json), 1 when it failed.
 */
export async function runAgent(ctx: Ctx, name: string, stage: AgentStage): Promise<void> {
  stopIfAborted(ctx);
  let prompt = renderPrompt(stage, promptValues(ctx), ctx.guide, ctx.promptsDir);
  if (stage !== 'test-repair' && stage !== 'test-audit') {
    prompt += manualInput(at(ctx, ctx.docs), stage, testDir(ctx.config.suites[0]));
    prompt += prCommentsInput(at(ctx, ctx.docs));
  }
  ctx.out(`   -> agent: ${name}`);
  const flags = stageFlags(ctx, stage);
  ctx.status.agent = name;
  ctx.status.agentStarted = stamp();
  ctx.status.write();
  // Rules the developer granted (this run's and the repository's) are added; a protected-path grant runs this stage without permission checks.
  const allowed = [...ctx.allowed, ...(stage === 'plan' ? PLAN_TOOLS : []), ...rulesFor(at(ctx, ctx.docs), ctx.permRepo)];
  const mode = modeFor(at(ctx, ctx.docs), stage);
  if (mode !== 'acceptEdits') ctx.out('   (permission checks are off for this stage: you allowed a protected path)');
  const base = at(ctx, `${ctx.log}/${name}`);

  const harnessId = ctx.config.agent?.harness || (ctx.env.SDLC_AGENT as any) || 'claude';
  const harness = defaultRegistry.get(harnessId) || defaultRegistry.get('claude')!;

  let model = flags.model;
  const effort = flags.effort;
  if (harnessId === 'codex') {
    if (model === 'opus') model = 'o1';
    else if (model === 'sonnet') model = 'o3-mini';
    else if (model === 'haiku') model = 'gpt-4o';
  } else if (harnessId === 'agy') {
    if (model === 'opus') model = 'gemini-3.8-pro';
    else if (model === 'sonnet') model = 'gemini-3.8-flash-high';
    else if (model === 'haiku') model = 'gemini-3.8-flash-medium';
  }

  const invocation = harness.compileStageArgs({
    prompt,
    stage,
    model,
    effort: flags.hasEffort ? effort : undefined,
    mode,
    allowedCommands: allowed,
    cwd: ctx.root,
    maxTurns: ctx.limits.maxTurns,
  });

  // A usage limit is not the agent's failure: wait for the reset and run the same agent again.
  const { retry, maxWait } = limitWait(ctx.env);
  let waited = 0;
  let rc: number;
  for (;;) {
    rc = await ctx.spawnAgent({
      command: invocation.command,
      args: invocation.args,
      cwd: ctx.root, env: { ...ctx.env, ...flags.env, ...invocation.env }, stdout: `${base}.json`, stderr: `${base}.err`, signal: ctx.signal,
    });
    await tick();
    const limit = usageLimit(`${base}.json`);
    if (!limit) break;
    if (waited >= maxWait) {
      ctx.status.note = '';
      stop(ctx, `   !! agent '${name}' hit the usage limit (${limit}) and it did not reset within ${maxWait}s`, 1);
    }
    if (waited === 0) ctx.out(`   .. usage limit reached (${limit}): retrying '${name}' every ${retry}s`);
    ctx.status.note = `usage limit, ${limit}`;
    ctx.status.write();
    await sleep(retry, ctx.signal);
    stopIfAborted(ctx);
    waited += retry;
  }
  if (ctx.status.note) {
    ctx.out(`   .. usage limit over, '${name}' ran`);
    ctx.status.note = '';
    ctx.status.write();
  }
  let pending = 0;
  try {
    pending = extract({ jsonFile: `${base}.json`, logFile: `${base}.log`, stateFile: at(ctx, `${ctx.log}/permissions.json`), stage, cwd: ctx.root, errFile: `${base}.err`, allowed });
  } catch { pending = 0; }
  if (pending > 0) {
    stop(ctx, `   !! agent '${name}' was refused ${pending} action(s): allow or deny them in the pane (or: ai-sdlc-helper permit ${ctx.slug} allow|always|deny all), then resume at ${stage}`, 2);
  }
  if (rc !== 0) {
    ctx.out(`   !! agent '${name}' failed, see ${ctx.log}/${name}.log`);
    if (stage === 'test-repair') resumeHint(ctx);
    stop(ctx, null, 1);
  }
}

/** The independent test auditor: read-only tools, its stdout and stderr in <log>/test-audit.log. Resolves its exit code. */
export async function runAudit(ctx: Ctx, prompt: string, flags: { args: string[]; env: Record<string, string>; model?: string; effort?: string }): Promise<number> {
  const logFile = at(ctx, `${ctx.log}/test-audit.log`);
  const harnessId = ctx.config.agent?.harness || (ctx.env.SDLC_AGENT as any) || 'claude';
  const harness = defaultRegistry.get(harnessId) || defaultRegistry.get('claude')!;
  let model = flags.model || 'sonnet';
  if (harnessId === 'codex') {
    if (model === 'opus') model = 'o1';
    else if (model === 'sonnet') model = 'o3-mini';
  } else if (harnessId === 'agy') {
    if (model === 'opus') model = 'gemini-3.8-pro';
    else if (model === 'sonnet') model = 'gemini-3.8-flash-high';
  }
  const inv = harness.compileAuditArgs({
    prompt,
    model,
    effort: flags.effort,
    cwd: ctx.root,
  });
  return ctx.spawnAgent({
    command: inv.command,
    args: inv.args,
    cwd: ctx.root, env: { ...ctx.env, ...flags.env, ...inv.env }, stdout: logFile, stderr: logFile, signal: ctx.signal,
  });
}
