import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runView, type RunContext } from 'ai-sdlc-helper';

vi.mock('../../../src/runs/index.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../src/runs/index.js')>(), runWorktree: vi.fn(() => null) }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(ci: Record<string, unknown> | undefined, fullSuite = 'ci') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-view-'));
  roots.push(root);
  const log = path.join(root, 'docs/backlog/feature/logs');
  await fs.mkdir(log, { recursive: true });
  await fs.writeFile(path.join(root, 'sdlc.config.json'), JSON.stringify({ tests: { fullSuite } }));
  await fs.writeFile(path.join(log, 'status.json'), JSON.stringify({ slug: 'feature', state: 'running', stage: 'Implement', ci }));
  const ctx: RunContext = { root, reg: path.join(root, 'register'), backlogDir: 'docs/backlog', branchPrefix: 'sdlc/', base: 'main', wtBase: path.join(root, 'trees'), links: [], setup: [], maxParallel: 2, env: {} };
  return ctx;
}

describe('CI payload on the run page (spec 10.2)', () => {
  it.each(['waiting', 'running', 'green', 'red: side effect', 'green with warnings', 'timed out (paused)', 'unavailable: running locally'])(
    'V01 exposes %s from run status', async state => {
      const ci = { enabled: true, state, pr: 'https://github.com/acme/repo/pull/12', prDraft: true,
        ...(state === 'red: side effect' ? { failingChecks: ['unit'] } : {}),
        ...(state === 'green with warnings' ? { warnings: ['unit: pre-existing'] } : {}),
        ...(state === 'unavailable: running locally' ? { reason: 'no workflow' } : {}),
      };
      const ctx = await fixture(ci);
      expect(runView(ctx, 'feature', { parts: [], checkPr: false })).toMatchObject({ ci: expect.objectContaining(ci) });
    });
  it.each([true, false])('V02 preserves draft=%s for the PR label', async prDraft => {
    const ctx = await fixture({ enabled: true, state: 'green', prDraft, pr: 'https://github.com/acme/repo/pull/12' });
    expect(runView(ctx, 'feature', { parts: [], checkPr: false })).toMatchObject({ ci: { prDraft } });
  });
  it('V03 omits the CI payload for a local run', async () => {
    const ctx = await fixture(undefined, 'local');
    const view = runView(ctx, 'feature', { parts: [], checkPr: false }) as ReturnType<typeof runView> & { ci?: unknown };
    expect(view.ci ?? null).toBeNull();
  });
  it('V04 delivers a later state on refresh rather than retaining running', async () => {
    const ctx = await fixture({ enabled: true, state: 'running' });
    const options = { parts: [] as const, checkPr: false };
    expect(runView(ctx, 'feature', options)).toMatchObject({ ci: { state: 'running' } });
    await fs.writeFile(path.join(ctx.root, 'docs/backlog/feature/logs/status.json'), JSON.stringify({ state: 'running', stage: 'Implement', ci: { enabled: true, state: 'green' } }));
    expect(runView(ctx, 'feature', options)).toMatchObject({ ci: { state: 'green' } });
  });
});
