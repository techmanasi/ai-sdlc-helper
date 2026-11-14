// A panel of independent reviewers that any stage can call: each reviewer has its own agent and model, all of them judge
// in parallel and none sees another's answer; a judge agent writes one conclusion when they do not all agree.
import fs from 'node:fs';
import { at, stamp, type AgentStage, type Ctx } from './context.js';
import { harnessFor } from '../config/settings.js';
import { promptValues, runAudit, stageFlags, stageModelKey, stageNotes } from './agent.js';
import { renderPrompt } from './prompts.js';

/** The reviewers, each with its own agent and model (so their mistakes differ). The first SDLC_RESOLVE_REVIEWERS of them review (3 by default). */
export const REVIEWERS = ['resolve-review-1', 'resolve-review-2', 'resolve-review-3', 'resolve-review-4', 'resolve-review-5'] as const;
export const DEFAULT_REVIEWERS = 3;

/** How many reviewers judge a doubt: SDLC_RESOLVE_REVIEWERS, 0 to 5 (3 when unset or not a number). 0 leaves a doubt to the developer. */
export function reviewerCount(env: NodeJS.ProcessEnv): number {
  const v = (env.SDLC_RESOLVE_REVIEWERS || '').trim();
  if (!/^\d+$/.test(v)) return DEFAULT_REVIEWERS;
  return Math.min(REVIEWERS.length, Number(v));
}

/** SDLC_RESOLVE_REVIEW=0 (or false/off/no/skip), or no reviewers, leaves a doubt to the developer, as before the reviewers existed. */
export const reviewSkipped = (env: NodeJS.ProcessEnv): boolean => /^(0|false|off|no|skip)$/i.test(env.SDLC_RESOLVE_REVIEW || '') || reviewerCount(env) === 0;

/** The reviewers (1-based) that share an agent and model, by "<agent>:<model>": independent opinions need different ones. */
export function sharedReviewers(keys: string[]): Array<{ model: string; reviewers: number[] }> {
  const by = new Map<string, number[]>();
  keys.forEach((k, i) => by.set(k, [...(by.get(k) || []), i + 1]));
  return [...by].filter(([, n]) => n.length > 1).map(([model, reviewers]) => ({ model, reviewers }));
}

/** The same, in words for the output and the report; empty when every reviewer has its own agent and model. */
export function sharedReviewersText(keys: string[]): string {
  return sharedReviewers(keys).map(g => `reviewers ${g.reviewers.join(' and ')} use the same model (${g.model})`).join('; ');
}

/** A reviewer's last "VERDICT: SAFE" or "VERDICT: UNSAFE" line; anything else (no verdict, a failed agent) counts as UNSAFE. */
export function reviewVerdict(text: string): 'SAFE' | 'UNSAFE' {
  const last = [...text.matchAll(/^\s*VERDICT:\s*(SAFE|UNSAFE)\b/gim)].pop();
  return last && last[1].toUpperCase() === 'SAFE' ? 'SAFE' : 'UNSAFE';
}

/** The rule: the doubt is overridden only when all <count> reviewers say SAFE. */
export const unanimouslySafe = (verdicts: string[], count: number): boolean => count > 0 && verdicts.length === count && verdicts.every(v => v === 'SAFE');

/** What a panel is asked to judge, and where its record goes (paths from the root, like ctx.log). */
export interface PanelSpec {
  /** The suffix of each agent's log name: <reviewer>-<name>.log and resolve-judge-<name>.log (Resolve conflicts uses the round). */
  name: string;
  /** The prompt each reviewer gets, and the judge's (default resolve-judge). */
  reviewPrompt: string;
  judgePrompt?: string;
  /** The record's heading (a timestamp is added), and the judge's input's heading (default: the title). */
  title: string;
  inputTitle?: string;
  /** What is doubted, as the record states it. */
  doubt?: string;
  /** The record (Markdown), and the judge's input (default: <logFile without .md>-input.md). */
  logFile: string;
  inputFile?: string;
  /** Printed once the reviewers start. */
  intro?: string;
  /** The record's words for a unanimous SAFE and for anything else. */
  verdictText?: { safe: string; unsafe: string };
}

export interface PanelOpinion { stage: string; verdict: 'SAFE' | 'UNSAFE'; text: string }

export interface PanelResult {
  /** False when no reviewer was asked (notRun says why). */
  ran: boolean;
  /** All reviewers said SAFE. */
  safe: boolean;
  safeCount: number;
  count: number;
  /** The judge's conclusion ('' when they all agreed, or the judge failed). */
  conclusion: string;
  opinions: PanelOpinion[];
  notRun?: string;
}

