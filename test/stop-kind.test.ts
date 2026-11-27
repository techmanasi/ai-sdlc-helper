import { describe, expect, test } from 'vitest';
import { stopKind, type StopKindView } from '../web/ui/src/stopKind.js';
import type { RunView } from '../web/ui/src/api.js';

/** A run view with only what the stop kind reads; the rest of the fields the server sends do not matter here. */
function view(over: Partial<RunView> = {}): RunView {
  return {
    slug: 'item', state: 'failed', stage: 'Implement', agent: '', model: '', effort: '', models: {},
    attempt: '', note: '', agentStarted: '', runStarted: '', updated: '', record: null, dir: null, worktree: null,
    branch: 'sdlc/item', base: 'main', message: '', questions: [], permissions: [], deniedPermissions: [],
    tests: null, stageFiles: {}, changes: null, tail: [], docs: [], discarded: '', resumeFrom: 'implement',
    handoff: null, redCommit: '', gitAgeMs: null, attempts: [], stepPlan: {},
    ...over,
  } as RunView;
}

const kindOf = (v: RunView): string => stopKind(v)?.kind ?? 'none';

describe('the kind of stop a run is in', () => {
  test('Questions: a paused run waits for an answer it asked for', () => {
    const k = stopKind(view({
      state: 'paused',
      questions: [
        { n: 1, title: 'Session TTL', body: '', suggested: '24h', answer: '' },
        { n: 2, title: 'Provider', body: '', suggested: 'GitHub', answer: 'GitHub' },
      ],
      recovery: { stage: 'Spec', diagnosis: 'Spec agent generated 1 clarifying question(s) requiring answers before planning.' },
    })) as StopKindView;
    expect(k.kind).toBe('questions');
    expect(k.label).toBe('Questions');
    expect(k.glyph).toBe('?');
    expect(k.tone).toBe('s-paused');
    expect(k.cause).toContain('clarifying question');
    expect(k.actions).toEqual([{ label: 'Answer questions', verb: 'answer' }]);
  });

  test('Permission: a refused action waits for Allow or Deny', () => {
    const k = stopKind(view({
      state: 'paused',
      permissions: [{ stage: 'Spec', tool: 'bash', detail: 'curl http://example.com', rule: 'curl', protected: false }],
      recovery: { stage: 'Spec', diagnosis: 'Spec agent requested 1 tool authorization(s) requiring user permission.' },
    })) as StopKindView;
    expect(k.kind).toBe('permission');
    expect(k.label).toBe('Permission');
    expect(k.glyph).toBe('P');
    expect(k.cause).toContain('tool authorization');
    expect(k.actions.map(a => a.verb)).toEqual(['allow', 'deny']);
  });

  test('Permission: a denied action of a paused run is a permission too', () => {
    const k = stopKind(view({
      state: 'paused',
      deniedPermissions: [{ stage: 'Spec', tool: 'bash', detail: 'curl http://example.com', rule: 'curl', protected: false }],
      recovery: { stage: 'Spec', diagnosis: 'Spec agent requested 1 tool authorization(s) requiring user permission.' },
    })) as StopKindView;
    expect(k.kind).toBe('permission');
    expect(k.actions.map(a => a.verb)).toEqual(['allow']);
  });

  test('Account: the failure says the account is the problem', () => {
    const k = stopKind(view({
      state: 'failed',
      recovery: { stage: 'Implement', diagnosis: "Agent 'impl-1' reached quota or rate limit: quota exceeded", kind: 'account' },
    })) as StopKindView;
    expect(k.kind).toBe('account');
    expect(k.label).toBe('Account');
    expect(k.glyph).toBe('$');
    expect(k.cause).toContain('quota');
    expect(k.actions.map(a => a.verb)).toEqual(['retry', 'resume']);
  });

  test('Waiting: the status note says the run waits for a limit to reset', () => {
    const k = stopKind(view({
      state: 'paused',
      note: 'usage limit, resets 1:10am (Asia/Dubai)',
      recovery: { stage: 'Implement', diagnosis: 'The run paused at Implement; see logs/run.out for the cause.' },
    })) as StopKindView;
    expect(k.kind).toBe('waiting');
    expect(k.label).toBe('Waiting');
    expect(k.glyph).toBe('◷');
    expect(k.cause).toBe('usage limit, resets 1:10am (Asia/Dubai)');
    expect(k.actions.map(a => a.verb)).toEqual(['retry']);
  });

  test('Stopped by you: the user stopped the run', () => {
    for (const state of ['stopped', 'interrupted'] as const) {
      const k = stopKind(view({ state, resumeFrom: 'plan' })) as StopKindView;
      expect(k.kind).toBe('stopped');
      expect(k.label).toBe('Stopped by you');
      expect(k.glyph).toBe('■');
      expect(k.tone).toBe('s-not-started');
      expect(k.actions).toEqual([{ label: 'Resume from Plan', verb: 'resume' }]);
    }
  });

  test('Repository: the stop was about the branch, not the code', () => {
    const k = stopKind(view({
      state: 'failed',
      recovery: { stage: 'Plan', diagnosis: "GitHub's main has commits by someone else, and SDLC_MOVE_BRANCH keeps the run on that branch, so the run stopped instead of taking them in." },
    })) as StopKindView;
    expect(k.kind).toBe('repository');
    expect(k.label).toBe('Repository');
    expect(k.glyph).toBe('R');
    expect(k.cause).toContain('commits by someone else');
    expect(k.actions.map(a => a.verb)).toEqual(['resume']);
  });

  test('Repository: a conflicting pull request is a repository stop', () => {
    const k = stopKind(view({ state: 'failed', prConflicts: 'conflicting' })) as StopKindView;
    expect(k.kind).toBe('repository');
  });

  test('Repository: a Resolve conflicts stop is a repository stop', () => {
    const k = stopKind(view({ state: 'failed', recovery: { stage: 'Resolve conflicts', diagnosis: 'Resolve conflicts stopped before pushing; the branch is back where it was.' } })) as StopKindView;
    expect(k.kind).toBe('repository');
  });

  test('a recorded process failure is a Process, even when its text mentions git', () => {
    const k = stopKind(view({
      state: 'failed',
      recovery: { stage: 'Implement', diagnosis: "Agent 'impl-1' crashed or failed: fatal: not a git repository", kind: 'process' },
    })) as StopKindView;
    expect(k.kind).toBe('process');
  });

  test('Stage check: the stage gate failed on its own tests', () => {
    const k = stopKind(view({
      state: 'failed',
      tests: { passed: 3, failed: 2, skipped: 0, total: 5 },
      recovery: { stage: 'Implement', diagnosis: 'Implementation attempts exhausted or test checks still failing.' },
    })) as StopKindView;
    expect(k.kind).toBe('stage-check');
    expect(k.label).toBe('Stage check');
    expect(k.glyph).toBe('✗');
    expect(k.tone).toBe('s-failed');
    expect(k.actions.map(a => a.verb)).toEqual(['retry', 'resume']);
  });

  test('Stage check: a recorded failing gate is a stage check', () => {
    const k = stopKind(view({
      state: 'failed',
      attempts: [{ at: '2026-01-01T00:00:00Z', stage: 'Implement', agent: 'impl-1', durationSec: 10, exitCode: 1, responseChars: 0, turns: 1, tokens: 0, denied: [], filesChanged: [], warnings: [], gate: { failing: ['tests/a.test.mjs :: one'], warnings: [] } }],
      recovery: { stage: 'Implement', diagnosis: 'The run stopped at Implement; see logs/run.out for the cause.' },
    })) as StopKindView;
    expect(k.kind).toBe('stage-check');
  });

  test('Loop: Review sent its findings back and ran out of fix loops', () => {
    const k = stopKind(view({
      state: 'failed',
      stage: 'Review',
      resumeFrom: 'review',
      reviewRounds: [{ round: 1, verdict: 'changes', outcome: 'stopped: 3 fix loop(s) used, findings still open', findings: [] }],
      recovery: { stage: 'Review', diagnosis: 'Code review identified blocking issues or checks broke after review.' },
    })) as StopKindView;
    expect(k.kind).toBe('loop');
    expect(k.label).toBe('Loop');
    expect(k.glyph).toBe('↻');
    expect(k.cause).toBe('stopped: 3 fix loop(s) used, findings still open');
    expect(k.actions).toEqual([{ label: 'Resume from Review', verb: 'resume' }]);
  });

  test('Process: the agent crashed', () => {
    const k = stopKind(view({
      state: 'failed',
      recovery: { stage: 'Implement', diagnosis: "Agent 'impl-1' crashed or failed: ENOENT", kind: 'process' },
    })) as StopKindView;
    expect(k.kind).toBe('process');
    expect(k.label).toBe('Process');
    expect(k.glyph).toBe('!');
    expect(k.tone).toBe('s-failed');
    expect(k.cause).toContain('crashed or failed');
    expect(k.actions.map(a => a.verb)).toEqual(['retry', 'open-log']);
  });

  test('a stop no record explains is a Process', () => {
    const k = stopKind(view({ state: 'failed', recovery: { stage: 'Implement', diagnosis: 'The run stopped at Implement; see logs/run.out for the cause.' } })) as StopKindView;
    expect(k.kind).toBe('process');
    expect(k.cause).toBe('The run stopped at Implement; see logs/run.out for the cause.');
  });
});

