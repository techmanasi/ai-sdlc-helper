import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { implementStage, redTestsStage, testRepairStage, finaliseStage } from '../../src/pipeline/stages.js';
import { runAgent } from '../../src/pipeline/agent.js';
import { successCheck, testsPass } from '../../src/pipeline/gates.js';
import { finalise } from '../../src/pipeline/finalise.js';
import { changed } from '../../src/changes/index.js';
import type { Ctx } from '../../src/pipeline/context.js';

const ci = vi.hoisted(() => ({ available: vi.fn(), wait: vi.fn(), ready: vi.fn() }));
vi.mock('../../src/pipeline/ci.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/pipeline/ci.js')>(), checkCiAvailability: ci.available, waitForCiAndClassify: ci.wait }));
const pc = vi.hoisted(() => ({ ensure: vi.fn(async (_ctx: { branch: string }, _opts: { resume: string; fresh: boolean }) => {}) }));
vi.mock('../../src/pipeline/push-check.js', () => ({ ensurePushable: pc.ensure, pushCheckSkipped: (env: NodeJS.ProcessEnv) => ['0', 'no', 'off'].includes(String(env.SDLC_PUSH_CHECK ?? '')) }));
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
  pc.ensure.mockReset();
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

describe('a refused push gets the push check', () => {
  const moveTo = (b: string) => async (c: { branch: string }): Promise<void> => { c.branch = b; };
  it('runs the check once, asks CI again once, and then uses CI', async () => {
    const ctx = context();
    pc.ensure.mockImplementation(moveTo('sdlc/feature_2'));
    ci.available.mockReturnValueOnce({ available: false, rejected: true, reason: 'push failed: rejected' }).mockReturnValueOnce({ available: true, pr: 'https://github.com/acme/repo/pull/7' });
    await redTestsStage(cast(ctx));
    expect(ctx.branch).toBe('sdlc/feature_2');
    expect(ctx.ciAvailable).toBe(true);
    expect(pc.ensure).toHaveBeenCalledTimes(1);
    // Red tests has committed its tests: a stopped check resumes at Implement; a refused push is never a fresh start.
    expect(pc.ensure.mock.calls[0][1]).toEqual({ resume: 'implement', fresh: false });
    expect(ci.available).toHaveBeenCalledTimes(2);
  });
  it('falls back when the second try fails too, without a third', async () => {
    const ctx = context();
    ci.available.mockReturnValue({ available: false, rejected: true, reason: 'push failed: rejected' });
    await redTestsStage(cast(ctx));
    expect(ctx.ciAvailable).toBe(false);
    expect(ci.available).toHaveBeenCalledTimes(2);
    expect(pc.ensure).toHaveBeenCalledTimes(1);
  });
  it('does not run the check when SDLC_PUSH_CHECK=0, or for a push that failed for another reason', async () => {
    const ctx = context(); ctx.env = { SDLC_CREATE_PR: '0', SDLC_PUSH_CHECK: '0' } as typeof ctx.env;
    ci.available.mockReturnValue({ available: false, rejected: true, reason: 'push failed: rejected' });
    await redTestsStage(cast(ctx));
    expect(pc.ensure).not.toHaveBeenCalled();
    expect(ci.available).toHaveBeenCalledTimes(1);
    const other = context();
    ci.available.mockReturnValue({ available: false, reason: 'push failed: could not resolve host' });
    await redTestsStage(cast(other));
    expect(pc.ensure).not.toHaveBeenCalled();
  });
  it('does not run on a kept attempt (Fix with Implement) in ci mode: same branch, same pull request', async () => {
    const ctx = context(); ctx.env = { SDLC_CREATE_PR: '0', SDLC_ON_ATTEMPT: '1' } as typeof ctx.env;
    (ctx as { ciAvailable?: boolean }).ciAvailable = undefined; ctx.from = 'implement'; ctx.fromN = 4;
    ci.available.mockReturnValue({ available: false, rejected: true, reason: 'push failed: ! [rejected] (non-fast-forward)' });
    await implementStage(cast(ctx));
    expect(pc.ensure).not.toHaveBeenCalled();
    expect(ctx.branch).toBe('sdlc/feature');
    expect(ci.available).toHaveBeenCalledTimes(1);
    expect(ctx.ciAvailable).toBe(false);
  });
  for (const [name, run, from, fromN] of [['Test repair', testRepairStage, 'test-repair', 4]] as const) {
    it(`runs for a ${name} run first entered in ci mode, and the suite is not run locally`, async () => {
      const ctx = context(); ctx.from = from; ctx.fromN = fromN;
      (ctx as { ciAvailable?: boolean }).ciAvailable = undefined;
      pc.ensure.mockImplementation(moveTo('sdlc/feature_2'));
      ci.available.mockReturnValueOnce({ available: false, rejected: true, reason: 'push failed: rejected' }).mockReturnValueOnce({ available: true, pr: 'https://github.com/acme/repo/pull/7' });
      await run(cast(ctx)).catch(() => {});
      expect(pc.ensure).toHaveBeenCalledTimes(1);
      expect(pc.ensure.mock.calls[0][1]).toMatchObject({ fresh: false });
      expect(ctx.branch).toBe('sdlc/feature_2');
      expect(ctx.ciAvailable).toBe(true);
      expect(ci.available).toHaveBeenCalledTimes(2);
      expect(ctx.out.mock.calls.flat().join('\n')).not.toContain('running the full suite locally');
    });
  }
  it('Implement\'s own refused push: the check runs, CI is asked once, and the round goes on to CI', async () => {
    const ctx = context();
    pc.ensure.mockImplementation(moveTo('sdlc/feature_2'));
    let first = true;
    ctx.git.run.mockImplementation((...args) => {
      if (args.includes('push') && first) { first = false; throw new Error('git push failed: ! [rejected] sdlc/feature -> sdlc/feature (fetch first)'); }
      return '';
    });
    ci.available.mockReturnValue({ available: true, pr: 'https://github.com/acme/repo/pull/7' });
    expect(await implementStage(cast(ctx))).toBe(true);
    expect(pc.ensure).toHaveBeenCalledTimes(1);
    expect(pc.ensure.mock.calls[0][1]).toEqual({ resume: 'implement', fresh: false });
    expect(ctx.branch).toBe('sdlc/feature_2');
    expect(ci.available).toHaveBeenCalledTimes(1);
    expect(ci.wait).toHaveBeenCalled();
  });
  it('still pauses when CI cannot be used after the check', async () => {
    const ctx = context();
    ctx.git.run.mockImplementation((...args) => { if (args.includes('push')) throw new Error('git push failed: ! [rejected] x (fetch first)'); return ''; });
    ci.available.mockReturnValue({ available: false, rejected: true, reason: 'push failed: rejected' });
    await expect(implementStage(cast(ctx))).rejects.toMatchObject({ code: 2 });
    expect(pc.ensure).toHaveBeenCalledTimes(1);
  });
});

