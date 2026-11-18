// Review reports, never edits: its findings go back through Red tests and Implement until it passes or the loop limit is reached.
import fs from 'node:fs';
import path from 'node:path';
import { exists } from '../util.js';
import { Exit, at, setAside, stop, tick, type Ctx } from './context.js';
import { runAgent, stageModelKey } from './agent.js';
import { redCommitTestFiles, resultsAt } from './gates.js';
import { resumeCommand } from './hints.js';
import { consumeHandoff } from './handoff.js';
import { keepError } from './errors.js';
import { implementStage, redTestsStage, stage, testRepairStage } from './stages.js';
import type { AgentStage } from './context.js';

export interface Finding { kind: 'blocker' | 'missing-test'; file: string; criterion: string; reason: string }
export interface Verdict { verdict: 'pass' | 'changes'; findings: Finding[] }
export interface RoundFinding extends Finding { status: 'open' | 'fixed' | 'still open' }
export interface ReviewRound { round: number; verdict: 'pass' | 'changes'; findings: RoundFinding[]; outcome: string }

const same = (a: Finding, b: Finding): boolean => a.file === b.file && a.criterion === b.criterion;
export const describeFinding = (f: Finding): string => `[${f.kind === 'blocker' ? 'blocker' : 'missing test'}] ${f.file}: ${f.criterion}: ${f.reason}`;

/** Reads and validates a review report: <file> (relative to the root) must be a JSON object with a verdict and finding lists. */
export function parseReview(root: string, file: string): Verdict | string {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return `${file} does not exist: Review wrote no report`;
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return `${file} is not valid JSON: ${(e as Error).message}`; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return `${file} must be a JSON object`;
  const o = data as Record<string, unknown>;
  if (o.verdict !== 'pass' && o.verdict !== 'changes') return `${file}: "verdict" must be "pass" or "changes"`;
  const findings: Finding[] = [];
  for (const [key, kind] of [['blockers', 'blocker'], ['missingTests', 'missing-test']] as const) {
    const list = o[key] === undefined ? [] : o[key];
    if (!Array.isArray(list)) return `${file}: "${key}" must be an array`;
    for (const item of list) {
      const f = item as Record<string, unknown>;
      if (!f || typeof f !== 'object' || typeof f.file !== 'string' || typeof f.criterion !== 'string' || typeof f.reason !== 'string') {
        return `${file}: every item of "${key}" needs a string file, criterion and reason`;
      }
      findings.push({ kind, file: f.file, criterion: f.criterion, reason: f.reason });
    }
  }
  if (o.verdict === 'pass' && findings.length) return `${file}: verdict is "pass" but it lists ${findings.length} finding(s)`;
  if (o.verdict === 'changes' && !findings.length) return `${file}: verdict is "changes" but it lists no finding`;
  return { verdict: o.verdict, findings };
}

const writeReview = (ctx: Ctx, file: string, v: Verdict): void => {
  const pick = (k: Finding['kind']) => v.findings.filter(f => f.kind === k).map(({ file: f, criterion, reason }) => ({ file: f, criterion, reason }));
  fs.writeFileSync(at(ctx, file), `${JSON.stringify({ verdict: v.verdict, blockers: pick('blocker'), missingTests: pick('missing-test') }, null, 2)}\n`);
};

const failReview = (ctx: Ctx, why: string): never => {
  keepError(ctx, 'review', why);
  ctx.err(`REVIEW FAILED: ${why}`);
  return stop(ctx, `REVIEW FAILED: ${why}. Resume at Review: ${resumeCommand(ctx.slug, 'review')}`, 1, 'review');
};

interface Saved { before: Map<string, Buffer | null> }

const treePaths = (ctx: Ctx): string[] => {
  const skip = [ctx.docs, ctx.log].filter(Boolean).map(d => `${d.replace(/\/$/, '')}/`);
  const raw = ctx.git.run('ls-files', '-z', '-m', '-o', '-d', '--exclude-standard');
  return [...new Set(raw.split('\0').filter(Boolean))].filter(f => f !== ctx.backlog && !skip.some(s => f.startsWith(s)));
};
const readOrNull = (ctx: Ctx, f: string): Buffer | null => { try { return fs.readFileSync(path.join(ctx.root, f)); } catch { return null; } };

/** The files that are changed in the tree now (source and tests, not the run's documents and logs), with their contents. */
function takeSnapshot(ctx: Ctx): Saved {
  return { before: new Map(treePaths(ctx).map(f => [f, readOrNull(ctx, f)] as const)) };
}

