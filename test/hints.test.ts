import { describe, expect, it } from 'vitest';
import { formatRecoveryCli, stageRecoveryHint } from '../src/pipeline/hints.js';

describe('stageRecoveryHint diagnostics engine', () => {
  it('identifies an unsupported effort flag without suggesting an account or model switch', () => {
    const hint = stageRecoveryHint({ slug: 'item', stage: 'Implement', runOut: [
      `agent 'impl-1' failed: invalid model selection: --effort is not supported for model "claude-opus-4-6-thinking"`,
    ] });
    expect(hint.manualAction?.instruction).toContain('Clear the separate effort');
    expect(hint.autoAction?.command).toBe('ai-sdlc-helper pipeline item --from implement');
  });

  it('sends new tests that already pass back to Plan and Spec, not to Red tests', () => {
    const recovery = stageRecoveryHint({
      slug: 'x', stage: 'Red tests', state: 'failed', exitCode: 1,
      runOut: ['SDLC: x on branch b', 'RED GATE FAILED: 2 new test(s) already pass before implementation: they test behaviour that already exists, which the spec or plan did not identify as existing.', 'src/a.test.mjs :: one'],
    });
    expect(recovery.stage).toBe('Plan');
    expect(recovery.autoAction?.command).toBe('ai-sdlc-helper pipeline x --from plan');
    expect(recovery.escapeHatch?.command).toBe('ai-sdlc-helper pipeline x --from spec');
    expect(recovery.diagnosis).toContain('2 new test(s)');
  });

  it('sends a new test file that fails the project lint or typecheck back to Red tests, with its log', () => {
    const recovery = stageRecoveryHint({
      slug: 'x', stage: 'Red tests', state: 'failed', exitCode: 1,
      runOut: ['SDLC: x on branch b', 'RED GATE FAILED: 1 static check failure(s) in the new test files (npm run typecheck):', "TYPECHECK: web/test/code-search-ui.test.ts(59,39) TS2835: Relative import paths need explicit file extensions."],
    });
    expect(recovery.stage).toBe('Red tests');
    expect(recovery.autoAction?.command).toBe('ai-sdlc-helper pipeline x --from red-tests');
    expect(recovery.manualAction?.file).toBe('logs/red-checks.log');
    expect(recovery.diagnosis).toContain('static check');
  });

  it('sends repeated test names to Red tests only, with no escape hatch', () => {
    const recovery = stageRecoveryHint({
      slug: 'x', stage: 'Red tests', state: 'failed', exitCode: 1,
      runOut: ['SDLC: x on branch b', 'RED GATE FAILED: 2 test name(s) repeat in the new tests:', 'src/a.test.mjs :: one'],
    });
    expect(recovery.stage).toBe('Red tests');
    expect(recovery.autoAction?.command).toBe('ai-sdlc-helper pipeline x --from red-tests');
    expect(recovery.manualAction.file).toBe('logs/tests.log');
    expect(recovery.escapeHatch).toBeUndefined();
    expect(recovery.diagnosis).toContain('2 test name(s)');
  });

  it('keeps the Plan card for a vacuous stop after the Red tests retry', () => {
    const recovery = stageRecoveryHint({
      slug: 'x', stage: 'Red tests', state: 'failed', exitCode: 1,
      runOut: ['SDLC: x on branch b', 'RED GATE FAILED: 1 new test(s) already pass before implementation: they test behaviour that already exists. (after one Red tests retry)'],
    });
    expect(recovery.stage).toBe('Plan');
    expect(recovery.manualAction.file).toBe('logs/red-passing.md');
  });

  it('names the refusal to resume at Red tests once its commit exists, instead of "stage unknown" and a restart at Spec', () => {
    const recovery = stageRecoveryHint({
      slug: 'x', stage: '', state: 'failed', exitCode: 1,
      runOut: ['FROM=red-tests but the red-tests commit 1c3b784 already exists: use FROM=implement, FROM=test-repair or FROM=review, or restart the run to redo this stage'],
    });
    expect(recovery.stage).toBe('Red tests');
    expect(recovery.diagnosis).not.toContain('unknown');
    expect(recovery.autoAction?.command).toBe('ai-sdlc-helper pipeline x --from implement');
    expect(recovery.escapeHatch?.command).not.toContain('--from spec');
  });

  it('does the same for Plan, and leaves a later stage\'s own diagnosis alone when the refusal is only old output', () => {
    const line = 'FROM=plan but the red-tests commit 1c3b784 already exists: use FROM=implement, FROM=test-repair or FROM=review, or restart the run to redo this stage';
    expect(stageRecoveryHint({ slug: 'x', stage: '', state: 'failed', exitCode: 1, runOut: [line] }).stage).toBe('Plan');
    const later = stageRecoveryHint({ slug: 'x', stage: 'Test repair', state: 'failed', exitCode: 1, runOut: [line, 'SDLC: x on branch b', 'later output'] });
    expect(later.stage).toBe('Test repair');
  });

  it('explains a refusal only from the latest run\'s output, whatever stage the status keeps', () => {
    const line = 'FROM=red-tests but the red-tests commit 1c3b784 already exists: use FROM=implement, FROM=test-repair or FROM=review, or restart the run to redo this stage';
    const now = stageRecoveryHint({ slug: 'x', stage: 'Test repair', state: 'failed', exitCode: 1, runOut: ['SDLC: x on branch b', 'old', 'SDLC: x on branch b', line] });
    expect(now.stage).toBe('Red tests');
    const old = stageRecoveryHint({ slug: 'x', stage: 'Test repair', state: 'failed', exitCode: 1, runOut: ['SDLC: x on branch b', line, 'SDLC: x on branch b', 'later'] });
    expect(old.stage).toBe('Test repair');
  });

  it('names the resume fallback a resume, and leaves out a bailout that repeats it', () => {
    const r = stageRecoveryHint({ slug: 'x', stage: 'Commit', state: 'failed', exitCode: 1 });
    expect(r.autoAction?.command).toBe('ai-sdlc-helper pipeline x --from spec');
    expect(r.escapeHatch).toBeUndefined();
  });

  it('says a stop before the first stage resumes at the stage the run started from', () => {
    const r = stageRecoveryHint({
      slug: 'x', stage: '', state: 'failed', exitCode: 1, resumeFrom: 'implement',
      runOut: ['SDLC: x starting from implement', "ERROR: invalid effort 'extreme' for stage review (use low, medium, high, xhigh or max)"],
    });
    expect(r.stage).toBe('Setup (before Implement)');
    expect(r.diagnosis).toBe("invalid effort 'extreme' for stage review (use low, medium, high, xhigh or max)");
    expect(r.autoAction?.command).toBe('ai-sdlc-helper pipeline x --from implement');
    expect(r.escapeHatch).toEqual({ label: 'Resume pipeline from Spec', command: 'ai-sdlc-helper pipeline x --from spec' });
  });

  it('reads a stop before the first stage from its own run only, so an older failure is not its diagnosis', () => {
    const r = stageRecoveryHint({
      slug: 'x', stage: '', state: 'failed', exitCode: 1, resumeFrom: 'implement',
      runOut: ["Agent 'impl-1' crashed or failed: Insufficient balance", 'SDLC: x starting from implement', "ERROR: invalid effort 'extreme' for stage review"],
    });
    expect(r.diagnosis).toBe("invalid effort 'extreme' for stage review");
  });

  it('offers no bailout when the run already resumes at Spec', () => {
    const r = stageRecoveryHint({ slug: 'x', stage: '', state: 'failed', exitCode: 1, resumeFrom: 'spec', runOut: ['SDLC: x starting from spec', 'ERROR: bad setting'] });
    expect(r.stage).toBe('Setup (before Spec)');
    expect(r.autoAction?.command).toBe('ai-sdlc-helper pipeline x --from spec');
    expect(r.escapeHatch).toBeUndefined();
  });

  it('diagnoses Spec pause when questions are unanswered', () => {
    const recovery = stageRecoveryHint({
      slug: 'add-user-auth',
      stage: 'Spec',
      state: 'paused',
      exitCode: 2,
      questions: [
        { n: 1, title: 'Session TTL', answer: '', suggested: '24h' },
        { n: 2, title: 'OAuth Provider', answer: 'GitHub', suggested: 'GitHub' },
      ],
    });

    expect(recovery.stage).toBe('Spec');
    expect(recovery.diagnosis).toContain('1 clarifying question(s)');
    expect(recovery.autoAction?.label).toContain('Auto-answer');
    expect(recovery.autoAction?.command).toContain('ai-sdlc-helper pipeline add-user-auth --from spec');
    expect(recovery.autoAction?.env?.SDLC_AUTO_ACCEPT).toBe('1');
    expect(recovery.manualAction?.file).toBe('questions.md');
    expect(recovery.escapeHatch?.command).toContain('--from plan');
  });

  it('diagnoses Spec pause when permissions are pending', () => {
    const recovery = stageRecoveryHint({
      slug: 'add-user-auth',
      stage: 'Spec',
      state: 'paused',
      exitCode: 2,
      questions: [],
      permissions: [{ tool: 'bash', detail: 'curl http://example.com' }],
    });

    expect(recovery.stage).toBe('Spec');
    expect(recovery.diagnosis).toContain('1 tool authorization(s)');
    expect(recovery.autoAction?.command).toBe('ai-sdlc-helper permit add-user-auth allow all');
    expect(recovery.manualAction?.file).toBe('permissions.json');
  });

  it('diagnoses Plan stage failure', () => {
    const recovery = stageRecoveryHint({
      slug: 'feature-x',
      stage: 'Plan',
      state: 'failed',
      exitCode: 1,
    });

    expect(recovery.stage).toBe('Plan');
    expect(recovery.diagnosis).toContain('Plan generation stopped');
    expect(recovery.autoAction?.command).toContain('--from plan');
    expect(recovery.manualAction?.file).toBe('plan-1.md');
    expect(recovery.escapeHatch?.command).toContain('--from red-tests');
  });

  it('diagnoses Red tests premature pass (green on red)', () => {
    const recovery = stageRecoveryHint({
      slug: 'feature-x',
      stage: 'Red tests',
      state: 'failed',
      exitCode: 1,
      runOut: ['tests passed at red; they should fail on unimplemented source'],
    });

    expect(recovery.stage).toBe('Red tests');
    expect(recovery.diagnosis).toContain('green on red');
    expect(recovery.autoAction?.command).toContain('--from red-tests');
    expect(recovery.manualAction?.file).toBe('logs/red.json');
    expect(recovery.escapeHatch?.command).toContain('--from implement');
  });

  it('diagnoses Red tests compilation or runner failure', () => {
    const recovery = stageRecoveryHint({
      slug: 'feature-x',
      stage: 'Red tests',
      state: 'failed',
      exitCode: 1,
      runOut: ['SyntaxError: Unexpected token'],
    });

    expect(recovery.stage).toBe('Red tests');
    expect(recovery.diagnosis).toContain('failed to run');
    expect(recovery.manualAction?.file).toBe('logs/tests.log');
  });

  it('diagnoses Implement with claimed test issues and offers test-repair path', () => {
    const recovery = stageRecoveryHint({
      slug: 'feature-x',
      stage: 'Implement',
      state: 'paused',
      exitCode: 2,
      hasTestIssues: true,
    });

    expect(recovery.stage).toBe('Implement');
    expect(recovery.diagnosis).toContain('claimed test defects in test-issues.md');
    expect(recovery.autoAction?.label).toContain('Advance to Test Repair');
    expect(recovery.autoAction?.command).toContain('--from test-repair');
    expect(recovery.manualAction?.file).toBe('test-issues.md');
  });

  it('diagnoses Implement attempts exhausted', () => {
    const recovery = stageRecoveryHint({
      slug: 'feature-x',
      stage: 'Implement',
      state: 'failed',
      exitCode: 1,
      hasTestIssues: false,
    });

    expect(recovery.stage).toBe('Implement');
    expect(recovery.diagnosis).toContain('attempts exhausted');
    expect(recovery.autoAction?.command).toContain('--from implement');
    expect(recovery.manualAction?.file).toBe('logs/tests.json');
    expect(recovery.escapeHatch?.command).toContain('--from review');
  });

  it('diagnoses Test repair rejected due to vacuous repair (redcheck)', () => {
    const recovery = stageRecoveryHint({
      slug: 'feature-x',
      stage: 'Test repair',
      state: 'failed',
      exitCode: 1,
      runOut: ['REJECT: test failed at red but now PASSES on the unimplemented source'],
    });

    expect(recovery.stage).toBe('Test repair');
    expect(recovery.diagnosis).toContain('a repaired test now passes on the original red commit');
    expect(recovery.autoAction?.command).toContain('--from test-repair');
    expect(recovery.escapeHatch?.command).toContain('--from implement');
  });

  it('diagnoses Review test guard failure', () => {
    const recovery = stageRecoveryHint({
      slug: 'feature-x',
      stage: 'Review',
      state: 'failed',
      exitCode: 1,
      runOut: ['GUARD FAILED: review modified tests'],
    });

    expect(recovery.stage).toBe('Review');
    expect(recovery.diagnosis).toContain('review agent illegally modified test files');
    expect(recovery.autoAction?.command).toContain('--from review');
    expect(recovery.manualAction?.instruction).toContain('Discard test file modifications');
    expect(recovery.escapeHatch?.command).toContain('--from finalise');
  });

  it('diagnoses Finalise merge conflict', () => {
    const recovery = stageRecoveryHint({
      slug: 'feature-x',
      stage: 'Finalise',
      state: 'paused',
      exitCode: 2,
    });

    expect(recovery.stage).toBe('Finalise');
    expect(recovery.diagnosis).toContain('Finalise stage paused');
    expect(recovery.autoAction?.command).toContain('--from finalise');
    expect(recovery.manualAction?.instruction).toContain('resolve any merge conflicts');
    expect(recovery.escapeHatch?.command).toContain('git push origin sdlc/feature-x');
  });

  it('formats recovery details into clean CLI text with 3 distinct paths', () => {
    const recovery = stageRecoveryHint({
      slug: 'demo-slug',
      stage: 'Implement',
      state: 'failed',
      exitCode: 1,
    });
    const cliOutput = formatRecoveryCli(recovery);

    expect(cliOutput).toContain('SDLC PIPELINE PAUSED / STOPPED AT: Implement');
    expect(cliOutput).toContain('DIAGNOSIS:');
    expect(cliOutput).toContain('1. Auto:');
    expect(cliOutput).toContain('2. Manual:');
    expect(cliOutput).toContain('3. Bailout:');
  });
});
