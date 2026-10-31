// The stages: Spec, Plan, Red tests, Implement, Test repair, Review and Ship, each with its gate.
import fs from 'node:fs';
import path from 'node:path';
import { mark } from '../changes/index.js';
import {
  diffcheck, mergeRetry, namecheck, precheck, redcheck, resumecheck, retryArgs, unclaimed,
} from '../testcheck/checks.js';
import { runSuites } from '../runners/run.js';
import { exists } from '../util.js';
import { answerQuestions, parseQuestions } from '../runs/view.js';
import { at, stamp, stop, stopIfAborted, tick, type Ctx } from './context.js';
import { promptValues, runAgent, runAudit, stageFlags } from './agent.js';
import { resultsAt, resultsNow, successCheck, targetTestFiles, testsPass } from './gates.js';
import { renderPrompt } from './prompts.js';
import { resumeCommand, resumeHint } from './hints.js';
import { finalise } from './finalise.js';
import { installDeps } from './deps.js';

const short = (sha: string) => sha.slice(0, 7);
const redPattern = (slug: string) => `^test(${slug}): add failing tests`;
const repairPattern = (slug: string) => `^test(${slug}): repair invalid tests`;

/** Credits the files changed since the last mark to <stage> (<log>/stage-files.json, shown per stage in the pane). */
export function markStage(ctx: Ctx, stage: string): void {
  try { mark(at(ctx, `${ctx.log}/stage-files.json`), stage, { root: ctx.root, maxBytes: ctx.config.ship.maxFileBytes }); } catch { /* best effort */ }
}

