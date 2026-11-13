import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from '../../src/trace.js';
import { getPrStatus } from '../../src/pipeline/finalise.js';
import type { Ctx } from '../../src/pipeline/context.js';

vi.mock('../../src/trace.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/trace.js')>(), spawnSync: vi.fn(), trace: vi.fn() }));
vi.mock('../../src/pipeline/finalise.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/pipeline/finalise.js')>(), getPrStatus: vi.fn() }));

let root: string;
const head = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const url = 'https://github.com/acme/repo/pull/12';
const output = (stdout = '', status = 0, stderr = '') => ({ status, stdout, stderr, signal: null, pid: 1, output: [] });
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-step-'));
  await fs.mkdir(path.join(root, 'logs'));
});
afterEach(async () => { vi.useRealTimers(); await fs.rm(root, { recursive: true, force: true }); });

function context(waitMinutes = 60) {
  const git = { root, branch: vi.fn(() => 'sdlc/feature'), head: vi.fn(() => head),
    run: vi.fn((...args: string[]) => args[0] === 'remote' ? 'origin\n' : args[0] === 'merge-base' ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' : ''),
    lines: vi.fn((...args: string[]) => args[0] === 'remote' ? ['origin'] : []) };
  return { root, docs: '.', log: 'logs', branch: 'sdlc/feature', slug: 'feature', redSha: 'red', git,
    config: { tests: { fullSuite: 'ci', allowFailures: [] as string[] }, ci: { waitMinutes }, git: { base: 'main' } },
    env: {}, out: vi.fn(), err: vi.fn(), status: { write: vi.fn() },
  };
}
function status(checks: Record<string, unknown>[]) {
  return { url, number: 12, state: 'OPEN' as const, isDraft: true, headRefOid: head, statusCheckRollup: checks };
}
function commandFixture(fail?: string) {
  vi.mocked(spawnSync).mockImplementation((command, args) => {
    const cmd = `${command} ${(args || []).join(' ')}`;
    if (fail && cmd.includes(fail)) return output('', 1, 'permission denied\nsecond line');
    if (cmd.includes('remote')) return output('origin\n');
    if (cmd.includes('pr view') || cmd.includes('pr list')) return output(JSON.stringify(status([])));
    if (cmd.includes('pr create')) return output(`${url}\n`);
    if (cmd.includes('run list')) return output('[]');
    if (cmd.includes('run download')) return output('', 1, 'artifact not found');
    return output();
  });
  vi.mocked(getPrStatus).mockReturnValue(status([]));
}

describe('CI availability (spec 4.3)', () => {
  it('I01 pushes with upstream tracking and opens/reuses a PR', async () => {
    const { checkCiAvailability } = await import('../../src/pipeline/ci.js');
    const ctx = context(); commandFixture();
    expect(await checkCiAvailability(ctx as unknown as Ctx)).toMatchObject({ available: true });
    const pushedByGit = ctx.git.run.mock.calls.some(args => args.includes('push') && args.includes('-u') && args.includes('origin') && args.includes(ctx.branch));
    const pushedBySpawn = vi.mocked(spawnSync).mock.calls.some(([cmd, args]) => cmd === 'git' && args?.includes('push') && args.includes('-u') && args.includes('origin') && args.includes(ctx.branch));
    expect(pushedByGit || pushedBySpawn).toBe(true);
  });
  it('I02 reports no remote without attempting a push', async () => {
    const { checkCiAvailability } = await import('../../src/pipeline/ci.js');
    const ctx = context(); commandFixture();
    ctx.git.run.mockReturnValue(''); ctx.git.lines.mockReturnValue([]);
    vi.mocked(spawnSync).mockReturnValue(output(''));
    expect(await checkCiAvailability(ctx as unknown as Ctx)).toMatchObject({ available: false, reason: 'no remote' });
    expect(ctx.git.run.mock.calls.some(args => args.includes('push'))).toBe(false);
  });
  it.each([['--version', 'gh not installed'], ['auth status', 'gh not authenticated']])('I03 reports %s failure', async (cmd, reason) => {
    const { checkCiAvailability } = await import('../../src/pipeline/ci.js');
    commandFixture(cmd);
    expect(await checkCiAvailability(context() as unknown as Ctx)).toMatchObject({ available: false, reason });
  });
  it.each([['CLOSED', 'PR is closed'], ['MERGED', 'PR is merged']])('I04 rejects a %s PR', async (state, reason) => {
    const { checkCiAvailability } = await import('../../src/pipeline/ci.js');
    commandFixture();
    vi.mocked(getPrStatus).mockReturnValue({ ...status([]), state } as ReturnType<typeof getPrStatus>);
    vi.mocked(spawnSync).mockImplementation((_cmd, args) => output(args?.includes('remote') ? 'origin\n' : args?.includes('view') || args?.includes('list') ? JSON.stringify({ ...status([]), state }) : ''));
    expect(await checkCiAvailability(context() as unknown as Ctx)).toMatchObject({ available: false, reason });
  });
});

describe('CI wait on the pushed commit (spec 5)', () => {
  it('I05 accepts success, skipped and neutral checks including commit statuses', async () => {
    const { waitForCiAndClassify } = await import('../../src/pipeline/ci.js');
    commandFixture();
    vi.mocked(getPrStatus).mockReturnValue(status([
      ...['SUCCESS', 'SKIPPED', 'NEUTRAL'].map((conclusion, i) => ({ __typename: 'CheckRun', name: `check-${i}`, status: 'COMPLETED', conclusion })),
      { __typename: 'StatusContext', context: 'external', state: 'SUCCESS', targetUrl: 'https://ci.example/1' },
    ]));
    const result = await waitForCiAndClassify(context() as unknown as Ctx, head, { prUrl: url, startTime: Date.now() });
    expect(result).toMatchObject({ status: 'green', sideEffects: [], nonBlocking: [] });
  });
  it.each(['QUEUED', 'IN_PROGRESS', 'PENDING'])('I06 continues polling while %s', async state => {
    const { waitForCiAndClassify } = await import('../../src/pipeline/ci.js');
    vi.useFakeTimers(); commandFixture();
    const pending = state === 'PENDING' ? { __typename: 'StatusContext', context: 'external', state } : { __typename: 'CheckRun', name: 'unit', status: state, conclusion: null };
    vi.mocked(getPrStatus).mockReturnValueOnce(status([pending])).mockReturnValue(status([{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }]));
    let settled = false;
    const promise = waitForCiAndClassify(context() as unknown as Ctx, head, { prUrl: url, startTime: Date.now() }).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ status: 'green' });
  });
  it('I07 reports no workflow after three minutes, never green for empty checks', async () => {
    const { waitForCiAndClassify } = await import('../../src/pipeline/ci.js');
    vi.useFakeTimers(); commandFixture();
    const promise = waitForCiAndClassify(context() as unknown as Ctx, head, { prUrl: url, startTime: Date.now() });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await promise).toMatchObject({ status: 'unavailable', reason: 'no workflow' });
  });
  it('I08 returns timed-out for a registered unfinished workflow at the configured limit', async () => {
    const { waitForCiAndClassify } = await import('../../src/pipeline/ci.js');
    vi.useFakeTimers(); commandFixture();
    vi.mocked(getPrStatus).mockReturnValue(status([{ name: 'unit', status: 'IN_PROGRESS', conclusion: null }]));
    const promise = waitForCiAndClassify(context(2) as unknown as Ctx, head, { prUrl: url, startTime: Date.now() });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await promise).toMatchObject({ status: 'timed-out' });
  });
  it('I09 does not accept success belonging to a different head', async () => {
    const { waitForCiAndClassify } = await import('../../src/pipeline/ci.js');
    vi.useFakeTimers(); commandFixture();
    vi.mocked(getPrStatus).mockReturnValue({ ...status([{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }]), headRefOid: 'cccccccccccccccccccccccccccccccccccccccc' });
    const promise = waitForCiAndClassify(context(1) as unknown as Ctx, head, { prUrl: url, startTime: Date.now() });
    await vi.advanceTimersByTimeAsync(180_000);
    expect((await promise).status).not.toBe('green');
  });
});

