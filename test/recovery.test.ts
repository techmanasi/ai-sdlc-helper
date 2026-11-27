import { describe, expect, test } from 'vitest';
import type { RunView } from '../web/ui/src/api.js';
import {
  billingUrlOf, errorDetailsOf, recoveryCliLine, recoveryOptions,
  type RecoveryOption,
} from '../web/ui/src/recovery.js';
import { stopKind } from '../web/ui/src/stopKind.js';

/** A run view with only what the recovery reads; the rest of the record does not matter here. */
function view(over: Partial<RunView> = {}): RunView {
  return {
    slug: 'item', state: 'failed', stage: 'Implement', agent: '', model: '', effort: '', models: {},
    attempt: '', note: '', agentStarted: '', runStarted: '', updated: '', record: null, dir: null, worktree: null,
    branch: 'sdlc/item', base: 'main', message: '', questions: [], permissions: [], deniedPermissions: [],
    tests: null, stageFiles: {}, changes: null, tail: [], docs: [], discarded: '', resumeFrom: 'implement',
    handoff: null, redCommit: '1c3b784', gitAgeMs: null, attempts: [], stepPlan: {},
    ...over,
  } as RunView;
}

const by = (options: RecoveryOption[]) => Object.fromEntries(options.map(o => [o.id, o]));
const ids = (options: RecoveryOption[]) => options.map(o => o.id);
const kindOf = (v: RunView) => stopKind(v)?.kind ?? null;

describe('recoveryOptions — options match the recorded stop', () => {
  test('account / usage limit: top up and retry, switch model, and a confirmed bailout', () => {
    const v = view({
      recovery: {
        stage: 'Implement', kind: 'account',
        diagnosis: "Agent 'impl-1' reached quota or rate limit: Insufficient balance. Top up at https://opencode.ai/console/billing?credits=1",
      },
    });
    const o = by(recoveryOptions(kindOf(v), v));
    expect(ids(recoveryOptions(kindOf(v), v))).toEqual(['top-up', 'resume', 'switch-model', 'resume-at']);
    expect(o['top-up']).toMatchObject({ action: 'top-up', label: 'Open billing', stage: 'implement' });
    expect(o['top-up'].detail).toContain('retry is a separate press');
    expect(o['top-up'].billingUrl).toBe('https://opencode.ai/console/billing?credits=1');
    expect(o.resume).toMatchObject({ action: 'resume', label: 'Retry Implement', stage: 'implement' });
    expect(o['switch-model']).toMatchObject({ action: 'switch-model', stage: 'implement' });
    expect(o['resume-at']).toMatchObject({ action: 'resume-at', label: 'Resume at Review', stage: 'review', confirm: true });
  });

  test('waiting: no billing link recorded, so no Open billing; retry and switch model stay', () => {
    const v = view({ state: 'paused', note: 'usage limit, resets 1:10am', recovery: { stage: 'Implement', diagnosis: 'waiting for the limit' } });
    expect(ids(recoveryOptions(kindOf(v), v))).not.toContain('top-up');
    expect(ids(recoveryOptions(kindOf(v), v))).toContain('switch-model');
  });

  test('test failure: no Top up, no model switch; no bailout when resume.ts allows no later stage', () => {
    const v = view({
      tests: { passed: 8, failed: 2, skipped: 0, total: 10 },
      recovery: { stage: 'Implement', diagnosis: 'Implement failed: 2 tests failing' },
      redCommit: '',
    });
    expect(kindOf(v)).toBe('stage-check');
    const o = recoveryOptions(kindOf(v), v);
    expect(ids(o)).toEqual(['resume']);
    // Without a red-tests commit resume.ts refuses Implement, so only an earlier stage can be resumed.
    expect(o[0]).toMatchObject({ action: 'resume', label: 'Resume from Spec' });
    expect(by(o)['top-up']).toBeUndefined();
    expect(by(o)['resume-at']).toBeUndefined();
  });

  test('test failure with a red-tests commit allows a later stage, still no Top up', () => {
    const v = view({ tests: { passed: 8, failed: 2, skipped: 0, total: 10 }, recovery: { stage: 'Implement', diagnosis: '2 tests failing' } });
    const o = recoveryOptions(kindOf(v), v);
    expect(ids(o)).toEqual(['resume', 'resume-at']);
    expect(by(o)['top-up']).toBeUndefined();
  });

  test('agent error: retry and switch model, no Top up', () => {
    const v = view({ recovery: { stage: 'Implement', kind: 'process', diagnosis: "Agent 'impl-1' crashed or failed: exit 1" } });
    expect(kindOf(v)).toBe('process');
    const o = recoveryOptions(kindOf(v), v);
    expect(ids(o)).toEqual(['resume', 'switch-model', 'resume-at']);
    expect(by(o)['top-up']).toBeUndefined();
  });

  test('merge conflict: resume from the stage, no Top up and no later stage after Resolve conflicts', () => {
    const v = view({
      recovery: { stage: 'Resolve conflicts', diagnosis: 'Resolve conflicts stopped before pushing; the branch is back where it was.' },
      resumeFrom: 'resolve-conflicts',
    });
    expect(kindOf(v)).toBe('repository');
    const o = recoveryOptions(kindOf(v), v);
    expect(ids(o)).toEqual(['resume']);
    expect(o[0]).toMatchObject({ action: 'resume', label: 'Resume from Resolve conflicts', stage: 'resolve-conflicts' });
    expect(by(o)['top-up']).toBeUndefined();
  });

  test('a paused run with no recorded error is left to its own questions and permission controls', () => {
    expect(recoveryOptions('questions', view({ state: 'paused' }))).toEqual([]);
    expect(recoveryOptions('permission', view({ state: 'paused' }))).toEqual([]);
    expect(recoveryOptions(null, view())).toEqual([]);
    expect(recoveryOptions('waiting', view({ state: 'paused' }))).toEqual([]);
  });
});

describe('the record behind the disclosure, the reviewers and the CLI line', () => {
  test('the error details come from the recorded attempt, with its log as the source', () => {
    const v = view({
      attempts: [{ at: '', stage: 'implement', agent: 'impl-1', durationSec: null, exitCode: 1, responseChars: 0, turns: null, tokens: null, denied: [], filesChanged: [], warnings: [], error: 'Insufficient balance', log: 'impl-1.err' }],
    });
    expect(errorDetailsOf(v)).toEqual({ text: 'Insufficient balance', source: 'logs/impl-1.err' });
    expect(billingUrlOf(view({ recovery: { stage: 'Implement', diagnosis: 'No link here' } }))).toBe('');
  });

  test('the copied CLI line names the slug and the stage', () => {
    expect(recoveryCliLine('item', 'review')).toBe('ai-sdlc-helper start item --from review');
    expect(recoveryCliLine('item', '')).toBe('ai-sdlc-helper start item');
  });
});
