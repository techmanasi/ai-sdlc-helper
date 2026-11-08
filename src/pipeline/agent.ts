// Stage agents: headless `claude -p` with the stage's prompt, model, tools and permission mode; the transcript is kept
// and whatever the agent was refused is recorded for the developer to allow or deny.
import fs from 'node:fs';
import { extract, modeFor, rulesFor } from '../permissions/index.js';
import { toolNotes } from '../config/toolNotes.js';
import { agentFor, harnessFor, testDir, testFramework } from '../config/settings.js';
import { at, stamp, stop, stopIfAborted, tick, type AgentStage, type Ctx } from './context.js';
import { modelEnvOf, modelFlags, providerEnv, stageModel } from './models.js';
import { manualInput, prCommentsInput, renderPrompt } from './prompts.js';
import { resumeHint } from './hints.js';
import { DefaultHarnessRegistry } from './harness/registry.js';
export { spawnAgentProcess, spawnClaude } from './agent-process.js';
export type { AgentRequest, AgentSpawn } from './agent-process.js';

const defaultRegistry = new DefaultHarnessRegistry();

/**
 * The reset or quota text ("resets 1:10am (Asia/Dubai)", "rate limit reached", "quota exceeded") when an agent's
 * execution output or error stream says it hit the account's rate, usage or quota limit, else null.
 * Supports Claude, OpenAI Codex, and Google Antigravity (agy).
 */
export function usageLimit(jsonFile: string, errFile?: string): string | null {
  const checkText = (text: string): string | null => {
    if (!text.trim()) return null;
    const mReset = /resets\s+[^\n"\\]*/i.exec(text);
    if (mReset) return mReset[0].trim();
    if (/insufficient_quota|quota_exceeded|exceeded your current quota|quota exceeded|RESOURCE_EXHAUSTED/i.test(text)) {
      return 'quota exceeded';
    }
    if (/usage_limit_reached|usage limit reached/i.test(text)) {
      return 'usage limit reached';
    }
    if (/rate_limit_exceeded|rate limit reached|rate limit exceeded|429 Too Many Requests|RATE_LIMITED/i.test(text)) {
      return 'rate limit reached';
    }
    return null;
  };

  // Only typed provider error events are inspected. The transcript also holds tool output and assistant text, which
  // can quote limit strings as ordinary source code, so it is never scanned as free text.
  const fromEvent = (event: Record<string, unknown>): string | null => {
    const err = (event.error ?? null) as { code?: unknown; message?: unknown } | null;
    const code = err?.code ?? event.code;
    if (code === 'rate_limit_exceeded' || code === 'rate_limit' || event.type === 'rate_limit') return 'rate limit reached';
    if (code === 'insufficient_quota' || code === 'quota_exceeded') return 'quota exceeded';
    const isError = event.type === 'error' || event.type === 'turn.failed' || err !== null;
    if (!isError) return null;
    const message = [code === 'usage_limit_reached' ? 'usage_limit_reached' : '', err?.message, typeof event.message === 'string' ? event.message : '']
      .filter((m): m is string => typeof m === 'string' && m.length > 0).join('\n');
    const hit = checkText(message);
    if (hit) return hit;
    return /hit your usage limit/i.test(message) ? 'usage limit reached' : null;
  };

  try {
    if (fs.existsSync(jsonFile)) {
      const raw = fs.readFileSync(jsonFile, 'utf8');
      let single: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) single = parsed as Record<string, unknown>;
      } catch { /* not a single object: JSONL */ }
      if (single) {
        const d = single as { api_error?: unknown; result?: unknown; is_error?: unknown; status?: unknown; error?: { code?: unknown; status?: unknown } };
        if (d.api_error === 'usage_limit_reached') {
          const m = /resets[^\n"\\]*/.exec(String(d.result || ''));
          return m ? m[0].trim() : 'resets later';
        }
        if (d.status === 'RATE_LIMITED' || d.error?.code === 429) return 'rate limit reached';
        if (d.status === 'QUOTA_EXCEEDED' || d.error?.status === 'RESOURCE_EXHAUSTED') return 'quota exceeded';
        const hit = fromEvent(single);
        if (hit) return hit;
        // The result of a failed run is the provider's message; the result of a successful run is the agent's own text.
        if (d.is_error === true && typeof d.result === 'string') {
          const fromResult = checkText(d.result);
          if (fromResult) return fromResult;
        }
      } else {
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event && typeof event === 'object') {
              const hit = fromEvent(event as Record<string, unknown>);
              if (hit) return hit;
            }
          } catch { /* ignore non-JSON line */ }
        }
      }
    }
  } catch { /* ignore read failure */ }

  if (errFile && fs.existsSync(errFile)) {
    try {
      const errRaw = fs.readFileSync(errFile, 'utf8');
      const fromErr = checkText(errRaw);
      if (fromErr) return fromErr;
    } catch { /* ignore read failure */ }
  }

  return null;
}