describe('which kind wins when more than one fits', () => {
  test('Questions come before Permission', () => {
    expect(kindOf(view({
      state: 'paused',
      questions: [{ n: 1, title: 'Q', body: '', suggested: '', answer: '' }],
      permissions: [{ stage: 'Spec', tool: 'bash', detail: 'curl', rule: 'curl', protected: false }],
    }))).toBe('questions');
  });

  test('Permission comes before Account', () => {
    expect(kindOf(view({
      state: 'paused',
      permissions: [{ stage: 'Spec', tool: 'bash', detail: 'curl', rule: 'curl', protected: false }],
      recovery: { stage: 'Spec', diagnosis: 'quota exceeded', kind: 'account' },
    }))).toBe('permission');
  });

  test('Account comes before Waiting', () => {
    expect(kindOf(view({
      state: 'failed',
      note: 'usage limit, resets 1:10am',
      recovery: { stage: 'Implement', diagnosis: 'quota exceeded', kind: 'account' },
    }))).toBe('account');
  });

  test('Waiting comes before Stopped by you', () => {
    expect(kindOf(view({ state: 'stopped', note: 'usage limit, resets 1:10am' }))).toBe('waiting');
  });

  test('Stopped by you comes before Repository', () => {
    expect(kindOf(view({ state: 'interrupted', recovery: { stage: 'Plan', diagnosis: 'merge conflict with base branch' } }))).toBe('stopped');
  });

  test('Repository comes before Stage check', () => {
    expect(kindOf(view({
      state: 'failed',
      recovery: { stage: 'Plan', diagnosis: 'Commits from GitHub changed the locked test files, so the red gate no longer describes the tests.' },
      tests: { passed: 1, failed: 1, skipped: 0, total: 2 },
    }))).toBe('repository');
  });

  test('Stage check comes before Loop', () => {
    // A failed gate with an exhausted fix loop is a stage check: the gate is what stopped the run.
    expect(kindOf(view({
      state: 'failed',
      attempts: [{ at: '2026-01-01T00:00:00Z', stage: 'Implement', agent: 'impl-1', durationSec: 1, exitCode: 1, responseChars: 0, turns: 1, tokens: 0, denied: [], filesChanged: [], warnings: [], gate: { failing: ['x'], warnings: [] } }],
      reviewRounds: [{ round: 1, verdict: 'changes', outcome: 'stopped: 3 fix loop(s) used, findings still open', findings: [] }],
    }))).toBe('stage-check');
  });
});

describe('a run that has not stopped', () => {
  test('shows no kind at all', () => {
    for (const state of ['running', 'done', 'not started', 'ready'] as const) {
      expect(stopKind(view({ state }))).toBeNull();
    }
  });
});