/** Undoes what an agent that must only report changed in the tree since <saved>; says so on the run output and in errors.log. Returns the paths. */
function undoTreeChanges(ctx: Ctx, saved: Saved, who: string): string[] {
  const now = new Set(treePaths(ctx));
  const changed: string[] = [];
  for (const f of new Set([...saved.before.keys(), ...now])) {
    if (saved.before.has(f)) {
      const was = saved.before.get(f)!;
      const is = readOrNull(ctx, f);
      if (!(was === null ? is === null : is !== null && was.equals(is))) changed.push(f);
    } else changed.push(f);
  }
  if (!changed.length) return [];
  const text = `${who} changed ${changed.length} file(s) although it only reports: ${changed.join(', ')}. The changes were undone and not committed; its verdict still counts.`;
  keepError(ctx, 'review', text);
  ctx.err(`ERROR: ${text}`);
  for (const f of changed) {
    const was = saved.before.get(f);
    const abs = path.join(ctx.root, f);
    if (was !== undefined) {
      if (was === null) fs.rmSync(abs, { force: true });
      else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, was); }
    } else if (ctx.git.tryRun('ls-files', '--error-unmatch', '--', f) !== null) ctx.git.run('checkout', 'HEAD', '--', f);
    else fs.rmSync(abs, { recursive: true, force: true });
  }
  return changed;
}

async function runReporter(ctx: Ctx, name: string, agentStage: AgentStage, extra: Record<string, string>): Promise<void> {
  const saved = takeSnapshot(ctx);
  ctx.promptExtra = extra;
  ctx.status?.beginStep?.('agent');
  try { await runAgent(ctx, name, agentStage); } finally { ctx.promptExtra = undefined; }
  await tick();
  ctx.status?.beginStep?.('guard');
  undoTreeChanges(ctx, saved, `the ${name} agent`);
}

const reviewerStage = (i: number): AgentStage => (i === 1 ? 'review' : `review-${i}`) as AgentStage;

/** One Review round: one reviewer, or in multi mode several plus a summariser; returns the merged verdict. */
async function reviewRound(ctx: Ctx, round: number): Promise<Verdict> {
  const { mode, reviewers } = ctx.config.review;
  const base = { REVIEW_ROUND: String(round) };
  setAside(ctx, [`${ctx.docs}/review.json`]);
  ctx.status.attempt = '1/1';
  ctx.status.write();
  if (mode !== 'multi') {
    await runReporter(ctx, 'review', 'review', { ...base, REVIEW_FILE: 'review.json' });
    const v = parseReview(ctx.root, `${ctx.docs}/review.json`);
    return typeof v === 'string' ? failReview(ctx, v) : v;
  }
  const stages = Array.from({ length: reviewers }, (_, i) => reviewerStage(i + 1));
  const all: AgentStage[] = [...stages, 'review-summary'];
  const seen = new Map<string, AgentStage>();
  for (const s of all) {
    const key = stageModelKey(ctx, s);
    const other = seen.get(key);
    if (other) failReview(ctx, `${other} and ${s} both use ${key}: reviewers and the summariser must use different models to be independent. Choose another model for one of them`);
    seen.set(key, s);
  }
  const reports: Verdict[] = [];
  const files: string[] = [];
  for (let i = 1; i <= reviewers; i++) {
    const file = `review-r${i}.json`;
    setAside(ctx, [`${ctx.docs}/${file}`]);
    await runReporter(ctx, `reviewer ${i}`, stages[i - 1], { ...base, REVIEW_FILE: file });
    const v = parseReview(ctx.root, `${ctx.docs}/${file}`);
    if (typeof v === 'string') failReview(ctx, v);
    reports.push(v as Verdict);
    files.push(`${ctx.docs}/${file}`);
  }
  const inputs = files.map((f, i) => `reviewer ${i + 1}: ${f}`).join('\n');
  await runReporter(ctx, 'review summary', 'review-summary', { ...base, REVIEW_FILE: 'review.json', REVIEW_INPUTS: inputs });
  const merged = parseReview(ctx.root, `${ctx.docs}/review.json`);
  const summary: Verdict = typeof merged === 'string' ? failReview(ctx, merged) : merged;
  // The summariser must keep every finding: one it dropped is put back, and that is said.
  const missing = reports.flatMap(r => r.findings).filter(f => !summary.findings.some(s => same(s, f)));
  if (missing.length) {
    const text = `the review summariser dropped ${missing.length} finding(s); they are put back: ${missing.map(describeFinding).join('; ')}`;
    keepError(ctx, 'review', text);
    ctx.err(`ERROR: ${text}`);
    summary.findings.push(...missing);
  }
  const out: Verdict = { verdict: summary.findings.length ? 'changes' : 'pass', findings: summary.findings };
  writeReview(ctx, `${ctx.docs}/review.json`, out);
  return out;
}

