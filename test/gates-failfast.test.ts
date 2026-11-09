import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi, afterEach } from 'vitest';
import * as runners from '../src/runners/run.js';
import * as filesModule from '../src/runners/files.js';
import type { RunResult } from '../src/runners/types.js';
import { targetTestFiles, testsPass, successCheck } from '../src/pipeline/gates.js';
import type { Ctx } from '../src/pipeline/context.js';
import { renderPrompt } from '../src/pipeline/prompts.js';
import { formatCheckFailures, lintFailures } from '../src/pipeline/stages.js';
import { lintNote, promptValues } from '../src/pipeline/agent.js';
import { tmp } from './helpers.js';

function makeCtx(dir: string, overrides: Partial<Ctx> = {}): Ctx {
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return {
    root: dir,
    log: 'logs',
    docs: 'docs',
    backlog: 'docs/backlog',
    slug: 'my-feature',
    from: 'implement',
    fromN: 4,
    branch: 'sdlc/my-feature',
    env: {},
    envModels: {},
    registryFile: '',
    limits: { maxAttempts: 4, maxTurns: 10, maxRepairTests: 2 },
    git: {
      lines: vi.fn().mockReturnValue([]),
    } as any,
    keys: {} as any,
    status: {} as any,
    spawnAgent: vi.fn(),
    promptsDir: '',
    guide: '',
    allowed: [],
    testFileCmd: 'npm test --',
    fetchCmd: '',
    permRepo: '',
    redSha: '',
    lockSha: '',
    origRedSha: '',
    failLog: '',
    out: vi.fn(),
    err: vi.fn(),
    config: {
      root: dir,
      suites: [
        {
          name: 'unit',
          dir: '.',
          runner: 'vitest',
          packageManager: 'npm',
          testGlobs: ['test/**/*.test.ts'],
          testCmd: 'npm test',
        },
      ],
      tests: { retry: false, maxWorkers: 1 },
      integration: null,
      lint: null,
      worktree: { base: '', link: [] },
      git: { branchPrefix: 'sdlc/', base: null, conflictSuffixStart: 10001 },
      agent: { harness: 'claude', allowCommands: [], codeSearch: null, codeIndexer: null },
      finalise: { envExample: true, maxFileBytes: 1024 * 1024 },
      ui: { timezone: 'UTC' },
      node: { version: '20' },
      backlogDir: 'docs/backlog',
    } as any,
    layout: {
      testPathspecs: ['test/'],
      testFiles: 'test/',
      testCmd: 'npm test',
    } as any,
    ...overrides,
  };
}

function mockRunResult(ok: boolean, files: string[] = ['test/a.test.ts']): runners.RunAll {
  const result: RunResult = {
    runner: 'vitest',
    suite: 'unit',
    ok,
    exitCode: ok ? 0 : 1,
    command: 'npm test',
    tests: files.map(file => ({
      file,
      name: `test in ${file}`,
      status: ok ? 'passed' : 'failed',
      message: ok ? null : 'expected true to be false',
    })),
    suiteErrors: [],
  };
  return {
    results: [result],
    merged: result,
  };
}

describe('targetTestFiles', () => {
  test('extracts failing files from red.json and tests.json and git diff, filtering nonexistent files', () => {
    const dir = tmp('sdlc-gates-target-');
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/a.test.ts'), '// a');
    fs.writeFileSync(path.join(dir, 'test/b.test.ts'), '// b');
    fs.writeFileSync(path.join(dir, 'test/c.test.ts'), '// c');

    const ctx = makeCtx(dir, { redSha: 'abc1234' });

    // 1. red.json with failing test a and passing test b
    fs.writeFileSync(path.join(dir, 'logs/red.json'), JSON.stringify({
      tests: [
        { file: 'test/a.test.ts', name: 't1', status: 'failed' },
        { file: 'test/b.test.ts', name: 't2', status: 'passed' },
        { file: 'test/nonexistent.test.ts', name: 't3', status: 'failed' },
      ],
      suiteErrors: [],
    }));

    // 2. tests.json with failing test c
    fs.writeFileSync(path.join(dir, 'logs/tests.json'), JSON.stringify({
      tests: [
        { file: 'test/c.test.ts', name: 't4', status: 'failed' },
      ],
      suiteErrors: [],
    }));

    // 3. git diff returns test/a.test.ts
    (ctx.git.lines as any).mockReturnValue(['test/a.test.ts']);

    const targets = targetTestFiles(ctx);
    expect(targets.sort()).toEqual(['test/a.test.ts', 'test/c.test.ts']);
    expect(targets).not.toContain('test/b.test.ts');
    expect(targets).not.toContain('test/nonexistent.test.ts');
  });

  test('extracts suiteErrors from red.json', () => {
    const dir = tmp('sdlc-gates-suite-error-');
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/broken.test.ts'), '// broken');

    const ctx = makeCtx(dir);
    fs.writeFileSync(path.join(dir, 'logs/red.json'), JSON.stringify({
      tests: [],
      suiteErrors: [{ file: 'test/broken.test.ts', message: 'syntax error' }],
    }));

    const targets = targetTestFiles(ctx);
    expect(targets).toEqual(['test/broken.test.ts']);
  });

  test('returns empty array when no files failed or exist', () => {
    const dir = tmp('sdlc-gates-empty-');
    const ctx = makeCtx(dir);
    expect(targetTestFiles(ctx)).toEqual([]);
  });
});