describe('CI artifact parsing (spec 4.4)', () => {
  it.each(['missing', 'malformed'])('I10 returns null for a %s report', async kind => {
    const { downloadTestReport } = await import('../../src/pipeline/ci.js');
    const destination = path.join(root, 'artifact');
    await fs.mkdir(destination);
    if (kind === 'malformed') await fs.writeFile(path.join(destination, 'report.json'), '{broken');
    vi.mocked(spawnSync).mockReturnValue(output('', kind === 'missing' ? 1 : 0));
    expect(await downloadTestReport(root, '42', destination, {})).toBeNull();
    expect(spawnSync).toHaveBeenCalledWith('gh', expect.arrayContaining(['run', 'download', '42', '-n', 'sdlc-test-report', '-D', destination]), expect.anything());
  });
  it('I11 parses a runner report and retains failure identity and diagnostics', async () => {
    const { downloadTestReport } = await import('../../src/pipeline/ci.js');
    const destination = path.join(root, 'artifact');
    await fs.mkdir(destination);
    await fs.writeFile(path.join(destination, 'report.json'), JSON.stringify({
      testResults: [{ name: path.join(root, 'test/old.test.ts'), assertionResults: [{ fullName: 'suite rejects input', status: 'failed', failureMessages: ['expected true'] }] }],
    }));
    vi.mocked(spawnSync).mockReturnValue(output());
    expect(await downloadTestReport(root, '42', destination, {})).toMatchObject({ tests: [expect.objectContaining({ file: 'test/old.test.ts', name: 'suite rejects input', status: 'failed', message: expect.stringContaining('expected true') })] });
  });
});