/**
 * Asks the first reviewerCount(env) reviewers, in parallel, for SAFE or UNSAFE; on anything but a unanimous SAFE the judge
 * writes one conclusion. Not run at all when two reviewers share an agent and model: their agreement would prove little.
 * The opinions are kept in spec.logFile.
 */
export async function reviewPanel(ctx: Ctx, spec: PanelSpec): Promise<PanelResult> {
  const count = reviewerCount(ctx.env);
  const panel = REVIEWERS.slice(0, count);
  const doubt = spec.doubt || '(none given)';
  const verdictText = spec.verdictText || { safe: 'The doubt is overridden.', unsafe: 'The doubt stays.' };
  const notRun = (msg: string): PanelResult => ({ ran: false, safe: false, safeCount: 0, count, conclusion: '', opinions: [], notRun: msg });
  if (count === 0) return notRun('Independent review was not run: no reviewers (SDLC_RESOLVE_REVIEWERS=0).');
  ctx.status?.beginStep?.('review', 'Panel check in progress');
  const shared = sharedReviewersText(panel.map(st => stageModelKey(ctx, st)));
  if (shared) {
    // Reviewers on the same model make the same mistakes: their agreement would prove little, so none is asked.
    const msg = `Independent review was not run: ${shared}. Give each reviewer its own agent or model, or lower the number of reviewers.`;
    ctx.out(`   ${msg}`);
    fs.writeFileSync(at(ctx, spec.logFile), `# ${spec.title} (${stamp()})\n\n${msg}\n`);
    return notRun(msg);
  }
  if (spec.intro) ctx.out(`   ${spec.intro}`);
  ctx.status?.beginStep?.('review', `${count}/${count} reviewers started`);
  ctx.status.agent = 'resolve-review';
  ctx.status.agentStarted = stamp();
  ctx.status.write();
  const run = async (stage: AgentStage, name: string, promptName: string): Promise<{ rc: number; text: string }> => {
    const prompt = renderPrompt(promptName, promptValues(ctx), ctx.guide, ctx.promptsDir, stageNotes(ctx, stage), harnessFor(ctx.config, stage));
    const rc = await runAudit(ctx, prompt, stageFlags(ctx, stage), { stage, name });
    const file = at(ctx, `${ctx.log}/${name}.log`);
    return { rc, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' };
  };
  let finished = 0;
  const opinions = await Promise.all(panel.map(async (stage, i): Promise<PanelOpinion> => {
    const o = await run(stage, `${stage}-${spec.name}`, spec.reviewPrompt);
    ctx.status?.beginStep?.('review', `${++finished}/${count} reviewers finished`);
    const verdict = o.rc === 0 ? reviewVerdict(o.text) : 'UNSAFE';
    ctx.out(`   reviewer ${i + 1} (${stage}): ${o.rc === 0 ? verdict : `UNSAFE (the agent failed, exit ${o.rc})`}`);
    return { stage, verdict, text: o.rc === 0 ? o.text.trim() : `(the reviewer failed with exit ${o.rc})` };
  }));
  const verdicts = opinions.map(o => o.verdict);
  const safeCount = verdicts.filter(v => v === 'SAFE').length;
  const all = unanimouslySafe(verdicts, count);
  const opinionLines = opinions.flatMap((o, i) => [`## Reviewer ${i + 1} (${o.stage}): ${o.verdict}`, '', o.text, '']);

  let conclusion = '';
  if (!all) {
    const input = spec.inputFile || spec.logFile.replace(/\.md$/, '-input.md');
    fs.writeFileSync(at(ctx, input), [`# ${spec.inputTitle || spec.title}`, '', `The agent's doubt: ${doubt}`, '', ...opinionLines].join('\n'));
    ctx.status?.beginStep?.('review', 'Started verdict reviewer');
    const j = await run('resolve-judge', `resolve-judge-${spec.name}`, spec.judgePrompt || 'resolve-judge');
    conclusion = j.rc === 0 ? j.text.trim().slice(0, 1500) : '';
    ctx.status?.beginStep?.('review', 'Verdict finished');
  }
  fs.writeFileSync(at(ctx, spec.logFile), [
    `# ${spec.title} (${stamp()})`, '',
    `The agent's doubt: ${doubt}`, '',
    `Result: ${safeCount} of ${count} reviewers found it safe. ${all ? verdictText.safe : verdictText.unsafe}`, '',
    ...(conclusion ? ['## Conclusion', '', conclusion, ''] : []),
    ...opinionLines,
  ].join('\n'));
  return { ran: true, safe: all, safeCount, count, conclusion, opinions };
}