describe('testsPass fail-fast behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('fail-fast: when target test fails, returns false immediately and never runs full suite', () => {
    const dir = tmp('sdlc-gates-failfast-fail-');
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/target.test.ts'), '// target');
    fs.writeFileSync(path.join(dir, 'test/other.test.ts'), '// other');

    const ctx = makeCtx(dir);
    const runSuitesSpy = vi.spyOn(runners, 'runSuites').mockImplementation((_config, opts) => {
      if (opts.files && opts.files.includes('test/target.test.ts')) {
        return mockRunResult(false, ['test/target.test.ts']);
      }
      return mockRunResult(true, ['test/target.test.ts', 'test/other.test.ts']);
    });

    const result = testsPass(ctx, { targetFiles: ['test/target.test.ts'] });
    expect(result).toBe(false);
    // Should run ONLY the target file, NOT the full suite!
    expect(runSuitesSpy).toHaveBeenCalledTimes(1);
    expect(runSuitesSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ files: ['test/target.test.ts'] }),
    );

    // Verify tests.log and tests.json were written
    expect(fs.existsSync(path.join(dir, 'logs/tests.log'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'logs/tests.log'), 'utf8')).toContain('FAIL  test/target.test.ts');
    expect(fs.existsSync(path.join(dir, 'logs/tests.json'))).toBe(true);
  });

  test('target passes and covers all suite files: returns true without running full suite a second time', () => {
    const dir = tmp('sdlc-gates-failfast-single-');
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/only.test.ts'), '// only');

    const ctx = makeCtx(dir);
    vi.spyOn(filesModule, 'suiteFiles').mockReturnValue(['test/only.test.ts']);
    const runSuitesSpy = vi.spyOn(runners, 'runSuites').mockReturnValue(mockRunResult(true, ['test/only.test.ts']));

    const result = testsPass(ctx, { targetFiles: ['test/only.test.ts'] });
    expect(result).toBe(true);
    // Ran target file, which was 100% of all suite files, so did not run full suite again!
    expect(runSuitesSpy).toHaveBeenCalledTimes(1);
  });

  test('target passes but other suite files exist: runs target first, then full suite for zero-trust verification', () => {
    const dir = tmp('sdlc-gates-failfast-pass-then-full-');
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/target.test.ts'), '// target');
    fs.writeFileSync(path.join(dir, 'test/other.test.ts'), '// other');

    const ctx = makeCtx(dir);
    vi.spyOn(filesModule, 'suiteFiles').mockReturnValue(['test/target.test.ts', 'test/other.test.ts']);
    const runSuitesSpy = vi.spyOn(runners, 'runSuites').mockImplementation((_config, opts) => {
      if (opts.files) {
        // First run: target only
        return mockRunResult(true, ['test/target.test.ts']);
      }
      // Second run: full suite
      return mockRunResult(true, ['test/target.test.ts', 'test/other.test.ts']);
    });

    const result = testsPass(ctx, { targetFiles: ['test/target.test.ts'] });
    expect(result).toBe(true);
    expect(runSuitesSpy).toHaveBeenCalledTimes(2);
    expect(runSuitesSpy).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ files: ['test/target.test.ts'] }),
    );
    expect(runSuitesSpy).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.not.objectContaining({ files: expect.anything() }),
    );
  });

  test('tests.log shows the error of a run with no failing test', () => {
    const dir = tmp('sdlc-gates-no-failing-test-');
    const xml = '<testsuites><testsuite name="suite" file="t/x.test.sh"><testcase name="one"/></testsuite></testsuites>';
    fs.writeFileSync(path.join(dir, 'make-report.sh'), `mkdir -p out && printf '%s' '${xml}' > out/junit.xml && echo coverage threshold not met >&2 && exit 1\n`);
    const ctx = makeCtx(dir);
    ctx.config.suites = [{ name: 'unit', dir: '.', runner: 'generic-junit', packageManager: 'npm', testGlobs: [], testCmd: 'sh make-report.sh', report: 'out/junit.xml' } as any];

    expect(testsPass(ctx)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'logs/tests.log'), 'utf8')).toContain('coverage threshold not met');
  });

  test('no target files: runs full suite directly', () => {
    const dir = tmp('sdlc-gates-no-targets-');
    const ctx = makeCtx(dir);
    const runSuitesSpy = vi.spyOn(runners, 'runSuites').mockReturnValue(mockRunResult(true, ['test/a.test.ts']));

    const result = testsPass(ctx);
    expect(result).toBe(true);
    expect(runSuitesSpy).toHaveBeenCalledTimes(1);
    expect(runSuitesSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ files: expect.anything() }),
    );
  });
});