export interface AgentFailureInfo {
  summary: string;
  details: string[];
}

/** Extracts readable error details from an agent's stderr, JSON output, or stdout logs. */
export function extractAgentFailure(base: string, rc: number): AgentFailureInfo {
  const details: string[] = [];
  let summary = '';
  let structuredSummary = '';

  const errFile = `${base}.err`;
  const jsonFile = `${base}.json`;
  const logFile = `${base}.log`;

  if (fs.existsSync(errFile)) {
    try {
      const errText = fs.readFileSync(errFile, 'utf8');
      const lines = errText.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (!details.includes(line)) details.push(line);
        if (/^reading additional input from stdin/i.test(line)) continue;
        if (!summary && /^(error|fatal|exception):/i.test(line)) {
          summary = line;
        }
      }
      if (!summary && lines.length > 0) {
        const candidate = lines.filter(l => !/^reading additional input from stdin/i.test(l)).pop();
        if (candidate) summary = candidate;
      }
    } catch { /* ignore */ }
  }

  if (fs.existsSync(jsonFile)) {
    try {
      const jsonText = fs.readFileSync(jsonFile, 'utf8');
      try {
        const d = JSON.parse(jsonText);
        const msg = d.error?.message || d.message || d.api_error || d.error || d.status;
        if (msg && typeof msg === 'string') {
          structuredSummary ||= msg;
          if (!details.includes(msg)) details.push(msg);
        }
      } catch {
        const lines = jsonText.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            const msg = event.error?.message
              || event.item?.error?.message
              || (event.item?.type === 'error' ? event.item.message : null)
              || event.message
              || (event.type === 'error' ? (typeof event.content === 'string' ? event.content : event.message) : null);
            if (msg && typeof msg === 'string') {
              structuredSummary ||= msg;
              if (!details.includes(msg)) details.push(msg);
            }
          } catch { /* non-JSON */ }
        }
      }
    } catch { /* ignore */ }
  }

  if (structuredSummary) summary = structuredSummary;

  if (fs.existsSync(logFile) && (!summary || details.length === 0)) {
    try {
      const logText = fs.readFileSync(logFile, 'utf8');
      const lines = logText.split('\n').map(l => l.trim()).filter(Boolean);
      for (const line of lines.slice(-5)) {
        if (!details.includes(line)) details.push(line);
        if (!summary && /^(error|fatal|exception):/i.test(line)) summary = line;
      }
      if (!summary && lines.length > 0) summary = lines[lines.length - 1];
    } catch { /* ignore */ }
  }

  if (!summary) {
    summary = `process exited with code ${rc}`;
  }

  return { summary, details: details.slice(0, 10) };
}

/** Legacy configuration parser retained for compatibility; usage limits now stop immediately. */
export function limitWait(env: NodeJS.ProcessEnv): { retry: number; maxWait: number } {
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return { retry: num(env.SDLC_LIMIT_RETRY, 300), maxWait: num(env.SDLC_LIMIT_MAX_WAIT, 21600) };
}

/** Plan reads the published docs and type definitions of a new library from the web (it is installed only in Implement). */
export const PLAN_TOOLS = ['WebFetch', 'WebSearch', 'mcp__context7'];

