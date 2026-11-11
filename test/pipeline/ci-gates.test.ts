import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { testsPass, successCheck } from '../../src/pipeline/gates.js';
import { spawnShell } from '../../src/shell.js';
import { runSuites } from '../../src/runners/run.js';
import type { Ctx } from '../../src/pipeline/context.js';
import type { RunResult } from '../../src/runners/types.js';

vi.mock('../../src/runners/run.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/runners/run.js')>(), runSuites: vi.fn(),
}));
vi.mock('../../src/runners/files.js', () => ({ suiteFiles: vi.fn(() => ['test/red.test.ts', 'test/old.test.ts']) }));
vi.mock('../../src/shell.js', () => ({ spawnShell: vi.fn() }));

let root: string;
beforeEach(async () => { vi.clearAllMocks(); root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-gates-')); await fs.mkdir(path.join(root, 'logs')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function result(failures: string[] = [], fileError = false): RunResult {
  return { runner: 'vitest', suite: 'unit', command: 'vitest run', ok: !failures.length && !fileError, exitCode: failures.length || fileError ? 1 : 0,
    tests: failures.map(file => ({ file, name: 'suite rejects input', status: 'failed', message: 'expected true' })),
    suiteErrors: fileError ? [{ file: null, message: 'runner crashed' }] : [] };
}
function arrange(mode = 'ci', available = true, allowFailures: string[] = []) {
  const ctx = { root, log: 'logs', redSha: 'red', ciAvailable: available, ciSideEffectFiles: [],
    layout: { testPathspecs: ['test/**/*.test.ts'] },
    git: { lines: vi.fn(() => ['test/red.test.ts']) },
    config: { tests: { fullSuite: mode, retry: false, maxWorkers: null, allowFailures }, suites: [{ name: 'unit', dir: '.', runner: 'vitest', testGlobs: ['test/**/*.test.ts'] }] },
    env: {}, out: vi.fn(),
  };
  return ctx;
}
function respond(r = result()) { vi.mocked(runSuites).mockReturnValue({ results: [r], merged: r }); }

describe('local gates with CI (spec 6, 8.4)', () => {
  it('G01 runs scoped targets once without a second full-suite run', () => {
    const ctx = arrange(); respond();
    expect(testsPass(ctx as unknown as Ctx, { targetFiles: ['test/red.test.ts'] })).toBe(true);
    expect(runSuites).toHaveBeenCalledTimes(1);
    expect(runSuites).toHaveBeenCalledWith(ctx.config, expect.objectContaining({ files: ['test/red.test.ts'] }));
  });
  it.each([['local', true], ['ci', false]])('G02 restores full-suite gating for %s / available=%s', (mode, available) => {
    const ctx = arrange(mode, available); respond();
    expect(testsPass(ctx as unknown as Ctx, { targetFiles: ['test/red.test.ts'] })).toBe(true);
    expect(runSuites).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runSuites).mock.calls[1][1].files).toBeUndefined();
  });
  it.each(['local', 'ci'])('G03 all allowed failures pass with visible warnings in %s mode', async mode => {
    const ctx = arrange(mode, true, ['test/old.test.ts']); respond(result(['test/old.test.ts']));
    expect(testsPass(ctx as unknown as Ctx, { targetFiles: ['test/old.test.ts'], onlyTargets: true })).toBe(true);
    expect(ctx.out.mock.calls.flat().join('\n')).toMatch(/WARNING.*old\.test\.ts/);
    expect(await fs.readFile(path.join(root, 'logs/tests.log'), 'utf8')).toContain('old.test.ts');
  });
  it('G04 a mixture of allowed and unallowed failures remains red', () => {
    const ctx = arrange('local', true, ['test/old.test.ts']); respond(result(['test/old.test.ts', 'test/new.test.ts']));
    expect(testsPass(ctx as unknown as Ctx)).toBe(false);
  });
  it('G05 a red test matching an allow entry remains blocking', async () => {
    await fs.writeFile(path.join(root, 'logs/red.json'), JSON.stringify(result(['test/red.test.ts'])));
    const ctx = arrange('local', true, ['test/red.test.ts']); respond(result(['test/red.test.ts']));
    expect(testsPass(ctx as unknown as Ctx)).toBe(false);
    expect(ctx.out.mock.calls.flat().join('\n')).toMatch(/WARNING.*red\.test\.ts/);
  });
  it('G06 a runner/file error cannot be waived by a file glob', () => {
    const ctx = arrange('local', true, ['**/*']); respond(result([], true));
    expect(testsPass(ctx as unknown as Ctx)).toBe(false);
  });
  it('G07 Implement adds CI side-effect files to the scoped local gate', () => {
    const ctx = arrange(); respond();
    Object.assign(ctx, { ciSideEffectFiles: ['test/old.test.ts'], status: { stage: 'Implement' } });
    expect(testsPass(ctx as unknown as Ctx, { targetFiles: ['test/red.test.ts'] })).toBe(true);
    expect(runSuites).toHaveBeenCalledWith(ctx.config, expect.objectContaining({ files: expect.arrayContaining(['test/red.test.ts', 'test/old.test.ts']) }));
    expect(runSuites).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1])('G08 still runs integration.cmd locally and respects exit %i', async exitCode => {
    const ctx = arrange(); respond();
    Object.assign(ctx.config, { integration: { cmd: 'fixture-integration', ci: 'skip' } });
    vi.mocked(spawnShell).mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', exitCode));
      return child as ReturnType<typeof spawnShell>;
    });
    expect(await successCheck(ctx as unknown as Ctx, { targetFiles: ['test/red.test.ts'] })).toBe(exitCode === 0);
    expect(spawnShell).toHaveBeenCalledWith('fixture-integration', expect.objectContaining({ cwd: root }));
  });
});
