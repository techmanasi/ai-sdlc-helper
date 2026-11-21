import { describe, it, expect } from 'vitest';
import { CODE_INDEXERS } from 'ai-sdlc-helper';

// The shared presentation module is consumed by the dialog and both entry points.
const modulePath = '../ui/src/codeSearchSetup';
const load = () => import(modulePath);
const graft = { name: 'graft', command: 'graft', index: 'graft', installed: true, indexed: true,
  setup: 'npm install -g @nanonets/graft, then graft build', build: 'graft build', canBuild: true };
const graphify = { name: 'graphify', command: 'graphify', index: 'graphify-out/graph.json', installed: true,
  indexed: false, setup: 'uv tool install graphifyy', build: 'build the graph with /graphify . in Claude Code', canBuild: false };

describe('code search setup presentation', () => {
  it('offers install instructions and disables actions when the binary is missing', async () => {
    const { indexerPresentation } = await load();
    const view = indexerPresentation({ ...graft, installed: false, indexed: false, canBuild: false }, false);
    expect(view.badges).toEqual(expect.arrayContaining([expect.stringMatching(/not installed/i), expect.stringMatching(/unindexed|not indexed/i)]));
    expect(view.copyText).toBe('npm install -g @nanonets/graft');
    expect(view.actions.length).toBeGreaterThan(0);
    expect(view.actions.every((action: { disabled: boolean }) => action.disabled)).toBe(true);
  });

  it('copies the Graphify install command separately from alternative and build instructions', async () => {
    const { indexerPresentation } = await load();
    const view = indexerPresentation({ name: 'graphify', command: 'graphify', index: 'graphify-out/graph.json',
      installed: false, indexed: false, setup: CODE_INDEXERS.graphify.setup ?? null,
      build: CODE_INDEXERS.graphify.build ?? null, canBuild: false }, false);
    expect(view.copyText).toBe('uv tool install graphifyy');
    expect(view.copyInstructions).toContain('or pipx install graphifyy');
    expect(view.copyInstructions).toContain('build the graph with /graphify . in Claude Code');
  });

  it('offers use and rebuild with the correct requests for indexed graft', async () => {
    const { indexerPresentation } = await load();
    const view = indexerPresentation(graft, false);
    expect(view.badges).toEqual(expect.arrayContaining([expect.stringMatching(/^installed$/i), expect.stringMatching(/^indexed$/i)]));
    expect(view.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Use graft', disabled: false, body: { indexer: 'graft', build: false } }),
      expect.objectContaining({ label: 'Rebuild Index', disabled: false, body: { indexer: 'graft', build: true } }),
    ]));
  });

  it('offers build for installed unindexed graft', async () => {
    const { indexerPresentation } = await load();
    expect(indexerPresentation({ ...graft, indexed: false }, false).actions).toContainEqual(
      expect.objectContaining({ label: 'Build Index', disabled: false, body: { indexer: 'graft', build: true } }));
  });

  it('presents manual graphify instructions with build and configuration disabled until refreshed', async () => {
    const { indexerPresentation } = await load();
    const view = indexerPresentation(graphify, false);
    expect(view.copyText).toBe('/graphify .');
    expect(view.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Build Index', disabled: true }),
      expect.objectContaining({ label: expect.stringMatching(/^Configure/), disabled: true }),
      expect.objectContaining({ label: 'Refresh status', disabled: false }),
    ]));
  });

  it('disables actions and copying while a setup request is pending', async () => {
    const { indexerPresentation } = await load();
    const view = indexerPresentation(graft, true);
    expect(view.actions.length).toBeGreaterThan(0);
    expect(view.actions.every((action: { disabled: boolean }) => action.disabled)).toBe(true);
    expect(view.copyDisabled).toBe(true);
    expect(view.busy).toBe(true);
  });

  it('exposes failure output for the preformatted diagnostic', async () => {
    const { setupFailure } = await load();
    const { ApiError } = await import('../ui/src/api.js');
    const error = Object.assign(new ApiError('build failed'), { output: 'compiler output' });
    expect(setupFailure(error)).toMatchObject({ error: 'build failed', output: 'compiler output' });
  });

  it('offers the Doctor action only for a failing code indexer and applies returned checks', async () => {
    const { doctorSetupAction, configuredChecks } = await load();
    expect(doctorSetupAction({ name: 'code indexer', ok: false })).toBe(true);
    expect(doctorSetupAction({ name: 'code indexer', ok: true })).toBe(false);
    expect(doctorSetupAction({ name: 'git', ok: false })).toBe(false);
    const checks = [{ name: 'code indexer', ok: true }, { name: 'git', ok: true }];
    expect(configuredChecks({ ok: true, codeSearch: 'graft', checks })).toEqual(checks);
  });

  it.each([
    { warning: 'code search uses Grep and Glob until configured', matches: true },
    { warning: 'no code indexer is available', matches: true },
    { warning: 'git is not configured', matches: false },
  ])('matches the Settings warning "$warning"', async ({ warning, matches }) => {
    const { isCodeSearchWarning } = await load();
    expect(isCodeSearchWarning(warning)).toBe(matches);
  });

  it('keeps the Settings header action available with and without warnings', async () => {
    const { settingsSetupActions } = await load();
    for (const warnings of [[], ['git is not configured'], ['code indexer unavailable']]) {
      expect(settingsSetupActions(warnings)).toMatchObject({ header: true });
    }
  });
});
