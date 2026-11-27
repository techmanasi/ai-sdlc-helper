import { describe, expect, it } from 'vitest';
import type { SettingsView } from '../web/ui/src/api.js';
import { STAGES, branchLine, defaultsSummary, newItemCommand, slugFromTitle, stageEnv } from '../web/ui/src/newItemForm.js';

/** Only the fields the New item screen reads: the server sends the rest. */
const settings = (patch: Partial<SettingsView> = {}): SettingsView => ({
  stages: ['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'review', 'resolve-conflicts'],
  stageDefaults: {}, config: null, ...patch,
} as SettingsView);

describe('New item: title, stages and When', () => {
  it('uses the repo slug rule for the live branch line', () => {
    expect(slugFromTitle('Add Rate Limit!')).toBe('add-rate-limit');
    expect(slugFromTitle('  Fix__the / Bug  ')).toBe('fix-the-bug');
    expect(slugFromTitle('---')).toBe('');
    expect(branchLine('Add Rate Limit!', 'sdlc/')).toBe('Branch: sdlc/add-rate-limit');
    expect(branchLine('', 'work/')).toBe('Branch: work/<slug>');
    // Without a prefix from the project's settings, show no guessed one.
    expect(branchLine('A B')).toBe('Branch: a-b');
  });

  it('shows only the eight named stages of a run', () => {
    expect(STAGES.map(s => s.name)).toEqual([
      'Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Finalise', 'Resolve conflicts',
    ]);
  });

  it('summarises the project defaults, then a stage override, without inventing values', () => {
    const base = settings({ config: {
      agent: { harness: 'claude', model: 'sonnet', effort: 'medium', stages: {} },
    } });
    expect(defaultsSummary('spec', base)).toBe('claude · sonnet · medium');
    const overridden = settings({ config: {
      agent: { harness: 'claude', model: 'sonnet', effort: 'medium', stages: { plan: { harness: 'agy', model: 'flash' } } },
    } });
    expect(defaultsSummary('plan', overridden)).toBe('agy · flash · medium');
    expect(defaultsSummary('spec', overridden)).toBe('claude · sonnet · medium');
  });

  it('falls back to the built-in stage default, and says default when there is none', () => {
    const withBuiltIn = settings({
      stageDefaults: { review: { model: 'opus', effort: 'high' } },
      config: { agent: { harness: 'claude', model: null, effort: null, stages: {} } },
    });
    expect(defaultsSummary('review', withBuiltIn)).toBe('claude · opus · high');
    expect(defaultsSummary('no-such-stage', withBuiltIn)).toBe('no agent');
    // The project's agent is a default too, so only its name is shown for a stage with no other default.
    expect(defaultsSummary('spec', withBuiltIn)).toBe('claude · default · default');
    expect(defaultsSummary('spec', null)).toBe('default');
    // Finalise runs no agent: the server's AGENT_STAGES does not list it.
    expect(defaultsSummary('finalise', withBuiltIn)).toBe('no agent');
  });

  it('turns item-only picks into the per-stage run overrides the pipeline reads', () => {
    expect(stageEnv({
      spec: { harness: 'agy', model: 'flash', effort: '' },
      resolve: { harness: '', model: 'opus', effort: 'low' },
    })).toEqual({ AGENT_SPEC: 'agy', MODEL_SPEC: 'flash', MODEL_RESOLVE: 'opus', EFFORT_RESOLVE: 'low' });
    expect(stageEnv({})).toEqual({});
  });

  it('shows a start command now and a start-later command for the same item', () => {
    expect(newItemCommand('now', 'add-rate-limit')).toBe('ai-sdlc-helper start add-rate-limit');
    expect(newItemCommand('later', 'add-rate-limit')).toBe("ai-sdlc-helper start add-rate-limit  # added to the board now; run this when you're ready");
    expect(newItemCommand('now', 'a b', { AGENT_SPEC: 'agy', MODEL_SPEC: 'gemini flash' }))
      .toBe("AGENT_SPEC=agy MODEL_SPEC='gemini flash' ai-sdlc-helper start 'a b'");
  });
});