/** One agent process: command, arguments, and the files its output goes to (one file when both are the same). */
/** The {{PLACEHOLDER}} values of the run's prompts. */
export function promptValues(ctx: Ctx): Record<string, string> {
  return {
    DOCS: ctx.docs, LOG: ctx.log, TEST_DIR: testDir(ctx.config.suites[0]), TEST_CMD: ctx.layout.testCmd, TEST_FILE_CMD: ctx.testFileCmd, FETCH_CMD: ctx.fetchCmd,
    RED_SHA: ctx.redSha, SLUG: ctx.slug, TEST_FRAMEWORK: testFramework(ctx.config), TEST_FILES: ctx.layout.testFiles || `${testDir(ctx.config.suites[0])}/`,
  };
}

/** The model flags and provider environment of <stage>; prints the model line and records it in the status. */
export function stageFlags(ctx: Ctx, stage: AgentStage): { args: string[]; env: Record<string, string>; model: string; effort: string; hasEffort: boolean } {
  const sm = stageModel(stage, modelEnvOf(ctx));
  ctx.status.model = sm.model;
  ctx.status.effort = sm.effort;
  ctx.out(sm.provider.effortFlag ? `   model=${sm.model} effort=${sm.effort}` : `   model=${sm.model} (provider without effort)`);
  return { args: modelFlags(sm), env: providerEnv(sm.provider), model: sm.provider.model, effort: sm.effort, hasEffort: sm.provider.effortFlag };
}

/** The tool notes for <stage>: `when:` sections look at the last gate run's tests.log and at test-issues.md. */
export function stageNotes(ctx: Ctx, stage: AgentStage): string {
  const read = (file: string) => { try { return fs.readFileSync(at(ctx, file), 'utf8'); } catch { return ''; } };
  return toolNotes(stage, ctx.config, { testsLog: read(`${ctx.log}/tests.log`), testIssues: read(`${ctx.docs}/test-issues.md`) });
}

/**
 * A model belongs to its harness. The global stage defaults are Claude names,
 * so a different harness with no explicit model of its own must let its CLI select its
 * account default instead of translating that name to another provider.
 */
function harnessSelection(
  ctx: Ctx,
  stage: AgentStage,
  flags: { model: string; effort: string; hasEffort: boolean },
  harness: { id: string; selectStageModel?: (opts: { defaultModel: string; defaultEffort: string; hasEffort: boolean; configuredModel?: string; configuredEffort?: string }) => { model: string; effort?: string } },
): { model: string; effort?: string } {
  const selected = agentFor(ctx.config, stage);
  const up = stage.toUpperCase().replace(/-/g, '_');
  const configuredModel = ctx.force?.model || ctx.env[`MODEL_${up}`] || (selected.harness === harness.id ? selected.model : undefined) || ctx.env.SDLC_MODEL;
  const configuredEffort = ctx.force?.effort || ctx.env[`EFFORT_${up}`] || selected.effort || ctx.env.SDLC_EFFORT;
  return harness.selectStageModel?.({
    defaultModel: flags.model,
    defaultEffort: flags.effort,
    hasEffort: flags.hasEffort,
    configuredModel,
    configuredEffort,
  }) || { model: configuredModel || '', effort: configuredEffort };
}

/**
 * Runs the agent of <stage>, logged as <name> (<log>/<name>.json, .err and .log). Exits 2 when it was refused an action
 * (recorded in permissions.json), 1 when it failed.
 */