// All reports and command output are fixture data; the CI classifier itself is real.
function classificationFixture(options: { baseFails?: boolean; flaky?: boolean; artifact?: boolean; conclusion?: string; log?: string } = {}) {
  const { baseFails = false, flaky = false, artifact = true, conclusion = 'FAILURE', log = 'FAIL test/old.test.ts\n  suite rejects input\n  expected true\nTests: 1 failed' } = options;
  let rerun = false;
  const failed = { file: 'test/old.test.ts', name: 'suite rejects input', status: 'failed', message: 'expected true' };
  const report = (base: boolean) => ({ runner: 'vitest', suite: 'unit', command: 'vitest run', exitCode: base && !baseFails || rerun && flaky ? 0 : 1,
    ok: base && !baseFails || rerun && flaky,
    tests: [{ ...failed, status: base && !baseFails || rerun && flaky ? 'passed' : 'failed' }], suiteErrors: [] });
  const check = () => ({ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: rerun && flaky ? 'SUCCESS' : conclusion,
    detailsUrl: 'https://github.com/acme/repo/actions/runs/20/job/2' });
  vi.mocked(getPrStatus).mockImplementation(() => status([check()]));
  vi.mocked(spawnSync).mockImplementation((command, args = []) => {
    const cmd = `${command} ${args.join(' ')}`;
    if (cmd.includes('merge-base')) return output('b'.repeat(40));
    if (cmd.includes('run list')) {
      const base = cmd.includes('b'.repeat(40));
      return output(JSON.stringify([{ databaseId: base ? 10 : 20, headSha: base ? 'b'.repeat(40) : head, status: 'completed', conclusion: base && !baseFails ? 'success' : 'failure', url: `https://github.com/acme/repo/actions/runs/${base ? 10 : 20}` }]));
    }
    if (cmd.includes('run rerun')) { rerun = true; return output(); }
    if (cmd.includes('run download')) {
      if (!artifact) return output('', 1, 'artifact not found');
      const destination = String(args[args.indexOf('-D') + 1]);
      mkdirSync(destination, { recursive: true });
      writeFileSync(path.join(destination, 'report.json'), JSON.stringify(report(args.includes('10'))));
      return output();
    }
    if (cmd.includes('--log')) return output(log);
    if (cmd.includes('run view')) {
      const base = args.includes('10');
      const finished = base ? baseFails ? 'failure' : 'success' : rerun && flaky ? 'success' : conclusion.toLowerCase();
      return output(JSON.stringify({ databaseId: base ? 10 : 20, headSha: base ? 'b'.repeat(40) : head, status: 'completed', conclusion: finished,
        jobs: [{ databaseId: base ? 1 : 2, name: 'unit', status: 'completed', conclusion: finished, url: check().detailsUrl }] }));
    }
    return output();
  });
}

