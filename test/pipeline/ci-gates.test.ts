import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { resultsNow, successCheck, testsPass } from '../../src/pipeline/gates.js';
import { localCounts } from '../../src/pipeline/ci-rounds.js';
import { spawnShell } from '../../src/shell.js';
import { runSuites } from '../../src/runners/run.js';
import type { Ctx } from '../../src/pipeline/context.js';
import type { RunResult } from '../../src/runners/types.js';

vi.mock('../../src/runners/run.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/runners/run.js')>(), runSuites: vi.fn(),
}));
vi.mock('../../src/runners/files.js', () => ({ suiteFiles: vi.fn(() => ['test/red.test.ts', 'test/old.test.ts']) }));
vi.mock('../../src/shell.js', async importOriginal => ({ ...await importOriginal<typeof import('../../src/shell.js')>(), spawnShell: vi.fn() }));

let root: string;
beforeEach(async () => { vi.clearAllMocks(); root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-gates-')); await fs.mkdir(path.join(root, 'logs')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

function result(failures: string[] = [], fileError = false): RunResult {
  return { runner: 'vitest', suite: 'unit', command: 'vitest run', ok: !failures.length && !fileError, exitCode: failures.length || fileError ? 1 : 0,
    tests: failures.map(file => ({ file, name: 'suite rejects input', status: 'failed', message: 'expected true' })),
    suiteErrors: fileError ? [{ file: null, message: 'runner crashed' }] : [] };
}
function arrange(mode = 'ci', available = true, allowFailures: string[] = []) {
  const ctx = { root, log: 'logs', redSha: 'red', ciAvailable: available,
    layout: { testPathspecs: ['test/**/*.test.ts'] },
    git: { lines: vi.fn(() => ['test/red.test.ts']) },
    config: { tests: { fullSuite: mode, retry: false, maxWorkers: null, allowFailures }, suites: [{ name: 'unit', dir: '.', runner: 'vitest', testGlobs: ['test/**/*.test.ts'] }] },
    env: {}, out: vi.fn(),
  };
  return ctx;
}
function respond(r = result()) { vi.mocked(runSuites).mockReturnValue({ results: [r], merged: r }); }

async function useRealRunner() {
  const actual = await vi.importActual<typeof import('../../src/runners/run.js')>('../../src/runners/run.js');
  vi.mocked(runSuites).mockImplementation(actual.runSuites);
}

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
  it('a resumed Implement gate executes the CI-reported test in its own file', async () => {
    const ctx = arrange();
    Object.assign(ctx, { env: process.env, status: { stage: 'Implement' } });
    await fs.mkdir(path.join(root, 'test'));
    await fs.symlink(path.resolve('node_modules'), path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    const listed = [
      { file: 'test/red.test.ts', name: 'new feature', addedBy: ['red'] },
      { file: 'test/old.test.ts', name: 'CI regression', addedBy: ['ci'] },
    ];
    await fs.writeFile(path.join(root, 'logs/test-list.json'), JSON.stringify(listed.map(t => ({ ...t, state: 'active', reason: 'failed' }))));
    const imports = "import { test } from 'vitest'; import fs from 'node:fs';";
    await fs.writeFile(path.join(root, listed[0].file), imports +
      "test('new feature', () => {}); test('CI regression', () => fs.writeFileSync('wrong-file', ''));");
    await fs.writeFile(path.join(root, listed[1].file), imports +
      "test('CI regression', () => { throw new Error('CI regression reproduced'); });");
    await useRealRunner();

    expect(await successCheck(ctx as unknown as Ctx, { testList: true })).toBe(false);
    const report = JSON.parse(await fs.readFile(path.join(root, 'logs/tests.json'), 'utf8'));
    expect(report.tests).toContainEqual(expect.objectContaining({ file: listed[1].file, name: listed[1].name, status: 'failed' }));
    expect(localCounts(ctx as unknown as Ctx)).toEqual({ total: 2, failed: 1 });
    await expect(fs.stat(path.join(root, 'wrong-file'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
  it('local mode runs the active names first and discovers an unrelated failure in the full suite', async () => {
    const ctx = arrange('local');
    ctx.env = process.env;
    await useRealRunner();
    await fs.mkdir(path.join(root, 'test'));
    await fs.symlink(path.resolve('node_modules'), path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    const file = 'test/red.test.ts';
    await fs.writeFile(path.join(root, file), "import { test } from 'vitest'; import fs from 'node:fs'; " +
      "test('active', () => fs.appendFileSync('executed', 'A')); test('older', () => { fs.appendFileSync('executed', 'B'); throw new Error('older regression'); });");
    await fs.writeFile(path.join(root, 'logs/test-list.json'), JSON.stringify([{ file, name: 'active', addedBy: ['red'], state: 'active', reason: 'failed' }]));

    expect(await successCheck(ctx as unknown as Ctx, { testList: true })).toBe(false);
    expect(await fs.readFile(path.join(root, 'executed'), 'utf8')).toBe('AAB');
    expect(await fs.readFile(path.join(root, 'logs/tests.log'), 'utf8')).toContain('older regression');
  }, 30_000);

  it.each(['node-test', 'generic-junit'])('%s still judges all tests in the target file', async runner => {
    const ctx = arrange();
    ctx.env = process.env;
    await useRealRunner();
    await fs.mkdir(path.join(root, 'test'));
    const file = 'test/red.test.js';
    const nodeSource = "const { test } = require('node:test'); test('listed', () => {}); test('other', () => { throw new Error('regression'); });";
    const xml = '<testsuite file="test/red.test.js"><testcase name="listed"/><testcase name="other"><failure message="regression"/></testcase></testsuite>';
    await fs.writeFile(path.join(root, file), nodeSource);
    await fs.writeFile(path.join(root, 'report.sh'), `printf '%s' '${xml}' > report.xml && exit 1`);
    Object.assign(ctx.config.suites[0], { runner, testGlobs: [file], testCmd: runner === 'node-test' ? 'node --test' : 'sh report.sh', report: 'report.xml' });
    await fs.writeFile(path.join(root, 'logs/test-list.json'), JSON.stringify([{ file, name: 'listed', addedBy: ['red'], state: 'active', reason: 'failed' }]));

    expect(await successCheck(ctx as unknown as Ctx, { testList: true })).toBe(false);
    const report = JSON.parse(await fs.readFile(path.join(root, 'logs/tests.json'), 'utf8'));
    expect(report.tests).toContainEqual(expect.objectContaining({ file, name: 'other', status: 'failed' }));
    expect(ctx.out.mock.calls.flat().filter(line => String(line).includes('without a name filter'))).toHaveLength(1);
  });

  it('a run without test-list.json uses red.json entries', async () => {
    const ctx = arrange();
    Object.assign(ctx, { env: process.env });
    await fs.mkdir(path.join(root, 'test'));
    await fs.symlink(path.resolve('node_modules'), path.join(root, 'node_modules'));
    await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await fs.writeFile(path.join(root, 'logs/red.json'), JSON.stringify({
      tests: [{ file: 'test/red.test.ts', name: 'feature fails', status: 'failed' }],
      suiteErrors: [],
    }));
    await fs.writeFile(path.join(root, 'test/red.test.ts'),
      "import { test } from 'vitest'; test('feature fails', () => {});");
    // No test-list.json exists: the gate should read red.json.
    await expect(fs.stat(path.join(root, 'logs/test-list.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await useRealRunner();

    expect(await successCheck(ctx as unknown as Ctx, { testList: true })).toBe(true);
    expect(ctx.out.mock.calls.flat().join('\n')).toContain('No test-list.json');
    // After the fallback, test-list.json is created from red.json.
    expect(await fs.stat(path.join(root, 'logs/test-list.json'))).toBeTruthy();
  }, 30_000);

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
  it('G09 a gate with nothing in scope runs nothing locally when the full suite is CI', () => {
    const ctx = arrange(); respond();
    expect(testsPass(ctx as unknown as Ctx)).toBe(true);
    expect(runSuites).not.toHaveBeenCalled();
    expect(ctx.out.mock.calls.flat().join('\n')).toMatch(/full suite runs in CI only/);
  });
  it('G10 a results snapshot with no files never runs every suite locally when the full suite is CI', async () => {
    const ctx = arrange(); respond();
    resultsNow(ctx as unknown as Ctx, 'logs/snapshot.json');
    expect(runSuites).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, 'logs/snapshot.json'))).rejects.toThrow();
    expect(ctx.out.mock.calls.flat().join('\n')).toMatch(/full suite runs in CI, not here/);
  });
  it('G11 a results snapshot with files still runs those files locally', () => {
    const ctx = arrange(); respond();
    resultsNow(ctx as unknown as Ctx, 'logs/snapshot.json', ['test/red.test.ts']);
    expect(runSuites).toHaveBeenCalledWith(ctx.config, expect.objectContaining({ files: ['test/red.test.ts'] }));
  });
});
