import { describe, expect, it } from 'vitest';
import { formatRecoveryCli, stageRecoveryHint } from '../src/pipeline/hints.js';

describe('stageRecoveryHint diagnostics engine', () => {
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
    expect(recovery.autoAction?.env?.SDLC_AUTO_ANSWER).toBe('1');
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
    expect(recovery.manualAction?.file).toBe('plan.md');
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
    expect(recovery.manualAction?.file).toBe('log/red.json');
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
    expect(recovery.manualAction?.file).toBe('log/red.err');
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
    expect(recovery.manualAction?.file).toBe('log/now.json');
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