describe('real CI failure classification (spec 8)', () => {
  it.each([
    ['pre-existing', { baseFails: true }, []],
    ['pre-existing', { baseFails: true }, ['test/old.test.ts']],
    ['allowed', {}, ['test/old.test.ts > suite rejects input']],
    ['flaky', { flaky: true }, []],
    ['side-effect', {}, []],
  ] as const)('I12 classifies a reported test as %s', async (classification, options, allowFailures) => {
    const { waitForCiAndClassify } = await import('../../src/pipeline/ci.js');
    vi.useFakeTimers(); classificationFixture(options);
    const ctx = context(); ctx.config.tests.allowFailures = [...allowFailures];
    const promise = waitForCiAndClassify(ctx as unknown as Ctx, head, { prUrl: url, startTime: Date.now() });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe(classification === 'side-effect' ? 'red' : 'green-with-warnings');
    const failures = classification === 'side-effect' ? result.sideEffects : result.nonBlocking;
    expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({ classification, checkName: 'unit', file: 'test/old.test.ts', testName: 'suite rejects input' })]));
    if (classification === 'side-effect') {
      expect(result.testFiles).toContain('test/old.test.ts');
      expect(failures[0]).toMatchObject({ message: expect.stringContaining('expected true'), runUrl: expect.stringContaining('/actions/runs/20') });
    } else expect(ctx.out.mock.calls.flat().join('\n')).toContain('WARNING');
    const reruns = vi.mocked(spawnSync).mock.calls.filter(([, args]) => args?.includes('rerun'));
    expect(reruns.length).toBeLessThanOrEqual(1);
    if (classification === 'flaky') expect(reruns[0][1]).toEqual(expect.arrayContaining(['20', '--failed']));
  });
  it.each(['CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE'])('I13 classifies %s as infrastructure before comparing the base', async conclusion => {
    const { waitForCiAndClassify } = await import('../../src/pipeline/ci.js');
    classificationFixture({ conclusion, baseFails: true });
    const result = await waitForCiAndClassify(context() as unknown as Ctx, head, { prUrl: url, startTime: Date.now() });
    expect(result.status).toBe('green-with-warnings');
    expect(result.sideEffects).toEqual([]);
    expect(result.nonBlocking).toEqual(expect.arrayContaining([expect.objectContaining({ classification: 'infrastructure', checkName: 'unit' })]));
  });
  it.each([
    ['allowed', ['test/*.test.ts'], 'FAIL test/old.test.ts\nTests: 1 failed'],
    ['side-effect', ['test/old.test.ts > suite rejects input'], 'FAIL test/old.test.ts\nTests: 1 failed'],
    ['side-effect', ['test/old.test.ts'], 'FAIL test/old.test.ts\nFAIL test/new.test.ts\nTests: 2 failed'],
    ['infrastructure', [], 'Runner could not start: service unavailable'],
  ] as const)('I14 classifies missing-artifact logs as %s', async (classification, entries, log) => {
    const { waitForCiAndClassify } = await import('../../src/pipeline/ci.js');
    vi.useFakeTimers(); classificationFixture({ artifact: false, log });
    const ctx = context(); ctx.config.tests.allowFailures = [...entries];
    const promise = waitForCiAndClassify(ctx as unknown as Ctx, head, { prUrl: url, startTime: Date.now() });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.status).toBe(classification === 'side-effect' ? 'red' : 'green-with-warnings');
    expect([...result.nonBlocking, ...result.sideEffects]).toEqual(expect.arrayContaining([expect.objectContaining({ classification })]));
    expect(result.testFiles).toEqual([]);
    expect(ctx.out.mock.calls.flat().filter(line => line === 'CI test report not found: classifying by check')).toHaveLength(1);
  });
  it('I16 resolves base results from the merge-base rather than the current branch tip', async () => {
    const { fetchBaseResults } = await import('../../src/pipeline/ci.js');
    classificationFixture({ baseFails: true });
    const ctx = context();
    const result = await fetchBaseResults(ctx as unknown as Ctx);
    expect(ctx.git.run).toHaveBeenCalledWith('merge-base', 'HEAD', 'main');
    expect(spawnSync).toHaveBeenCalledWith('gh', expect.arrayContaining(['run', 'list', '--commit', 'b'.repeat(40)]), expect.anything());
    expect(result.report).toMatchObject({ tests: [expect.objectContaining({ file: 'test/old.test.ts', name: 'suite rejects input', status: 'failed' })] });
  });
  it('I15 reports the reason line of a push error on initial fallback, and keeps the whole message', async () => {
    const { checkCiAvailability } = await import('../../src/pipeline/ci.js');
    const ctx = context(); commandFixture('push');
    ctx.git.run.mockImplementation((...args) => {
      if (args.includes('push')) throw new Error('permission denied\nsecond line');
      return args[0] === 'remote' ? 'origin\n' : '';
    });
    expect(await checkCiAvailability(ctx as unknown as Ctx)).toMatchObject({ available: false, reason: 'push failed: permission denied; the whole message is in logs/errors.log' });
    expect(await fs.readFile(path.join(root, 'logs/errors.log'), 'utf8')).toContain('permission denied\nsecond line');
  });
});