describe('successCheck', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('delegates target files to testsPass automatically from targetTestFiles', async () => {
    const dir = tmp('sdlc-gates-success-check-');
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test/failed.test.ts'), '// failed');

    const ctx = makeCtx(dir);
    fs.writeFileSync(path.join(dir, 'logs/red.json'), JSON.stringify({
      tests: [{ file: 'test/failed.test.ts', name: 't', status: 'failed' }],
      suiteErrors: [],
    }));

    const runSuitesSpy = vi.spyOn(runners, 'runSuites').mockReturnValue(mockRunResult(false, ['test/failed.test.ts']));

    const ok = await successCheck(ctx);
    expect(ok).toBe(false);
    expect(ctx.failLog).toBe('logs/tests.log');
    expect(runSuitesSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ files: ['test/failed.test.ts'] }),
    );
  });
});

describe('the linter in the green gate', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const STYLISH = '\n/work/repo/src/a.ts\n  70:81  error  Unnecessary escape character: \\/  no-useless-escape\n\n/work/repo/test/b.test.ts\n  1:32  error  \'vi\' is defined but never used  @typescript-eslint/no-unused-vars\n\n✖ 2 problems (2 errors, 0 warnings)\n';

  const withLint = (dir: string, cmd: string) => { const ctx = makeCtx(dir); (ctx.config as any).lint = cmd; return ctx; };

  test('passing tests are not enough: a failing lint command fails the gate, with its output in logs/lint.log', async () => {
    const dir = tmp('sdlc-gates-lint-');
    fs.writeFileSync(path.join(dir, 'out.txt'), STYLISH);
    vi.spyOn(runners, 'runSuites').mockReturnValue(mockRunResult(true));
    const ctx = withLint(dir, 'cat out.txt; exit 1');
    expect(await successCheck(ctx)).toBe(false);
    expect(ctx.failLog).toBe('logs/lint.log');
    expect(fs.readFileSync(path.join(dir, 'logs/lint.log'), 'utf8')).toContain('no-useless-escape');
    expect(formatCheckFailures(ctx)).toEqual([
      'LINT: /work/repo/src/a.ts:70:81 Unnecessary escape character: \\/ (no-useless-escape)',
      "LINT: /work/repo/test/b.test.ts:1:32 'vi' is defined but never used (@typescript-eslint/no-unused-vars)",
    ]);
  });

  test('a clean lint passes the gate, and a project without a lint command is not checked', async () => {
    const dir = tmp('sdlc-gates-lint-ok-');
    vi.spyOn(runners, 'runSuites').mockReturnValue(mockRunResult(true));
    expect(await successCheck(withLint(dir, 'exit 0'))).toBe(true);
    const bare = tmp('sdlc-gates-lint-none-');
    expect(await successCheck(makeCtx(bare))).toBe(true);
    expect(fs.existsSync(path.join(bare, 'logs/lint.log'))).toBe(false);
  });

  test('failing tests are reported before lint is run', async () => {
    const dir = tmp('sdlc-gates-lint-order-');
    vi.spyOn(runners, 'runSuites').mockReturnValue(mockRunResult(false));
    const ctx = withLint(dir, 'exit 1');
    expect(await successCheck(ctx)).toBe(false);
    expect(ctx.failLog).toBe('logs/tests.log');
    expect(fs.existsSync(path.join(dir, 'logs/lint.log'))).toBe(false);
  });

  test('lintFailures falls back to the lines that say error when the output is not in the stylish format', () => {
    expect(lintFailures('src/a.ts(3,1): error TS1005: x expected\nnoise\n')).toEqual(['LINT: src/a.ts(3,1): error TS1005: x expected']);
  });

  test('the Implement prompt names the linter and its log; with no linter it says nothing', () => {
    const ctx = withLint(tmp('sdlc-lint-note-'), 'npm run lint');
    expect(lintNote(ctx)).toContain("'npm run lint'");
    expect(lintNote(ctx)).toContain('logs/lint.log');
    expect(lintNote(makeCtx(tmp('sdlc-lint-note-none-')))).toBe('');
  });

  test('the Red tests and Implement prompts carry the lint requirement, filled in from the run', () => {
    const ctx = withLint(tmp('sdlc-lint-prompts-'), 'npm run lint');
    const values = promptValues(ctx);
    const red = renderPrompt('red-tests', values, 'GUIDE');
    const impl = renderPrompt('implement', values, 'GUIDE');
    expect(red).toContain("lints the project ('npm run lint'), your test files included");
    expect(impl).toContain("also runs the linter ('npm run lint')");
    expect(red).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(impl).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const bare = promptValues(makeCtx(tmp('sdlc-lint-prompts-none-')));
    expect(renderPrompt('red-tests', bare, 'GUIDE')).not.toContain('lint');
    expect(renderPrompt('implement', bare, 'GUIDE')).not.toContain('linter');
  });
});
