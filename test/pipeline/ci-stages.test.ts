import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { implementStage, redTestsStage, reviewStage, finaliseStage } from '../../src/pipeline/stages.js';
import { runAgent } from '../../src/pipeline/agent.js';
import { successCheck, testsPass } from '../../src/pipeline/gates.js';
import { finalise } from '../../src/pipeline/finalise.js';
import { changed } from '../../src/changes/index.js';
import type { Ctx } from '../../src/pipeline/context.js';

const ci = vi.hoisted(() => ({ available: vi.fn(), wait: vi.fn(), ready: vi.fn() }));
vi.mock('../../src/pipeline/ci.js', () => ({ checkCiAvailability: ci.available, waitForCiAndClassify: ci.wait }));
vi.mock('../../src/pipeline/agent.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/pipeline/agent.js')>(), runAgent: vi.fn(async () => {}), stageFlags: vi.fn(() => ({ model: 'fixture-model', effort: 'high' })) }));
vi.mock('../../src/pipeline/deps.js', () => ({ installDeps: vi.fn() }));
vi.mock('../../src/changes/index.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/changes/index.js')>(), mark: vi.fn(), changed: vi.fn() }));
vi.mock('../../src/pipeline/gates.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/pipeline/gates.js')>(),
  successCheck: vi.fn(async () => true), testsPass: vi.fn(() => false),
  newTestFiles: vi.fn(() => ['test/red.test.ts']), targetTestFiles: vi.fn(() => ['test/red.test.ts']), redCommitTestFiles: vi.fn(() => ['test/red.test.ts']),
}));
vi.mock('../../src/pipeline/finalise.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/pipeline/finalise.js')>(), finalise: vi.fn(() => ({ committed: 1, pr: 'https://github.com/acme/repo/pull/12' })), markPrReady: ci.ready }));

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-stages-'));
  await fs.mkdir(path.join(root, 'docs/logs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/plan-1.md'), '');
  vi.mocked(successCheck).mockResolvedValue(true);
  vi.mocked(testsPass).mockReturnValue(false);
  ci.available.mockReturnValue({ available: true });
  ci.wait.mockResolvedValue({ status: 'green', sideEffects: [], nonBlocking: [], testFiles: [] });
  ci.ready.mockReturnValue(true);
  vi.mocked(changed).mockReturnValue({ include: ['src/feature.ts'], skipped: [], envMirror: [] });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function context(mode = 'ci') {
  const git = { root, run: vi.fn((..._args: string[]) => ''), lines: vi.fn((..._args: string[]) => ['src/feature.ts']), addTests: vi.fn(), head: vi.fn(() => 'a'.repeat(40)), testsChangedSince: vi.fn(() => []) };
  return { root, slug: 'feature', branch: 'sdlc/feature', docs: 'docs', log: 'docs/logs', backlog: 'docs/index.md',
    redSha: 'red', origRedSha: 'red', lockSha: 'red', from: 'red-tests', fromN: 3, ciAvailable: true,
    ciSideEffectFiles: [] as string[],
    config: { tests: { fullSuite: mode, preliminary: 'full', allowFailures: [] }, ci: { waitMinutes: 1 }, suites: [], integration: null,
      agent: { harness: 'claude', model: 'fixture-model', effort: 'high', stages: {} }, git: { base: 'release' }, finalise: { maxFileBytes: 1024, envExample: false } },
    env: { SDLC_CREATE_PR: '0' }, layout: { testPathspecs: ['test/**/*.test.ts'] }, limits: { maxAttempts: 2 }, git,
    status: { stage: '', attempt: '', write: vi.fn() }, out: vi.fn(), err: vi.fn(), failLog: 'docs/logs/tests.log',
  };
}
const cast = (ctx: ReturnType<typeof context>) => ctx as unknown as Ctx;