describe('a new test file the project cannot compile', () => {
  it('retries the Red tests agent once with the compiler error, then stops at Red tests', async () => {
    const ctx = context();
    (ctx.config as any).typecheck = 'cat ts.txt; exit 2';
    await fs.writeFile(path.join(root, 'ts.txt'), "test/red.test.ts(59,39): error TS2835: Relative import paths need explicit file extensions. Did you mean '../ui/src/api.js'?\n");
    const notes: string[] = [];
    vi.mocked(runAgent).mockImplementation(async (c: any) => { notes.push(String(c.promptExtra?.HANDOFF ?? '')); });

    await expect(redTestsStage(cast(ctx))).rejects.toMatchObject({ code: 1 });
    expect(runAgent).toHaveBeenCalledTimes(2);
    // the first agent saw the review findings, the retry saw the compiler error and the rule about test files
    expect(notes[0]).not.toContain('TS2835');
    expect(notes[1]).toContain('TS2835');
    expect(notes[1]).toContain('Fix the test files only');
    expect(ctx.status.attempt).toBe('2/2');
    const out = ctx.out.mock.calls.flat().join('\n');
    expect(out).toContain('RED GATE FAILED: 1 static check failure(s) in the new test files');
    expect(out).toContain('TS2835');
    expect(out).toContain('See docs/logs/red-checks.log');
    expect(ctx.git.run.mock.calls.some(args => args.includes('commit'))).toBe(false);
  });
});

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
      expect(calls.some(args => args.includes('[implement] feat(feature): implement (attempt 1)'))).toBe(true);
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
  it('S11 Finalise readies the existing draft when createPr is on', async () => {
    const ctx = context(); ctx.env = { SDLC_CREATE_PR: '1' } as typeof ctx.env;
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
});

