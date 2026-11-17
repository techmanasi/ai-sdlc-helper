type Indexer = { name: string; installed: boolean; runnable: boolean; setup: string };

export const doctorSetupAction = (check: { name: string; ok: boolean }) => check.name === 'code indexer' && !check.ok;
export const settingsSetupAction = (_codeSearch: string) => ({ available: true, label: 'Setup Code Indexer' });
export const buildEligibility = (indexer: Indexer, running: boolean) => ({
  enabled: indexer.installed && indexer.runnable && !running,
  guidance: !indexer.installed || !indexer.runnable ? indexer.setup : '',
});
export const initialPick = (view: { indexers: Indexer[] }) =>
  (view.indexers.find(i => i.installed && i.runnable) || view.indexers[0])?.name || '';
export const buildPhase = (operation: { status: string } | null | undefined) => ({
  progress: operation?.status === 'running',
  done: operation?.status === 'succeeded',
  retry: operation?.status === 'failed' || operation?.status === 'timeout',
  poll: operation?.status === 'running',
});
export const setupChanged = (_openedWith: string | null, now: string) => now === 'succeeded';
