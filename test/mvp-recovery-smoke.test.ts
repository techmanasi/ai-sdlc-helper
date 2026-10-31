import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runView } from '../src/runs/view.js';
import { stageRecoveryHint } from '../src/pipeline/hints.js';

describe('MVP Node/TS Zero Dead-End Recovery Smoke Tests', () => {
  it('runView attaches structured recovery guidance when run is paused or failed', () => {
    // Mock run context
    const mockCtx = {
      root: process.cwd(),
      reg: path.join(process.cwd(), '.git/sdlc-runs'),
      wtBase: path.join(process.cwd(), '.git/sdlc-worktrees'),
      backlogDir: path.join(process.cwd(), '.sdlc'),
      branchPrefix: 'sdlc/',
      env: {},
    };

    // Test paused stage diagnosis via runView
    const pausedView = runView(mockCtx as any, 'sample-item');
    // For not started, recovery is null
    expect(pausedView.state).toBe('not started');
    expect(pausedView.recovery).toBeNull();

    // Test a paused run with questions
    const specHint = stageRecoveryHint({
      slug: 'sample-item',
      stage: 'spec',
      state: 'paused',
      exitCode: 2,
      questions: [{ n: 1, title: 'Need clarification', answer: '', suggested: 'Default' }],
    });
    expect(specHint.stage).toBe('Spec');
    expect(specHint.diagnosis).toContain('1 clarifying question(s)');
    expect(specHint.autoAction?.command).toBe('ai-sdlc-helper pipeline sample-item --from spec');
    expect(specHint.autoAction?.env?.SDLC_AUTO_ANSWER).toBe('1');
    expect(specHint.escapeHatch?.command).toBe('ai-sdlc-helper pipeline sample-item --from plan');

    // Test an implement failure with test-issues
    const impHint = stageRecoveryHint({
      slug: 'sample-item',
      stage: 'implement',
      state: 'paused',
      exitCode: 2,
      hasTestIssues: true,
    });
    expect(impHint.stage).toBe('Implement');
    expect(impHint.diagnosis).toContain('claimed test defects');
    expect(impHint.autoAction?.command).toBe('ai-sdlc-helper pipeline sample-item --from test-repair');

    // Verify stageRecoveryHint integration for all 7 pipeline stages
    const stages = ['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'review', 'finalise'];
    for (const stage of stages) {
      const hint = stageRecoveryHint({
        slug: 'test-slug',
        stage,
        state: 'failed',
        exitCode: 1,
      });

      expect(hint.stage).toBeTruthy();
      expect(hint.diagnosis).toBeTruthy();
      expect(hint.diagnosis.length).toBeGreaterThan(10);
      expect(hint.autoAction).toBeDefined();
      expect(hint.autoAction?.command).toContain('ai-sdlc-helper pipeline');
      expect(hint.manualAction).toBeDefined();
      expect(hint.manualAction?.instruction).toBeTruthy();
      expect(hint.escapeHatch).toBeDefined();
      expect(hint.escapeHatch?.command).toBeTruthy();
    }
  });

  it('verifies npm package integrity and required manifest entries for Node/TS projects', () => {
    const pkgJsonPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

    // Verify engines specify Node >= 18
    expect(pkg.engines?.node).toMatch(/>=18/);

    // Verify bin executable entry point
    expect(pkg.bin?.['ai-sdlc-helper']).toBe('dist/bin.js');

    // Verify included files array
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('assets');

    // Verify dist/bin.js has node shebang
    const binPath = path.join(process.cwd(), 'dist/bin.js');
    if (fs.existsSync(binPath)) {
      const binContent = fs.readFileSync(binPath, 'utf8');
      expect(binContent.startsWith('#!/usr/bin/env node')).toBe(true);
    }
  });
});