describe('Finalise waits for CI on the changes since Implement, and Create PR off leaves the draft', () => {
  const PR = 'https://github.com/acme/repo/pull/12';
  const HEAD = 'a'.repeat(40);
  const GREEN = 'b'.repeat(40);
  /** A run whose Implement went green in CI on GREEN; <since> are the files changed from GREEN to the pushed head. */
  function finaliseCtx(since: string[], createPr = true) {
    const ctx = context(); ctx.env = { SDLC_CREATE_PR: createPr ? '1' : '0' } as typeof ctx.env;
    Object.assign(ctx, { ciLastResult: { status: 'green' } });
    Object.assign(ctx.status, { stage: 'Finalise', ci: { enabled: true, state: 'green', pr: PR, prDraft: true, sha: GREEN, greenSha: GREEN } });
    ctx.git.run.mockImplementation((...args: string[]) => args[0] === 'diff' ? since.join('\n') : '');
    return ctx;
  }
  const output = (ctx: ReturnType<typeof context>) => [...ctx.out.mock.calls, ...ctx.err.mock.calls].flat().join('\n');
  const statusCi = (ctx: ReturnType<typeof context>) => (ctx.status as unknown as { ci: Record<string, unknown> }).ci;

  it('Review changed a source file: CI is waited on the pushed head before the PR is ready, and green finishes', async () => {
    const ctx = finaliseCtx(['src/feature.ts', 'docs/review-1.md']);
    const order: string[] = [];
    ci.wait.mockImplementation(async (_c: unknown, sha: string) => {
      order.push('wait');
      // While CI runs, the run page shows the new head as running, not the previous commit's green.
      expect(statusCi(ctx)).toMatchObject({ state: 'running', sha });
      return { status: 'green', sideEffects: [], nonBlocking: [], testFiles: [] };
    });
    ci.ready.mockImplementation(() => { order.push('ready'); return true; });
    await finaliseStage(cast(ctx));
    expect(ctx.git.run).toHaveBeenCalledWith('diff', '--name-only', GREEN, HEAD);
    expect(ci.wait).toHaveBeenCalledTimes(1);
    expect(ci.wait.mock.calls[0][1]).toBe(HEAD);
    expect(order).toEqual(['wait', 'ready']);
    expect(statusCi(ctx)).toMatchObject({ state: 'green', sha: HEAD, greenSha: HEAD, prDraft: false });
  });

  it('a red CI on the pushed head stops the run at Implement with the failing checks named', async () => {
    const ctx = finaliseCtx(['src/feature.ts']);
    ci.wait.mockResolvedValue({ status: 'red', failingChecks: ['unit (node 18)'], sideEffects: [{ classification: 'side-effect', file: 'test/old.test.ts', checkName: 'unit (node 18)', testName: 'regression', message: 'expected true' }], nonBlocking: [], testFiles: ['test/old.test.ts'] });
    await expect(finaliseStage(cast(ctx))).rejects.toMatchObject({ code: 1, resumeFrom: 'implement' });
    const out = output(ctx);
    expect(out).toContain('unit (node 18)');
    expect(out).toContain('--from implement');
    expect(ci.ready).not.toHaveBeenCalled();
    expect(statusCi(ctx)).toMatchObject({ state: 'red: side effect', sha: HEAD, greenSha: GREEN, failingChecks: ['unit (node 18)'] });
    // The resumed Implement reads the failure, and errors.log keeps it.
    expect(await fs.readFile(path.join(root, 'docs/logs/tests.log'), 'utf8')).toContain('test/old.test.ts :: regression');
    expect(await fs.readFile(path.join(root, 'docs/ci-failure.md'), 'utf8')).toContain('unit (node 18)');
    expect(await fs.readFile(path.join(root, 'docs/logs/errors.log'), 'utf8')).toContain('unit (node 18)');
  });

  it('only docs changed since CI was green: no second wait', async () => {
    const ctx = finaliseCtx(['docs/review-1.md', 'docs/brief.md']);
    await finaliseStage(cast(ctx));
    expect(ci.wait).not.toHaveBeenCalled();
    expect(ci.ready).toHaveBeenCalledTimes(1);
    expect(output(ctx)).toContain(`Pull request ready for review: ${PR}`);
  });

  it('the head CI was green on is pushed unchanged: no second wait', async () => {
    const ctx = finaliseCtx([]);
    Object.assign(statusCi(ctx), { greenSha: HEAD });
    await finaliseStage(cast(ctx));
    expect(ci.wait).not.toHaveBeenCalled();
  });

  it('no green commit is known (a resumed run): CI runs again on the pushed head', async () => {
    const ctx = finaliseCtx([]);
    delete statusCi(ctx).greenSha;
    await finaliseStage(cast(ctx));
    expect(ci.wait).toHaveBeenCalledTimes(1);
    expect(ci.wait.mock.calls[0][1]).toBe(HEAD);
  });

  it('Create PR off: the branch is pushed, the draft stays a draft and nothing says it was created or is ready', async () => {
    const ctx = finaliseCtx(['docs/review-1.md'], false);
    await finaliseStage(cast(ctx));
    expect(ctx.git.run).toHaveBeenCalledWith('push', '-u', 'origin', 'sdlc/feature');
    expect(ci.ready).not.toHaveBeenCalled();
    const out = output(ctx);
    expect(out).toContain(`Draft pull request left as a draft (Create PR is off): ${PR}`);
    expect(out).not.toMatch(/PR created|ready for review/);
    expect(statusCi(ctx).prDraft).toBe(true);
  });

  it('Create PR off still waits for CI when Review changed the source', async () => {
    const ctx = finaliseCtx(['src/feature.ts'], false);
    await finaliseStage(cast(ctx));
    expect(ci.wait).toHaveBeenCalledTimes(1);
    expect(ci.ready).not.toHaveBeenCalled();
  });
});