/** Starts a stage: its header ("== 1/6 Spec"), the previous stage's files, and the status ("Spec"). */
export function stage(ctx: Ctx, title: string): void {
  stopIfAborted(ctx);
  ctx.out('');
  ctx.out(`== ${title}`);
  markStage(ctx, ctx.status.stage);
  ctx.status.stage = title.replace(/^[0-9a-z]+(\/[0-9]+)? /, '').replace(/ \(.*/, '');
  ctx.status.agent = '';
  ctx.status.attempt = '';
  ctx.status.write();
}

const countLines = (file: string, re: RegExp) => (exists(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(l => re.test(l)).length : 0);

export function formatCheckFailures(ctx: Ctx): string[] {
  const testsJson = at(ctx, `${ctx.log}/tests.json`);
  const lines: string[] = [];
  if (exists(testsJson)) {
    try {
      const res = JSON.parse(fs.readFileSync(testsJson, 'utf8'));
      if (res && Array.isArray(res.suiteErrors)) {
        for (const e of res.suiteErrors) {
          const msg = String(e.message || '').trim().split('\n')[0];
          lines.push(`ERROR: suite ${e.file || '(unknown)'} failed to run${msg ? `: ${msg}` : ''}`);
        }
      }
      if (res && Array.isArray(res.tests)) {
        const failed = res.tests.filter((t: any) => t.status === 'failed');
        for (const t of failed) {
          const msg = String(t.message || '').trim().split('\n')[0];
          lines.push(`FAIL: ${t.file} :: ${t.name}${msg ? ` (${msg})` : ''}`);
        }
      }
    } catch { /* best effort */ }
  }
  if (!lines.length && ctx.failLog) {
    const failFile = at(ctx, ctx.failLog);
    if (exists(failFile)) {
      const raw = fs.readFileSync(failFile, 'utf8').trim().split('\n');
      const sample = raw.filter(l => /^(ERROR|FAIL|AssertionError)/.test(l.trim())).slice(0, 5);
      if (sample.length) {
        for (const s of sample) lines.push(s.trim());
      } else {
        lines.push(`checks failed (see ${ctx.failLog})`);
      }
    } else {
      lines.push(`checks failed (see ${ctx.failLog})`);
    }
  }
  return lines;
}

export function isAutoAccept(ctx: Ctx): boolean {
  const val = ctx.env.SDLC_AUTO_ACCEPT;
  return !!val && val !== '0' && val.toLowerCase() !== 'false';
}

export function autoAcceptQuestions(file: string): void {
  const text = fs.readFileSync(file, 'utf8');
  const qs = parseQuestions(text);
  if (qs.length > 0) {
    const answers: Record<string, string> = {};
    for (const q of qs) answers[String(q.n)] = 'accept';
    answerQuestions(file, answers);
  } else {
    fs.writeFileSync(file, text.replace(/^(\*\*Answer:\*\*)\s*$/gm, '$1 accept'));
  }
}

/**
 * An answered questions.md becomes the next round in decisions.md (so nothing is asked twice) and is removed; an
 * unanswered one pauses the run (exit 2).
 */
function recordAnswers(ctx: Ctx): void {
  const questions = at(ctx, `${ctx.docs}/questions.md`);
  const decisions = at(ctx, `${ctx.docs}/decisions.md`);
  if (!exists(questions)) return;
  const total = countLines(questions, /^### Q/);
  const answered = countLines(questions, /^\*\*Answer:\*\*\s*\S/);
  if (total === 0 || answered < total) {
    stop(ctx, `PAUSED: ${answered}/${total} questions answered in ${ctx.docs}/questions.md. Fill every '**Answer:**' line and rerun.`, 2);
  }
  const round = countLines(decisions, /^## Round /) + 1;
  if (!exists(decisions)) fs.writeFileSync(decisions, `# Decisions for ${ctx.slug}\n`);
  const body = fs.readFileSync(questions, 'utf8').replace(/\n$/, '').split('\n').filter(l => !l.startsWith('# ')).map(l => `${l}\n`).join('');
  fs.appendFileSync(decisions, `\n## Round ${round} (${stamp().slice(0, 10)})\n\n${body}`);
  fs.rmSync(questions);
  ctx.out(`   recorded round ${round} answers in ${ctx.docs}/decisions.md`);
}

/** Spec: the agent writes specs-1.md, or questions.md (the run pauses for answers). */
export async function specStage(ctx: Ctx): Promise<void> {
  stage(ctx, '1/6 Spec');
  await tick();
  const questions = at(ctx, `${ctx.docs}/questions.md`);
  if (exists(questions) && isAutoAccept(ctx)) autoAcceptQuestions(questions);
  recordAnswers(ctx);
  const MAX_SPEC_ROUNDS = 5;
  while (true) {
    const round = countLines(at(ctx, `${ctx.docs}/decisions.md`), /^## Round /) + 1;
    ctx.status.attempt = `${round}/${MAX_SPEC_ROUNDS}`;
    ctx.status.write();
    await runAgent(ctx, `spec-${round}`, 'spec');
    if (exists(questions)) {
      if (isAutoAccept(ctx) && round < MAX_SPEC_ROUNDS) {
        ctx.out(`   SDLC_AUTO_ACCEPT: auto-accepting suggestions in ${ctx.docs}/questions.md (round ${round})`);
        autoAcceptQuestions(questions);
        recordAnswers(ctx);
        continue;
      }
      stop(ctx, `PAUSED: new questions in ${ctx.docs}/questions.md. Fill each '**Answer:**' (write 'accept' to take the suggestion) and rerun.`, 2);
    }
    break;
  }
  if (!exists(at(ctx, `${ctx.docs}/specs-1.md`))) stop(ctx, 'Spec not produced');
}

/** Plan: the agent writes plan-1.md, or questions.md for open technical questions (the run pauses for answers). */
export async function planStage(ctx: Ctx): Promise<void> {
  stage(ctx, '2/6 Plan');
  await tick();
  if (!exists(at(ctx, `${ctx.docs}/specs-1.md`))) stop(ctx, `FROM=${ctx.from} but ${ctx.docs}/specs-1.md is missing: run Spec first`);
  const questions = at(ctx, `${ctx.docs}/questions.md`);
  if (ctx.from === 'plan') {
    if (exists(questions) && isAutoAccept(ctx)) autoAcceptQuestions(questions);
    recordAnswers(ctx);
  }
  const MAX_PLAN_ROUNDS = 5;
  for (let attempt = 1; attempt <= MAX_PLAN_ROUNDS; attempt++) {
    ctx.status.attempt = `${attempt}/${MAX_PLAN_ROUNDS}`;
    ctx.status.write();
    await runAgent(ctx, 'plan', 'plan');
    if (exists(questions)) {
      if (isAutoAccept(ctx) && attempt < MAX_PLAN_ROUNDS) {
        ctx.out(`   SDLC_AUTO_ACCEPT: auto-accepting suggestions in ${ctx.docs}/questions.md (plan attempt ${attempt})`);
        autoAcceptQuestions(questions);
        recordAnswers(ctx);
        continue;
      }
      stop(ctx, `PAUSED: the Plan agent has open questions in ${ctx.docs}/questions.md. Fill each '**Answer:**' (write 'accept' to take the suggestion) and resume: ${resumeCommand(ctx.slug, 'plan')}`, 2);
    }
    break;
  }
  if (!exists(at(ctx, `${ctx.docs}/plan-1.md`))) stop(ctx, 'Plan not produced');
}

/** Red tests: the agent writes failing tests; they must fail (red gate), then they are committed and locked. */
export async function redTestsStage(ctx: Ctx): Promise<void> {
  stage(ctx, '3/6 Red tests (red gate)');
  await tick();
  if (!exists(at(ctx, `${ctx.docs}/plan-1.md`))) stop(ctx, `FROM=${ctx.from} but ${ctx.docs}/plan-1.md is missing: run Plan first`);
  ctx.status.attempt = '1/1';
  ctx.status.write();
  await runAgent(ctx, 'tests', 'red-tests');
  await tick();
  if (testsPass(ctx)) stop(ctx, `RED GATE FAILED: new tests pass before implementation. See ${ctx.log}/tests.log`);
  await tick();
  ctx.git.run('add', '-A', '--', ctx.docs);
  ctx.git.addTests(ctx.layout.testPathspecs);
  ctx.git.run('commit', '-q', '-m', `test(${ctx.slug}): add failing tests and spec/plan docs`);
  ctx.redSha = ctx.git.head();
  ctx.lockSha = ctx.redSha;
}

/**
 * A resumed run (FROM implement, test-repair or review): the tests are locked at the commit the run continues from (the
 * branch head), so what the developer committed meanwhile (a merge of the base branch, say) is not a change to the tests.
 */
export function resumeAtTests(ctx: Ctx): void {
  ctx.lockSha = ctx.git.head();
  if (ctx.from === 'test-repair') {
    stage(ctx, '4b Test repair (only because the Implement agent claimed test defects)');
    ctx.redSha = ctx.git.findCommit([redPattern(ctx.slug)]);
    const errs = resumecheck(ctx.keys, ctx.redSha, `${ctx.docs}/test-issues.md`, ctx.slug, ctx.lockSha);
    if (errs.length) { ctx.err(errs.map(e => `REJECT: ${e}`).join('\n')); stop(ctx, null); }
  } else {
    // Review and Finalise resume from the latest locked tests (the red-tests commit, or the Test repair commit after it).
    ctx.redSha = ctx.git.findCommit([redPattern(ctx.slug), ...(ctx.from === 'review' || ctx.from === 'finalise' || (ctx.from as string) === 'ship' ? [repairPattern(ctx.slug)] : [])]);
    if (!ctx.redSha) stop(ctx, `FROM=${ctx.from} but no red-tests commit found for ${ctx.slug}`);
  }
  ctx.out(`Resuming at ${ctx.from} from tests commit ${short(ctx.redSha)}`);
}

/** Implement: up to maxAttempts agent runs until the tests and the integration suite pass; the tests must not change. */
export async function implementStage(ctx: Ctx): Promise<boolean> {
  const { maxAttempts } = ctx.limits;
  stage(ctx, `4/6 Implement (green gate, max ${maxAttempts} attempts)`);
  await tick();
  const issues = at(ctx, `${ctx.docs}/test-issues.md`);
  if (exists(issues)) ctx.out('WARNING: test-issues.md exists and will be deleted; use FROM=test-repair to resume at Test repair');
  fs.rmSync(issues, { force: true });
  installDeps(ctx);
  await tick();
  // A resumed run never trusts a previous run's test log: the first attempt reads one from this run.
  if (ctx.fromN === 4) { testsPass(ctx, { targetFiles: targetTestFiles(ctx) }); await tick(); }
  for (let i = 1; i <= maxAttempts; i++) {
    ctx.out(` attempt ${i}`);
    ctx.status.attempt = `${i}/${maxAttempts}`;
    await runAgent(ctx, `impl-${i}`, 'implement');
    await tick();
    const touched = ctx.git.testsChangedSince(ctx.lockSha, ctx.layout.testPathspecs);
    if (touched.length) {
      ctx.out('GUARD FAILED: tests were modified during implementation');
      for (const f of touched) ctx.out(f);
      stop(ctx, null);
    }
    await tick();
    if (await successCheck(ctx)) { ctx.out(' tests and integration green'); return true; }
    await tick();
    const fails = formatCheckFailures(ctx);
    if (fails.length) {
      ctx.out(`   !! attempt ${i} failed: ${fails.length} failing check${fails.length > 1 ? 's' : ''}`);
      for (const f of fails.slice(0, 8)) ctx.out(`      ${f}`);
      if (fails.length > 8) ctx.out(`      ... and ${fails.length - 8} more`);
    } else {
      ctx.out(`   !! attempt ${i} failed (see ${ctx.failLog || `${ctx.log}/tests.log`})`);
    }
    if (exists(issues)) {
      ctx.out(`   agent claimed test defect in ${ctx.docs}/test-issues.md`);
    }
  }
  return false;
}

/** Re-runs the unclaimed failing tests of now.json once; those that pass are flaky (merged back as passed, listed). */
function retryUnclaimed(ctx: Ctx): void {
  const now = `${ctx.log}/now.json`;
  const issues = `${ctx.docs}/test-issues.md`;
  let keys: string[];
  try { keys = unclaimed(ctx.keys, now, issues); } catch (e) { ctx.err(`ERROR: ${(e as Error).message}`); stop(ctx, null); }
  if (!keys.length) return;
  for (const f of fs.readdirSync(at(ctx, ctx.log)).filter(f => /^retry-.*\.json$/.test(f))) fs.rmSync(at(ctx, `${ctx.log}/${f}`));
  const outs: string[] = [];
  retryArgs(ctx.keys, keys).forEach(([file, ...names], i) => {
    const out = `${ctx.log}/retry-${i + 1}.json`;
    try {
      const r = runSuites(ctx.config, { root: ctx.root, files: [file], names, env: ctx.env });
      if (!('error' in r)) fs.writeFileSync(at(ctx, out), `${JSON.stringify(r.merged)}\n`);
    } catch { /* an unreadable re-run is ignored */ }
    outs.push(out);
  });
  for (const key of mergeRetry(ctx.keys, now, issues, `${ctx.log}/flaky-tests.md`, outs)) ctx.out(`WARNING: flaky test passed on re-run, not rejected: ${key}`);
}

/**
 * Test repair, only when the Implement agent claimed test defects (test-issues.md): mechanical checks, the repair agent,
 * more checks, an independent auditor, then the tests are committed and locked again. Any reject restores the tests.
 */
export async function testRepairStage(ctx: Ctx): Promise<void> {
  stage(ctx, '4b Test repair (only because the Implement agent claimed test defects)');
  await tick();
  const specs = ctx.layout.testPathspecs;
  const issues = `${ctx.docs}/test-issues.md`;
  const reject = (why: string, hint = false): never => {
    ctx.out(`TEST REPAIR REJECTED: ${why}`);
    ctx.git.restoreTests(ctx.lockSha, specs);
    ctx.out(`   tests restored to ${ctx.lockSha}. See ${ctx.log}/ and ${issues}`);
    if (hint) resumeHint(ctx);
    return stop(ctx, null);
  };
  const rejects = (check: () => string[]) => {
    let errs: string[];
    try { errs = check(); } catch (e) { errs = [(e as Error).message]; }
    if (errs.length) ctx.err(errs.map(e => `REJECT: ${e}`).join('\n'));
    return errs.length > 0;
  };

  resultsNow(ctx, `${ctx.log}/now.json`);
  await tick();
  retryUnclaimed(ctx);
  await tick();
  const pre = () => { try { return precheck(ctx.keys, `${ctx.log}/now.json`, issues, ctx.limits.maxRepairTests); } catch (e) { return [(e as Error).message]; } };
  if (ctx.from === 'test-repair') {
    // FROM=test-repair: fail early, before any agent runs and before anything is restored.
    const errs = pre();
    fs.writeFileSync(at(ctx, `${ctx.log}/precheck.err`), errs.map(e => `REJECT: ${e}\n`).join(''));
    if (errs.length) { ctx.err('REJECT: claims would not pass the pre-check'); ctx.err(errs.map(e => `REJECT: ${e}`).join('\n')); stop(ctx, null); }
  }
  if (rejects(pre)) reject('claims fail pre-check (see above)', true);
  const srcBefore = ctx.git.sourceHash(ctx.layout.sourceDirs, specs, ctx.config.backlogDir);
  ctx.status.attempt = '1/1';
  ctx.status.write();
  await runAgent(ctx, 'test-repair', 'test-repair');
  await tick();
  const report = at(ctx, `${ctx.docs}/test-repair-1.md`);
  if (exists(report) && /^NO REPAIR NEEDED/m.test(fs.readFileSync(report, 'utf8'))) reject('repair agent says the tests are right; the source is wrong');
  if (ctx.git.sourceHash(ctx.layout.sourceDirs, specs, ctx.config.backlogDir) !== srcBefore) reject('source files were modified during test repair');
  if (rejects(() => diffcheck(ctx.keys, ctx.lockSha, issues))) reject('diff check failed (see above)');
  await tick();
  fs.writeFileSync(at(ctx, `${ctx.log}/test-repair.diff`), ctx.git.run('diff', ctx.lockSha, '--', ...specs));
  resultsNow(ctx, `${ctx.log}/after.json`);
  await tick();
  if (rejects(() => namecheck(ctx.keys, `${ctx.log}/red.json`, `${ctx.log}/after.json`))) reject('tests were removed or renamed');
  const changedTests = [...new Set([...ctx.git.testsChangedSince(ctx.lockSha, specs), ...ctx.git.lines('ls-files', '--others', '--exclude-standard', '--', ...specs)])].sort();
  resultsAt(ctx, ctx.origRedSha, `${ctx.log}/repaired-on-red.json`, changedTests);
  await tick();
  if (rejects(() => redcheck(ctx.keys, `${ctx.log}/red.json`, `${ctx.log}/repaired-on-red.json`))) reject('a repaired test no longer fails on the unimplemented source');

  const flags = stageFlags(ctx, 'test-audit');
  const auditPrompt = renderPrompt('test-audit', promptValues(ctx), ctx.guide, ctx.promptsDir);
  if ((await runAudit(ctx, auditPrompt, flags)) !== 0) reject('auditor failed to run', true);
  const audit = fs.readFileSync(at(ctx, `${ctx.log}/test-audit.log`), 'utf8');
  fs.writeFileSync(at(ctx, `${ctx.docs}/test-audit.md`), audit);
  const verdict = audit.split('\n').filter(l => /^VERDICT: (VALID|INVALID)$/.test(l)).pop();
  if (verdict !== 'VERDICT: VALID') reject('independent auditor did not return VERDICT: VALID');
  await tick();
  if (!(await successCheck(ctx))) reject(`checks still fail after an audited repair; see ${ctx.failLog}`);
  ctx.git.run('add', '-A', '--', ctx.docs);
  ctx.git.addTests(specs);
  ctx.git.run('commit', '-q', '-m', `test(${ctx.slug}): repair invalid tests (mechanically checked and audited)`);
  ctx.redSha = ctx.git.head();
  ctx.lockSha = ctx.redSha;
  ctx.out(` test repair accepted; tests locked again at ${short(ctx.redSha)}`);
}

/** Review: the agent reviews and fixes the source; the tests must not change and every check must still pass. */
export async function reviewStage(ctx: Ctx): Promise<void> {
  stage(ctx, '5/6 Review');
  await tick();
  ctx.status.attempt = '1/1';
  ctx.status.write();
  await runAgent(ctx, 'review', 'review');
  await tick();
  if (ctx.git.testsChangedSince(ctx.lockSha, ctx.layout.testPathspecs).length) stop(ctx, 'GUARD FAILED: review modified tests');
  await tick();
  if (!(await successCheck(ctx))) stop(ctx, `Checks broke after review. See ${ctx.failLog}`);
}

/** Finalise: commits the cycle's files, ticks the backlog item, and optionally creates a PR. */
export async function finaliseStage(ctx: Ctx): Promise<void> {
  stage(ctx, '6/6 Finalise');
  await tick();
  ctx.status.attempt = '1/1';
  ctx.status.write();
  let createPr = ctx.env.SDLC_CREATE_PR === '1' || ctx.env.CREATE_PR === '1';
  const optFile = path.join(ctx.root, ctx.log, 'finalise-options.json');
  if (fs.existsSync(optFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(optFile, 'utf8'));
      if (typeof d.createPr === 'boolean') createPr = d.createPr;
    } catch { /* best effort */ }
  }
  const res = finalise({
    git: ctx.git, slug: ctx.slug, docs: ctx.docs, baseline: `${ctx.log}/baseline.json`, backlog: ctx.backlog,
    maxBytes: ctx.config.finalise.maxFileBytes, envExample: ctx.config.finalise.envExample,
    createPr, baseBranch: ctx.config.git.base || undefined,
    out: l => ctx.out(l), err: l => ctx.err(l),
  });
  if (res.pr) {
    ctx.out(`Review pull request: ${res.pr}`);
  } else {
    ctx.out(`Review with: git log --oneline ${ctx.redSha}~1..HEAD ; then open a PR.`);
  }
}

export const shipStage = finaliseStage;

/** Plan and Red tests refuse to run again once the red-tests commit exists. */
export function refuseRedone(ctx: Ctx): void {
  const existing = ctx.git.findCommit([redPattern(ctx.slug)], '%h');
  if (existing) {
    stop(ctx, `FROM=${ctx.from} but the red-tests commit ${existing} already exists: use FROM=implement, FROM=test-repair or FROM=review, or restart the run to redo this stage`);
  }
}