describe('CI stage orchestration (spec 4, 7, 9)', () => {
  it('S01 checks availability only after red tests are committed and locked, even with createPr off', async () => {
    const ctx = context();
    ci.available.mockImplementation(() => {
      expect(ctx.redSha).toBe('a'.repeat(40));
      expect(ctx.lockSha).toBe(ctx.redSha);
      expect(ctx.git.run.mock.calls.some(args => args.includes('commit'))).toBe(true);
      return { available: true };
    });
    await redTestsStage(cast(ctx));
    expect(ci.available).toHaveBeenCalledTimes(1);
    expect(ci.wait).not.toHaveBeenCalled();
  });
  it('S02 a failed red gate neither pushes nor opens a PR', async () => {
    const ctx = context(); vi.mocked(testsPass).mockReturnValue(true);
    await expect(redTestsStage(cast(ctx))).rejects.toMatchObject({ code: 1 });
    expect(ci.available).not.toHaveBeenCalled();
    expect(ctx.git.run.mock.calls.some(args => args.includes('push'))).toBe(false);
  });
  it('S03 local mode keeps Red tests and Implement free of CI and per-attempt commits', async () => {
    const ctx = context('local');
    await redTestsStage(cast(ctx));
    ctx.git.run.mockClear();
    expect(await implementStage(cast(ctx))).toBe(true);
    expect(ci.available).not.toHaveBeenCalled(); expect(ci.wait).not.toHaveBeenCalled();
    expect(ctx.git.run.mock.calls.some(args => args.includes('commit') || args.includes('push'))).toBe(false);
  });
  it.each(['no remote', 'gh not installed', 'gh not authenticated', 'push failed: denied', 'PR could not be created', 'PR is closed', 'PR is merged'])(
    'S04 persists and prints fallback reason %s', async reason => {
      const ctx = context(); ci.available.mockReturnValue({ available: false, reason });
      await redTestsStage(cast(ctx));
      expect(ctx).toMatchObject({ ciAvailable: false, ciFallbackReason: reason });
      expect(ctx.status).toMatchObject({ ci: expect.objectContaining({ reason }) });
      expect(ctx.out).toHaveBeenCalledWith(`CI unavailable (${reason}): running the full suite locally`);
    });
  it('S05 commits and pushes a locally green attempt before waiting for CI', async () => {
    const ctx = context();
    ci.wait.mockImplementation(async () => {
      const calls = ctx.git.run.mock.calls;
      expect(calls.some(args => args.includes('feat(feature): implement (attempt 1)'))).toBe(true);
      expect(calls.some(args => args.includes('push'))).toBe(true);
      return { status: 'green', sideEffects: [], nonBlocking: [], testFiles: [] };
    });
    expect(await implementStage(cast(ctx))).toBe(true);
    expect(ci.wait).toHaveBeenCalledWith(expect.anything(), 'a'.repeat(40), expect.anything());
    expect(ctx.out.mock.calls.flat().join('\n')).toContain('Round 1: implement');
  });
  it('S06 a failing local gate uses the attempt budget without committing, pushing or waiting', async () => {
    const ctx = context(); vi.mocked(successCheck).mockResolvedValue(false);
    expect(await implementStage(cast(ctx))).toBe(false);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(ci.wait).not.toHaveBeenCalled();
    expect(ctx.git.run.mock.calls.some(args => args.includes('commit') || args.includes('push'))).toBe(false);
  });
  it('S07 CI side effects consume another attempt and accumulate files for the local gate', async () => {
    const ctx = context();
    ci.wait.mockResolvedValueOnce({ status: 'red', sideEffects: [{ checkName: 'unit', file: 'test/old.test.ts', testName: 'suite rejects input', message: 'expected true', runUrl: 'https://github.com/acme/repo/actions/runs/42', classification: 'side-effect' }], nonBlocking: [], testFiles: ['test/old.test.ts'] })
      .mockResolvedValueOnce({ status: 'green', sideEffects: [], nonBlocking: [], testFiles: [] });
    expect(await implementStage(cast(ctx))).toBe(true);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(ctx.ciSideEffectFiles).toContain('test/old.test.ts');
    expect(ci.wait).toHaveBeenCalledTimes(2);
  });
  it('S08 non-blocking CI failures finish without another agent attempt', async () => {
    const ctx = context(); ci.wait.mockResolvedValue({ status: 'green-with-warnings', sideEffects: [], nonBlocking: [{ classification: 'pre-existing', checkName: 'unit' }], testFiles: [] });
    expect(await implementStage(cast(ctx))).toBe(true);
    expect(ci.wait).toHaveBeenCalledTimes(1); expect(runAgent).toHaveBeenCalledTimes(1);
  });
  it('S09 timeout pauses with exit 2 and an Implement recovery hint', async () => {
    const ctx = context(); ci.wait.mockResolvedValue({ status: 'timed-out', sideEffects: [], nonBlocking: [], testFiles: [] });
    await expect(implementStage(cast(ctx))).rejects.toMatchObject({ code: 2 });
    const output = ctx.out.mock.calls.flat().join('\n');
    expect(output).toContain('Timed out after 1m (paused)');
    expect(output).toContain('resume with FROM=implement');
  });
  it('S10 no workflow reruns the current local gate after switching to fallback', async () => {
    const ctx = context(); ci.wait.mockResolvedValue({ status: 'unavailable', reason: 'no workflow', sideEffects: [], nonBlocking: [], testFiles: [] });
    expect(await implementStage(cast(ctx))).toBe(true);
    expect(ctx).toMatchObject({ ciAvailable: false, ciFallbackReason: 'no workflow' });
    expect(successCheck).toHaveBeenCalledTimes(2);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
  it('S11 Finalise readies the existing draft even when createPr is off', async () => {
    const ctx = context();
    Object.assign(ctx, { ciLastResult: { status: 'green' } });
    Object.assign(ctx.status, { ci: { enabled: true, state: 'green', pr: 'https://github.com/acme/repo/pull/12' } });
    await finaliseStage(cast(ctx));
    expect(finalise).toHaveBeenCalledTimes(1);
    expect(ci.ready.mock.calls[0]?.slice(0, 2)).toEqual([root, 'https://github.com/acme/repo/pull/12']);
  });
  it('S12 resumes an unchanged pushed head by waiting before another agent runs', async () => {
    const ctx = context();
    ci.wait.mockResolvedValueOnce({ status: 'timed-out', sideEffects: [], nonBlocking: [], testFiles: [] });
    await expect(implementStage(cast(ctx))).rejects.toMatchObject({ code: 2 });
    vi.mocked(runAgent).mockClear();
    ctx.from = 'implement'; ctx.fromN = 4;
    ctx.git.run.mockImplementation((...args) => args.includes('rev-parse') ? 'a'.repeat(40) : '');
    ci.wait.mockImplementationOnce(async () => {
      expect(runAgent).not.toHaveBeenCalled();
      return { status: 'green', sideEffects: [], nonBlocking: [], testFiles: [] };
    });
    expect(await implementStage(cast(ctx))).toBe(true);
    expect(runAgent).not.toHaveBeenCalled();
  });
  it('S13 side-effect CI failures exhaust the shared attempt budget', async () => {
    const ctx = context();
    ci.wait.mockResolvedValue({ status: 'red', sideEffects: [{ classification: 'side-effect', file: 'test/old.test.ts', checkName: 'unit', testName: 'regression', message: 'expected true', runUrl: 'https://github.com/acme/repo/actions/runs/42' }], nonBlocking: [], testFiles: ['test/old.test.ts'] });
    expect(await implementStage(cast(ctx))).toBe(false);
    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(ci.wait).toHaveBeenCalledTimes(2);
  });
  it('S14 an unchanged tree waits on the current head without an empty commit', async () => {
    const ctx = context();
    vi.mocked(changed).mockReturnValue({ include: [], skipped: [], envMirror: [] });
    ctx.git.lines.mockReturnValue([]);
    expect(await implementStage(cast(ctx))).toBe(true);
    expect(ci.wait).toHaveBeenCalledWith(expect.anything(), 'a'.repeat(40), expect.anything());
    expect(ctx.git.run.mock.calls.some(args => args.includes('commit'))).toBe(false);
  });
  it('S15 a push failure after CI was reachable pauses instead of falling back', async () => {
    const ctx = context();
    ctx.git.run.mockImplementation((...args) => { if (args.includes('push')) throw new Error('remote denied'); return ''; });
    await expect(implementStage(cast(ctx))).rejects.toMatchObject({ code: 2 });
    expect(ctx.ciAvailable).toBe(true);
    expect(ctx.out.mock.calls.flat().join('\n')).toContain('FROM=implement');
  });
  it('S16 a run resumed at Review asks about CI first, so the check after the review leaves the full suite to CI', async () => {
    const ctx = context(); ctx.from = 'review'; ctx.fromN = 6;
    (ctx as { ciAvailable?: boolean }).ciAvailable = undefined;
    let seen: boolean | undefined;
    vi.mocked(successCheck).mockImplementation(async c => { seen = c.ciAvailable; return true; });
    await reviewStage(cast(ctx));
    expect(ci.available).toHaveBeenCalledTimes(1);
    expect(ctx.ciAvailable).toBe(true);
    expect(seen).toBe(true);
  });
  it('S17 Review does not ask again when this process already knows, and local mode never asks', async () => {
    const known = context();
    await reviewStage(cast(known));
    const local = context('local'); (local as { ciAvailable?: boolean }).ciAvailable = undefined;
    await reviewStage(cast(local));
    expect(ci.available).not.toHaveBeenCalled();
  });
});