/** The rounds recorded so far for this run (empty when there are none). */
export function readReviewRounds(root: string, log: string): ReviewRound[] {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, log, 'review-rounds.json'), 'utf8'));
    return Array.isArray(data) ? data as ReviewRound[] : [];
  } catch { return []; }
}
const saveRounds = (ctx: Ctx, rounds: ReviewRound[]): void => {
  fs.mkdirSync(at(ctx, ctx.log), { recursive: true });
  fs.writeFileSync(at(ctx, `${ctx.log}/review-rounds.json`), `${JSON.stringify(rounds, null, 2)}\n`);
};

const findingsText = (round: number, findings: Finding[]): string => [
  `Review findings (round ${round}) that this task must fix. Write a test for each, that fails now for the stated reason and runs the real code; a finding that is already satisfied by the code needs no test but is reported as a wrong finding:`,
  ...findings.map(f => `- ${describeFinding(f)}`),
].join('\n');

/** Red tests with the findings in its prompt, then Implement (and Test repair, as in the main run). */
async function fixCycle(ctx: Ctx, round: number, findings: Finding[]): Promise<void> {
  ctx.promptExtra = { REVIEW_FINDINGS: findingsText(round, findings) };
  try {
    await redTestsStage(ctx);
  } catch (e) {
    if (e instanceof Exit && /^RED GATE FAILED/.test(e.reason || '')) {
      const text = `a Review finding was wrong or already fixed: its test passes before Implement. ${e.reason}\nFindings: ${findings.map(describeFinding).join('; ')}`;
      keepError(ctx, 'review', text);
      ctx.err(`ERROR: ${text}`);
    }
    throw e;
  } finally { ctx.promptExtra = undefined; }
  if (!ctx.origRedSha) ctx.origRedSha = ctx.redSha;
  await tick();
  resultsAt(ctx, ctx.origRedSha, `${ctx.log}/red.json`, redCommitTestFiles(ctx));
  await tick();
  const green = await implementStage(ctx);
  if (!green) {
    if (!exists(at(ctx, `${ctx.docs}/test-issues.md`))) {
      stop(ctx, `GREEN GATE FAILED after ${ctx.limits.maxAttempts} attempts and no test defect was claimed. See ${ctx.failLog}`);
    }
    await testRepairStage(ctx);
  }
}

/** Review: report, then loop Red tests -> Implement -> Review until it passes or review.maxLoops fixes were tried. */
export async function reviewLoop(ctx: Ctx): Promise<void> {
  const { maxLoops } = ctx.config.review;
  const rounds = readReviewRounds(ctx.root, ctx.log);
  let loops = 0;
  for (;;) {
    const round = rounds.length + 1;
    stage(ctx, `5/6 Review${round > 1 ? ` (round ${round})` : ''}`);
    await tick();
    const v = await reviewRound(ctx, round);
    if (ctx.handoff) { ctx.handoff = undefined; consumeHandoff(ctx); }
    // The earlier round's findings: fixed unless this round reports them again.
    const prev = rounds[rounds.length - 1];
    if (prev && prev.verdict === 'changes') {
      for (const f of prev.findings) if (f.status === 'open') f.status = v.findings.some(n => same(n, f)) ? 'still open' : 'fixed';
      prev.outcome = v.verdict === 'pass' ? 'fixed' : prev.outcome;
    }
    const entry: ReviewRound = { round, verdict: v.verdict, findings: v.findings.map(f => ({ ...f, status: 'open' as const })), outcome: v.verdict === 'pass' ? 'passed' : 'changes requested' };
    rounds.push(entry);
    saveRounds(ctx, rounds);
    if (v.verdict === 'pass') { ctx.out(` review round ${round}: pass`); return; }
    ctx.out(` review round ${round}: changes requested, ${v.findings.length} finding(s)`);
    for (const f of v.findings) ctx.out(`   ${describeFinding(f)}`);
    if (loops >= maxLoops) {
      entry.outcome = `stopped: ${maxLoops} fix loop(s) used, findings still open`;
      saveRounds(ctx, rounds);
      const lines = [`REVIEW NOT RESOLVED after ${maxLoops} fix loop(s): ${v.findings.length} finding(s) still open. This needs you:`, ...v.findings.map(f => `  ${describeFinding(f)}`),
        `Fix them by hand, then resume at Review: ${resumeCommand(ctx.slug, 'review')} (or at Implement: ${resumeCommand(ctx.slug, 'implement')})`];
      keepError(ctx, 'review', lines.join('\n'));
      stop(ctx, lines.join('\n'), 1, 'review');
    }
    loops++;
    entry.outcome = `fix loop ${loops} of ${maxLoops}`;
    saveRounds(ctx, rounds);
    await fixCycle(ctx, round, v.findings);
  }
}