const REJECTED_PUSH = [
  'git push -u origin sdlc/x failed: To https://github.com/o/r.git',
  ' ! [rejected]        sdlc/x -> sdlc/x (non-fast-forward)',
  'error: failed to push some refs to \'https://github.com/o/r.git\'',
  'hint: Updates were rejected because the tip of your current branch is behind',
].join('\n');

describe('what a failed push reports', () => {
  it('I16 gitReason picks the rejected line, not the "To <url>" line that comes first', async () => {
    const { gitReason } = await import('../../src/pipeline/ci.js');
    const reason = gitReason(REJECTED_PUSH);
    expect(reason).toContain('[rejected]');
    expect(reason).toContain('non-fast-forward');
    expect(reason.startsWith('To ')).toBe(false);
  });
  it('I17 a real rejected push is reported, flagged as rejected, and kept whole in errors.log', async () => {
    const { checkCiAvailability } = await import('../../src/pipeline/ci.js');
    const { Git } = await import('../../src/pipeline/git.js');
    const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-push-'));
    try {
      const origin = path.join(base, 'origin.git');
      const mine = path.join(base, 'mine');
      const other = path.join(base, 'other');
      sh(base, 'init', '-q', '--bare', '-b', 'main', origin);
      for (const dir of [mine, other]) {
        sh(base, 'clone', '-q', origin, dir);
        sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 't'); sh(dir, 'config', 'commit.gpgsign', 'false');
      }
      writeFileSync(path.join(mine, 'a.txt'), 'a');
      sh(mine, 'add', '-A'); sh(mine, 'commit', '-q', '-m', 'one'); sh(mine, 'push', '-q', '-u', 'origin', 'HEAD:main');
      sh(mine, 'checkout', '-q', '-b', 'sdlc/x'); sh(mine, 'push', '-q', '-u', 'origin', 'sdlc/x');
      // Someone else adds a commit to the branch that this checkout lacks.
      sh(other, 'fetch', '-q', 'origin'); sh(other, 'checkout', '-q', '-b', 'sdlc/x', '--track', 'origin/sdlc/x');
      writeFileSync(path.join(other, 'b.txt'), 'b');
      sh(other, 'add', '-A'); sh(other, 'commit', '-q', '-m', 'theirs'); sh(other, 'push', '-q');
      writeFileSync(path.join(mine, 'c.txt'), 'c');
      sh(mine, 'add', '-A'); sh(mine, 'commit', '-q', '-m', 'mine');
      mkdirSync(path.join(mine, 'logs'));

      commandFixture();
      const ctx = { ...context(), root: mine, branch: 'sdlc/x', git: new Git(mine) };
      const r = await checkCiAvailability(ctx as unknown as Ctx);
      expect(r).toMatchObject({ available: false, rejected: true, reason: expect.stringContaining('rejected') });
      expect(r.reason).not.toMatch(/^push failed: To /);
      const kept = await fs.readFile(path.join(mine, 'logs/errors.log'), 'utf8');
      expect(kept).toContain('error: failed to push some refs');
      expect(kept).toContain('[rejected]');
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
  it('I18 keepError never throws when its folder cannot be made', async () => {
    const { keepError } = await import('../../src/pipeline/errors.js');
    await fs.writeFile(path.join(root, 'file'), 'x');
    expect(() => keepError({ root: path.join(root, 'file'), log: 'logs' }, 'push', 'boom')).not.toThrow();
    keepError({ root, log: 'new/logs' }, 'push', ' boom \n');
    expect(await fs.readFile(path.join(root, 'new/logs/errors.log'), 'utf8')).toMatch(/^=== \S+ push\nboom\n\n$/);
  });
});
