import { describe, it, expect } from 'vitest';

type Indexer = { name: string; command: string; installed: boolean; indexed: boolean; runnable: boolean; setup: string };
type ScreenState = {
  doctorSetupAction: (check: { name: string; ok: boolean; required: boolean }) => boolean;
  settingsSetupAction: (codeSearch: string) => { available: boolean; label: string };
  buildEligibility: (indexer: Indexer, running: boolean) => { enabled: boolean; guidance: string };
  initialPick: (view: { indexers: Indexer[] }) => string;
  buildPhase: (operation: { status: string } | null) => { progress: boolean; done: boolean; retry: boolean; poll: boolean };
};
const state = async () => {
  const modulePath = '../web/ui/src/codeIndexerState.js';
  return await import(modulePath) as ScreenState;
};
const graft: Indexer = { name: 'graft', command: 'graft', installed: true, indexed: false, runnable: true, setup: 'npm install -g @nanonets/graft' };
const graphify: Indexer = { name: 'graphify', command: 'graphify', installed: false, indexed: false, runnable: false, setup: 'uv tool install graphifyy' };

describe('code indexer screens', () => {
  it('shows the Doctor action only for a code indexer check advising action', async () => {
    const { doctorSetupAction } = await state();
    expect(doctorSetupAction({ name: 'code indexer', ok: false, required: false })).toBe(true);
    expect(doctorSetupAction({ name: 'code indexer', ok: false, required: true })).toBe(true);
    expect(doctorSetupAction({ name: 'code indexer', ok: true, required: false })).toBe(false);
    expect(doctorSetupAction({ name: 'git', ok: false, required: true })).toBe(false);
  });

  it.each(['graft', 'none', 'auto'])('offers setup in Settings with %s', async codeSearch => {
    const { settingsSetupAction } = await state();
    expect(settingsSetupAction(codeSearch)).toMatchObject({ available: true, label: 'Setup Code Indexer' });
  });

  it('enables building only when installed and runnable and no build is running', async () => {
    const { buildEligibility } = await state();
    expect(buildEligibility(graft, false).enabled).toBe(true);
    expect(buildEligibility(graft, true).enabled).toBe(false);
    expect(buildEligibility(graphify, false)).toMatchObject({ enabled: false, guidance: graphify.setup });
    expect(buildEligibility({ ...graft, runnable: false }, false)).toMatchObject({ enabled: false, guidance: graft.setup });
  });

  it('initially selects an available listed indexer', async () => {
    const { initialPick } = await state();
    expect(['graft', 'graphify']).toContain(initialPick({ indexers: [graft, graphify] }));
  });

  it.each([
    [null, false, false, false, false],
    ['running', true, false, false, true],
    ['succeeded', false, true, false, false],
    ['failed', false, false, true, false],
    ['timeout', false, false, true, false],
  ])('maps build state %s to its modal controls', async (status, progress, done, retry, poll) => {
    const { buildPhase } = await state();
    expect(buildPhase(status === null ? null : { status })).toMatchObject({ progress, done, retry, poll });
  });
});