export async function runAgent(ctx: Ctx, name: string, stage: AgentStage): Promise<void> {
  stopIfAborted(ctx);
  let prompt = renderPrompt(stage, promptValues(ctx), ctx.guide, ctx.promptsDir, stageNotes(ctx, stage));
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

  const harnessId = harnessFor(ctx.config, stage);
  const harness = defaultRegistry.get(harnessId) || defaultRegistry.get('claude')!;

  const selection = harnessSelection(ctx, stage, flags, harness);

  const invocation = harness.compileStageArgs({
    prompt,
    stage,
    model: selection.model,
    effort: selection.effort,
    mode,
    allowedCommands: allowed,
    cwd: ctx.root,
    maxTurns: ctx.limits.maxTurns,
  });

  const rc = await ctx.spawnAgent({
    command: invocation.command,
    args: invocation.args,
    cwd: ctx.root, env: { ...ctx.env, ...flags.env, ...invocation.env }, stdout: `${base}.json`, stderr: `${base}.err`, signal: ctx.signal,
  });
  await tick();
  const limit = usageLimit(`${base}.json`, `${base}.err`);
  if (limit) {
    ctx.status.note = '';
    ctx.status.write();
    ctx.out(`   !! agent '${name}' hit the usage limit (${limit}); stopping immediately, see ${base}.err`);
    stop(ctx, `agent '${name}' hit the usage limit: ${limit}`, 1);
  }
  let pending = 0;
  try {
    pending = extract({ jsonFile: `${base}.json`, logFile: `${base}.log`, stateFile: at(ctx, `${ctx.log}/permissions.json`), stage, cwd: ctx.root, errFile: `${base}.err`, allowed });
  } catch { pending = 0; }
  if (pending > 0) {
    stop(ctx, `   !! agent '${name}' was refused ${pending} action(s): allow or deny them in the pane (or: ai-sdlc-helper permit ${ctx.slug} allow|always|deny all), then resume at ${stage}`, 2);
  }
  if (rc !== 0) {
    const failure = extractAgentFailure(base, rc);
    if (/model.*(?:not supported|unknown|invalid|not found)/i.test(failure.summary)) {
      harness.catalog?.invalidateCache();
    }
    // `base` is rooted through `at(ctx, ...)`, so the path is actionable even
    // when the UI/server process has a different working directory.
    ctx.out(`   !! agent '${name}' failed, see ${base}.log`);
    if (stage === 'test-repair') resumeHint(ctx);
    if (failure.summary) {
      ctx.out(`      failure (exit ${rc}): ${failure.summary}`);
    }
    for (const d of failure.details) {
      if (d !== failure.summary) ctx.out(`      ${d}`);
    }
    if (fs.existsSync(`${base}.err`) && fs.statSync(`${base}.err`).size > 0) {
      ctx.out(`      see ${base}.err`);
    }
    stop(ctx, `agent '${name}' failed: ${failure.summary}`, 1);
  }
}

/** The independent test auditor: read-only tools, raw output in <log>/test-audit.json, parsed markdown in <log>/test-audit.log. Resolves its exit code. */
export async function runAudit(ctx: Ctx, prompt: string, flags: { args: string[]; env: Record<string, string>; model?: string; effort?: string }): Promise<number> {
  const rawFile = at(ctx, `${ctx.log}/test-audit.json`);
  const errFile = at(ctx, `${ctx.log}/test-audit.err`);
  const logFile = at(ctx, `${ctx.log}/test-audit.log`);
  const harnessId = harnessFor(ctx.config, 'test-audit');
  const harness = defaultRegistry.get(harnessId) || defaultRegistry.get('claude')!;
  const selection = harnessSelection(ctx, 'test-audit', { model: flags.model || '', effort: flags.effort || '', hasEffort: Boolean(flags.effort) }, harness);
  const inv = harness.compileAuditArgs({
    prompt,
    model: selection.model,
    effort: selection.effort,
    cwd: ctx.root,
  });
  const rc = await ctx.spawnAgent({
    command: inv.command,
    args: inv.args,
    cwd: ctx.root,
    env: { ...ctx.env, ...flags.env, ...inv.env },
    stdout: rawFile,
    stderr: errFile,
    signal: ctx.signal,
  });

  if (rc !== 0) {
    const failure = extractAgentFailure(at(ctx, `${ctx.log}/test-audit`), rc);
    if (/model.*(?:not supported|unknown|invalid|not found)/i.test(failure.summary)) {
      harness.catalog?.invalidateCache();
    }
  }

  const stdoutText = fs.existsSync(rawFile) ? fs.readFileSync(rawFile, 'utf8') : '';
  const stderrText = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';

  const parsed = harness.parseOutput(stdoutText, stderrText, ctx.root);
  const textToWrite = parsed.text || stdoutText || stderrText;
  fs.writeFileSync(logFile, textToWrite.endsWith('\n') ? textToWrite : `${textToWrite}\n`);

  return rc;
}
