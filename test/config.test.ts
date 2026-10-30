import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { detect, literalList } from '../src/config/detect.js';
import { resolve, testDir, testRunDefaults, workerLimit, worktreeBase } from '../src/config/settings.js';
import { locateTestDir as locateOf, provision, setupPlan, suggest as suggestOf } from '../src/config/suggest.js';
import { project, run } from './helpers.js';

// The tests read whichever fields the status they expect carries.
const suggest = (...a: Parameters<typeof suggestOf>): any => suggestOf(...a);
const locateTestDir = (...a: Parameters<typeof locateOf>): any => locateOf(...a);
const cli = (...args) => run(args);
const noGraft = { PATH: '/usr/bin:/bin' };
const ok = (dir, opts: any = { env: noGraft }) => {
  const r = resolve(dir, opts);
  expect(r.errors).toEqual([]);
  return r.config;
};
const errorsOf = dir => resolve(dir, { env: noGraft }).errors.join('\n');

describe('detection', () => {
  test('finds jest from a config file, the package.json key, the test script or the dependency, strongest first', async () => {
    const [s] = detect(project({ 'package.json': { scripts: { test: 'jest --ci' }, devDependencies: { jest: '^29' }, jest: {} }, 'package-lock.json': '{}' }));
    expect(s).toMatchObject({ dir: '.', runner: 'jest', language: 'javascript', packageManager: 'npm', testCmd: 'npm test' });
    expect(s.evidence).toEqual(['jest: package.json "jest" key', 'jest: scripts.test runs jest', 'jest: dependency jest']);

    const [c] = detect(project({ 'package.json': { devDependencies: { jest: '^29' } }, 'jest.config.ts': '' }));
    expect(c).toMatchObject({ runner: 'jest', testCmd: 'npx jest' });
    expect(c.evidence[0]).toBe('jest: config file jest.config.ts');
  });

  test('vitest with TypeScript, pnpm and its own config; mocha with its spec; node:test from the script', async () => {
    const [v] = detect(project({
      'package.json': { scripts: { test: 'vitest' }, devDependencies: { vitest: '^2', typescript: '^5' } },
      'vitest.config.ts': '', 'pnpm-lock.yaml': '',
    }));
    expect(v).toMatchObject({ runner: 'vitest', language: 'typescript', packageManager: 'pnpm', testCmd: 'pnpm test' });

    const [m] = detect(project({ 'package.json': { devDependencies: { mocha: '^10' } }, '.mocharc.json': { spec: './spec/**/*.spec.js' }, 'yarn.lock': '' }));
    expect(m).toMatchObject({ runner: 'mocha', packageManager: 'yarn', testCmd: 'yarn mocha', testGlobs: ['spec/**/*.spec.js'] });

    const [n] = detect(project({ 'package.json': { scripts: { test: 'node --test test/' } }, 'tsconfig.json': '{}' }));
    expect(n).toMatchObject({ runner: 'node-test', language: 'typescript', testCmd: 'npm test' });
  });

  test('scans sub-folders (monorepos), runs their tests from the root, and skips node_modules, dot folders and delegating roots', async () => {
    const dir = project({
      'package.json': { scripts: { test: 'npm run test --prefix server' }, devDependencies: { eslint: '^8' } },
      'package-lock.json': '{}',
      'server/package.json': { scripts: { test: 'jest' }, jest: { testMatch: ['<rootDir>/__tests__/**/*.test.js'] } },
      'packages/web/package.json': { scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2' } },
      'packages/web/node_modules/x/package.json': { scripts: { test: 'mocha' } },
      '.claude/plugin/package.json': { scripts: { test: 'mocha' } },
      'a/b/c/package.json': { scripts: { test: 'mocha' } },
    });
    const found = detect(dir);
    expect(found.map(f => [f.dir, f.runner, f.testCmd])).toEqual([
      ['packages/web', 'vitest', 'npm --prefix packages/web test'],
      ['server', 'jest', 'npm --prefix server test'],
    ]);
    expect(found[1].testGlobs).toEqual(['__tests__/**/*.test.js']);
  });

  test('reports a tie as ambiguous, ignores a bare dependency next to real evidence, and finds nothing in an empty project', async () => {
    const [t] = detect(project({ 'package.json': { scripts: { test: 'jest && vitest run' } } }));
    expect(t.runner).toBeNull();
    expect(t.candidates.sort()).toEqual(['jest', 'vitest']);
    expect(t.testCmd).toBeUndefined();

    const [d] = detect(project({ 'package.json': { scripts: { test: 'vitest' }, devDependencies: { jest: '^29', vitest: '^2' } } }));
    expect(d.runner).toBe('vitest');

    expect(detect(project({ 'package.json': { scripts: { test: 'echo "Error: no test specified" && exit 1' } } }))).toEqual([]);
    expect(detect(project({ 'README.txt': 'x' }))).toEqual([]);
  });
});

describe('detection in real-world layouts', () => {
  test('test patterns come from the runner config when it lists them literally: vitest include, jest testMatch or roots', async () => {
    const vitest = project({
      'package.json': { scripts: { test: 'vitest run' } },
      'vitest.config.ts': "import { configDefaults, defineConfig } from 'vitest/config';\nexport default defineConfig({\n  test: {\n"
        + "    environment: 'jsdom',\n    include: ['__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)'],\n    exclude: [...configDefaults.exclude, 'tests/e2e/**'],\n  },\n});\n",
    });
    expect(detect(vitest)[0].testGlobs).toEqual(['__tests__/**/*.{test,spec}.?(c|m)[jt]s?(x)']);

    // vite.config: only the test block counts, not optimizeDeps.include
    const vite = project({
      'package.json': { scripts: { test: 'vitest' } }, 'vitest.workspace.ts': '',
      'vite.config.ts': "export default { optimizeDeps: { include: ['react'] }, test: { include: ['src/**/*.spec.ts'] } };\n",
    });
    expect(detect(vite)[0].testGlobs).toEqual(['src/**/*.spec.ts']);

    const jestRoots = project({ 'package.json': { scripts: { test: 'jest' } }, 'jest.config.js': "module.exports = { roots: ['<rootDir>/spec'] };\n" });
    expect(detect(jestRoots)[0].testGlobs).toEqual(['spec/**/__tests__/**/*.[jt]s?(x)', 'spec/**/?(*.)+(spec|test).[jt]s?(x)']);
    const jestMatch = project({ 'package.json': { scripts: { test: 'jest' } }, 'jest.config.js': "module.exports = { testMatch: ['<rootDir>/test/**/*.it.js'], roots: ['x'] };\n" });
    expect(detect(jestMatch)[0].testGlobs).toEqual(['test/**/*.it.js']);
    const pkgRoots = project({ 'package.json': { scripts: { test: 'jest' }, jest: { roots: ['<rootDir>'] } } });
    expect(detect(pkgRoots)[0].testGlobs).toEqual(['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)']);
  });

  test('a list that cannot be read without running the config keeps the runner defaults', async () => {
    expect(literalList("include: [...shared, 'a/**']", 'include')).toBeNull();
    expect(literalList('include: patterns', 'include')).toBeNull();
    expect(literalList('include: []', 'include')).toBeNull();
    expect(literalList("include: [ // tests\n 'a/**', /* b */ 'b\\'s/**',\n]", 'include')).toEqual(['a/**', "b's/**"]);
    const dir = project({ 'package.json': { scripts: { test: 'vitest run' } }, 'vitest.config.mjs': 'export default { test: { include: globs } };\n' });
    expect(detect(dir)[0].testGlobs).toEqual(['**/*.{test,spec}.?(c|m)[jt]s?(x)']);
  });

  test('follows the scripts a test script runs, and finds a runner called by its path', async () => {
    const [s] = detect(project({ 'package.json': {
      scripts: { test: 'npm run lint && npm run cover', cover: 'istanbul cover ../../node_modules/mocha/bin/_mocha -- --recursive', lint: 'eslint .' },
    } }));
    expect(s).toMatchObject({ runner: 'mocha', testCmd: 'npm test' });
    expect(s.evidence).toEqual(['mocha: scripts.cover runs mocha']);

    const [y] = detect(project({ 'package.json': { scripts: { test: 'yarn _test', _test: 'TZ=UTC jest --no-cache' } }, 'yarn.lock': '' }));
    expect(y).toMatchObject({ runner: 'jest', testCmd: 'yarn test' });
  });

  test('a monorepo root with only a hoisted dependency is not a suite; workspace folders are found at any depth', async () => {
    const dir = project({
      'package.json': { devDependencies: { mocha: '^10' }, workspaces: ['packages/instruments/*'] },
      'packages/instruments/a/package.json': { scripts: { test: 'vitest run' } },
    });
    expect(detect(dir).map(f => [f.dir, f.runner])).toEqual([['packages/instruments/a', 'vitest']]);

    const pnpm = project({
      'package.json': {}, 'pnpm-workspace.yaml': "packages:\n  - 'tools/**'\n",
      'tools/x/y/z/package.json': { scripts: { test: 'jest' } },
    });
    expect(detect(pnpm).map(f => [f.dir, f.testCmd])).toEqual([['tools/x/y/z', 'pnpm --dir tools/x/y/z test']]);
  });

  test('a root jest config with projects covers the jest packages under it, not packages using another runner', async () => {
    const dir = project({
      'package.json': { scripts: { test: 'jest' } },
      'jest.config.js': "module.exports = { projects: ['<rootDir>/packages/**/jest.config.js'] };\n",
      'packages/a/package.json': {}, 'packages/a/jest.config.js': 'module.exports = {};\n',
      'packages/b/package.json': { scripts: { test: 'mocha' } },
    });
    const found = detect(dir);
    expect(found.map(f => [f.dir, f.runner])).toEqual([['.', 'jest'], ['packages/b', 'mocha']]);
    expect(found[0].covers).toEqual(['packages/a']);
  });

  test('an unrecognised runner is reported and skipped with a warning; a script that only hands off to a sub-folder is not', async () => {
    const dir = project({
      'package.json': { scripts: { test: 'npm run test --prefix server' } },
      'server/package.json': { scripts: { test: 'jest' } },
      'e2e/package.json': { scripts: { test: 'playwright test' } },
    });
    const found = detect(dir);
    expect(found.map(f => [f.dir, f.runner, Boolean(f.unknown)])).toEqual([['e2e', null, true], ['server', 'jest', false]]);
    const r = resolve(dir, { env: noGraft });
    expect(r.errors).toEqual([]);
    expect(r.config.suites.map(s => s.dir)).toEqual(['server']);
    expect(r.warnings.filter(w => !w.includes('graft'))).toEqual([expect.stringContaining('e2e: skipped, its test script uses a runner that is not recognised (scripts.test: playwright test)')]);
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), JSON.stringify({ suites: [{ dir: 'e2e' }] }));
    expect(errorsOf(dir)).toContain('suites[0]: the test script in e2e uses a runner that is not recognised; set "runner"');
    const out = await cli('detect', dir);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('e2e: test runner not recognised');
  });
});

describe('settings', () => {
  test('without a file: detected suites plus defaults', async () => {
    const dir = project({ 'package.json': { scripts: { test: 'jest' } }, 'package-lock.json': '{}' });
    const c = ok(dir);
    expect(c.suites).toEqual([expect.objectContaining({ dir: '.', runner: 'jest', testCmd: 'npm test', sourceGlobs: ['**'], setup: null, report: null })]);
    expect(c).toMatchObject({
      backlogDir: 'Docs/backlog', integration: null, lint: null,
      worktree: { base: '../{repo}-sdlc', link: ['node_modules'] },
      git: { branchPrefix: 'sdlc/', base: null, conflictSuffixStart: 10001 },
      agent: { allowCommands: [], codeSearch: 'none' },
      finalise: { envExample: true, maxFileBytes: 1048576 },
      ship: { envExample: true, maxFileBytes: 1048576 },
    });
    expect(typeof c.ui.timezone).toBe('string');
    expect(worktreeBase(c)).toBe(path.join(path.dirname(dir), `${path.basename(dir)}-sdlc`));
  });

  test('a file suite is completed from detection; an explicit runner gets that runner\'s defaults; code search auto needs graft on PATH and a graft/ index', async () => {
    const dir = project({
      'server/package.json': { scripts: { test: 'jest' } },
      'web/package.json': { devDependencies: { vitest: '^2' } },
      'sdlc.config.json': { suites: [{ dir: 'server/' }, { dir: 'web', runner: 'vitest', name: 'ui' }], agent: { codeSearch: 'auto' } },
    });
    const c = ok(dir);
    expect(c.suites.map(s => [s.name, s.runner, s.testCmd])).toEqual([
      ['server', 'jest', 'npm --prefix server test'],
      ['ui', 'vitest', 'cd web && npx vitest run'],
    ]);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-bin-'));
    fs.writeFileSync(path.join(bin, 'graft'), '#!/bin/sh\n', { mode: 0o755 });
    expect(ok(dir, { env: { PATH: `${bin}:/usr/bin:/bin` } }).agent.codeSearch).toBe('none');
    fs.mkdirSync(path.join(dir, 'graft'));
    expect(ok(dir, { env: { PATH: `${bin}:/usr/bin:/bin` } }).agent.codeSearch).toBe('graft');
  });

  test('rejects bad files with the setting at fault', async () => {
    expect(errorsOf(project({ 'sdlc.config.json': '{ nope' }))).toMatch(/sdlc\.config\.json: not valid JSON/);
    const bad = errorsOf(project({
      'sdlc.config.json': { backlogDir: '', suits: [], git: { conflictSuffixStart: 'x' }, agent: { codeSearch: 'grep' }, suites: [{ runner: 'karma' }] },
    }));
    for (const e of ['backlogDir: must be a non-empty string', 'suits: unknown setting', 'git.conflictSuffixStart: must be a whole number',
      'suites[0].runner: must be one of']) expect(bad).toContain(e);
    expect(errorsOf(project({ 'package.json': { scripts: { test: 'jest' } }, 'sdlc.config.json': { agent: { codeSearch: 'grep' } } })))
      .toContain('agent.codeSearch: "grep" is not a code indexer (use auto, none, graft, graphify)');

    expect(errorsOf(project({ 'sdlc.config.json': { suites: [{ dir: 'missing' }] } }))).toContain('suites[0].dir: folder missing does not exist');
    expect(errorsOf(project({ 'x/a.txt': '', 'sdlc.config.json': { suites: [{ dir: 'x' }] } }))).toContain('suites[0]: no test runner found in x; set "runner"');
    expect(errorsOf(project({ 'x/package.json': { scripts: { test: 'jest; mocha' } }, 'sdlc.config.json': { suites: [{ dir: 'x' }] } })))
      .toMatch(/suites\[0\]: x matches (jest and mocha|mocha and jest) equally; set "runner"/);
    expect(errorsOf(project({ 'sdlc.config.json': { suites: [{ runner: 'generic-junit', testCmd: 'make test' }] } }))).toContain('needs "testCmd" and "report"');
    expect(errorsOf(project({ 'package.json': { scripts: { test: 'jest' } }, 'sdlc.config.json': { ui: { timezone: 'Mars/Base' } } })))
      .toContain('ui.timezone: unknown time zone "Mars/Base"');
    expect(errorsOf(project({ 'package.json': { scripts: { test: 'jest' } }, 'sdlc.config.json': { suites: [{ name: 'a' }, { name: 'a' }] } })))
      .toContain('suite name "a" is used twice');
    expect(errorsOf(project({ 'package.json': {} }))).toContain('no test suite found');
  });

  test('tests: retry and maxWorkers, unset by default; validated with the setting at fault; show prints what they come to', async () => {
    const jest = { 'package.json': { scripts: { test: 'jest' } } };
    expect(ok(project(jest)).tests).toEqual({ retry: null, maxWorkers: null });
    expect(ok(project({ ...jest, 'sdlc.config.json': { tests: { retry: false, maxWorkers: 3 } } })).tests).toEqual({ retry: false, maxWorkers: 3 });
    expect(ok(project({ ...jest, 'sdlc.config.json': { tests: { maxWorkers: 'auto' } } })).tests).toEqual({ retry: null, maxWorkers: 'auto' });
    expect(ok(project({ ...jest, 'sdlc.config.json': { tests: { maxWorkers: null } } })).tests.maxWorkers).toBeNull();

    const bad = errorsOf(project({ ...jest, 'sdlc.config.json': { tests: { retry: 'yes', maxWorkers: 0, extra: 1 } } }));
    expect(bad).toContain('tests.retry: must be true or false');
    expect(bad).toContain('tests.maxWorkers: must be a whole number above 0, "auto" or null (got 0)');
    expect(bad).toContain('tests.extra: unknown setting');
    for (const v of [1.5, -2, 'half', '4']) expect(errorsOf(project({ ...jest, 'sdlc.config.json': { tests: { maxWorkers: v } } }))).toContain('tests.maxWorkers: must be');

    expect([workerLimit(null), workerLimit(undefined), workerLimit(6), workerLimit('auto', 10), workerLimit('auto', 3), workerLimit('auto', 1)])
      .toEqual([undefined, undefined, 6, 5, 1, 1]);
    expect(testRunDefaults({ retry: null, maxWorkers: null })).toEqual({ pipeline: { retry: true, maxWorkers: null }, run: { retry: false, maxWorkers: null } });
    expect(testRunDefaults({ retry: false, maxWorkers: 'auto' }, 8)).toEqual({ pipeline: { retry: false, maxWorkers: 4 }, run: { retry: false, maxWorkers: 4 } });
    expect(testRunDefaults({ retry: true, maxWorkers: 2 }).run).toEqual({ retry: true, maxWorkers: 2 });

    const shown = JSON.parse((await cli('show', project({ ...jest, 'sdlc.config.json': { tests: { maxWorkers: 2 } } }))).stdout);
    expect(shown.tests).toEqual({ retry: null, maxWorkers: 2 });
    expect(shown.testRuns).toEqual({ pipeline: { retry: true, maxWorkers: 2 }, run: { retry: false, maxWorkers: 2 } });
  });

  test('test folder: the fixed part in front of the globs, inside the suite folder', async () => {
    expect(testDir({ dir: 'server', testGlobs: ['__tests__/**'] })).toBe('server/__tests__');
    expect(testDir({ dir: '.', testGlobs: ['test/unit/**/*.js', 'test/e2e/*.js'] })).toBe('test');
    expect(testDir({ dir: 'web', testGlobs: ['**/*.test.ts'] })).toBe('web');
    expect(testDir({ dir: '.', testGlobs: ['src/**/*.spec.ts', 'lib/*.spec.ts'] })).toBe('.');
  });
});

describe('command line', () => {
  test('detection finds this repository\'s own vitest suite', async () => {
    expect(detect(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')).map(f => [f.dir, f.runner])).toEqual([['.', 'vitest']]);
  });


  test('detect and show print results; bad settings exit 1 with the reasons; bad usage exits 2', async () => {
    const dir = project({ 'package.json': { scripts: { test: 'vitest' } } });
    expect((await cli('detect', dir)).stdout).toContain('.: vitest · javascript · npm');
    expect(JSON.parse((await cli('detect', dir, '--json')).stdout)[0].runner).toBe('vitest');
    expect(JSON.parse((await cli('show', dir)).stdout).testDirs).toEqual(['.']);

    const tie = await cli('detect', project({ 'package.json': { scripts: { test: 'jest; vitest' } } }));
    expect(tie.status).toBe(1);
    expect(tie.stdout).toContain('ambiguous');

    const bad = await cli('show', project({ 'sdlc.config.json': { nope: 1 } }));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('ERROR: sdlc.config.json: nope: unknown setting');

    expect((await cli('frobnicate')).status).toBe(2);
    expect((await cli('show', '/no/such/dir')).status).toBe(2);
  });
});

describe('suggestions for a project without tests', () => {
  const runners = s => s.suggestions.map(x => x.runner);

  test('ranks by what the project uses: Vite and React, NestJS, ES modules with a Node that runs TypeScript', async () => {
    const vite = suggest(project({ 'package.json': { dependencies: { react: '^18' }, devDependencies: { vite: '^5', typescript: '^5' } }, 'src/a.ts': '' }));
    expect(vite.status).toBe('suggestions');
    expect(runners(vite)).toEqual(['vitest', 'jest', 'mocha', 'node-test']);
    expect(vite.suggestions[0]).toMatchObject({ recommended: true, install: 'npm install -D vitest jsdom' });
    expect(vite.suggestions[0].why).toContain('the project uses Vite: Vitest reuses vite.config');
    expect(vite.suggestions[3].caveats).toContain('no browser DOM for react components');
    expect(vite.suggestions[0].adds).toEqual({ script: 'vitest run', files: ['src/example.test.ts'] });

    expect(runners(suggest(project({ 'package.json': { dependencies: { '@nestjs/core': '^10' }, devDependencies: { typescript: '^5' } } })))[0]).toBe('jest');

    const esm = suggest(project({ 'package.json': { type: 'module', engines: { node: '>=22.18' }, devDependencies: { typescript: '^5' } } }));
    expect(runners(esm).slice(0, 2)).toEqual(['vitest', 'node-test']);
    const nodeTest = esm.suggestions.find(x => x.runner === 'node-test');
    expect(nodeTest).toMatchObject({ install: null, adds: { script: 'node --test "test/**/*.test.ts"' } });
    expect(esm.project).toMatchObject({ language: 'typescript', module: 'esm', node: '22.18 (engines.node)' });

    const old = suggest(project({ 'package.json': { engines: { node: '^20' } }, 'tsconfig.json': '{}', 'pnpm-lock.yaml': '' }));
    expect(old.suggestions.find(x => x.runner === 'node-test')).toMatchObject({ install: 'pnpm add -D tsx', adds: { script: 'tsx --test test/*.test.ts' } });
    expect(old.suggestions.find(x => x.runner === 'node-test').caveats).toContain('Node 20 cannot find .ts test files by pattern: only test/*.test.ts runs, not sub-folders');
    const js = p => setupPlan(suggest(project({ 'package.json': { engines: { node: p } } })).project, 'node-test').script;
    expect(js('>=18')).toBe('node --test test/');
    expect(js('>=22')).toBe('node --test "test/**/*.test.js"');
  });

  test('says why it picked the language, and takes a corrected language', async () => {
    const dir = project({ 'package.json': { devDependencies: { express: '^4' } } });
    const s = suggest(dir);
    expect(s.project).toMatchObject({ language: 'javascript', languageSource: 'detected' });
    expect(s.project.languageEvidence).toEqual(['no tsconfig.json and no typescript dependency']);
    const ts = suggest(dir, dir, { language: 'typescript' });
    expect(ts.project).toMatchObject({ language: 'typescript', languageSource: 'confirmed' });
    expect(ts.suggestions.find(x => x.runner === 'jest').install).toBe('npm install -D jest ts-jest @types/jest');
    expect(suggest(project({ 'package.json': {}, 'tsconfig.json': '{}' })).project.languageEvidence).toEqual(['tsconfig.json']);
  });

  test('does not suggest when tests exist, or for a project that is not Node', async () => {
    expect(suggest(project({ 'package.json': { scripts: { test: 'jest' } } }))).toMatchObject({ status: 'has-tests', existing: [{ dir: '.', runner: 'jest' }] });
    const py = suggest(project({ 'pyproject.toml': '' }));
    expect(py.status).toBe('unsupported');
    expect(py.reason).toContain('pyproject.toml: Python');
    expect(suggest(project({ 'a.txt': '' })).reason).toContain('no package.json here');
    expect(suggest(project({ 'web/package.json': {}, 'api/package.json': {} })).reason)
      .toContain('Packages below: api, web (run it there, or pass --test-dir <folder inside one of them>)');
  });
});

describe('choosing the test folder', () => {
  test('a folder given from the project root belongs to the nearest package at or above it', async () => {
    const dir = project({ 'package.json': {}, 'server/package.json': {}, 'client/package.json': {}, 'client/src/x.ts': '', 'docs/a.md': '' });
    expect(locateTestDir(dir, '__tests__')).toEqual({ pkgDir: dir, testDir: '__tests__' });
    expect(locateTestDir(dir, 'server/__tests__')).toEqual({ pkgDir: path.join(dir, 'server'), testDir: '__tests__' });
    expect(locateTestDir(dir, 'client/_test')).toEqual({ pkgDir: path.join(dir, 'client'), testDir: '_test' });
    expect(locateTestDir(dir, './client/src/unit/')).toEqual({ pkgDir: path.join(dir, 'client'), testDir: 'src/unit' });
    expect(locateTestDir(dir, 'docs/tests')).toEqual({ pkgDir: dir, testDir: 'docs/tests' });
  });

  test('refuses folders outside the project or outside any package, the project itself, files and odd names', async () => {
    const dir = project({ 'server/package.json': {}, 'notes.txt': '', 'server/x.js': '' });
    expect(locateTestDir(dir, '../elsewhere').error).toContain('must be a folder inside');
    expect(locateTestDir(dir, '.').error).toContain('must be a folder inside');
    expect(locateTestDir(dir, 'docs/_test').error).toBe('no package.json in docs or above it; the test folder must be inside a Node package (packages here: server)');
    expect(locateTestDir(dir, '_test').error).toContain('no package.json in the project root');
    expect(locateTestDir(dir, 'server/x.js').error).toBe('server/x.js is a file, not a folder');
    expect(locateTestDir(dir, 'server/my tests').error).toContain('may only use letters, digits and . _ - @ /');
  });

  test('each runner puts the example test in the folder and looks there', async () => {
    const js = suggest(project({ 'package.json': { engines: { node: '>=22' } } })).project;
    const ts = suggest(project({ 'package.json': { engines: { node: '>=18' } }, 'tsconfig.json': '{}' })).project;
    const at = (p, runner, testDir = '__tests__') => setupPlan(p, runner, { testDir });

    const vitest = at(ts, 'vitest', 'client/_test');
    expect(vitest.files.map(f => f.path)).toEqual(['vitest.config.ts', 'client/_test/example.test.ts']);
    expect(vitest.files[0].content).toContain("include: ['client/_test/**/*.{test,spec}.?(c|m)[jt]s?(x)'],");
    expect(setupPlan({ ...ts, vite: true }, 'vitest', { testDir: '_test' }).notes)
      .toEqual(["add test: { include: ['_test/**/*.{test,spec}.?(c|m)[jt]s?(x)'] } to your vite.config so Vitest looks in _test"]);

    const jest = at(js, 'jest');
    expect(jest.files.map(f => f.path)).toEqual(['jest.config.js', '__tests__/example.test.js']);
    expect(jest.files[0].content).toContain("  roots: ['<rootDir>/__tests__'],");

    expect(JSON.parse(at(js, 'mocha', 'spec/unit').files[0].content)).toEqual({ spec: 'spec/unit/**/*.test.js' });
    expect(at(js, 'node-test').script).toBe('node --test "__tests__/**/*.test.js"');
    expect(at(suggest(project({ 'package.json': { engines: { node: '>=18' } } })).project, 'node-test').script).toBe('node --test __tests__/');
    expect(at(ts, 'node-test', '_t').script).toBe('tsx --test _t/*.test.ts');
    expect(setupPlan(js, 'jest').files.map(f => f.path)).toEqual(['jest.config.js', 'test/example.test.js']);
  });

  test('init-tests --test-dir sets up the package that holds the folder; suggest shows the same files', async () => {
    const dir = project({ 'server/package.json': { name: 'server' }, 'client/package.json': { name: 'client' } });
    const plan = await cli('suggest', dir, '--test-dir', 'client/_test', '--json');
    expect(JSON.parse(plan.stdout).suggestions.find(x => x.runner === 'jest').adds.files).toEqual(['jest.config.js', '_test/example.test.js']);

    const r = await cli('init-tests', dir, '--test-dir', 'server/__tests__', '--language', 'javascript', '--runner', 'node-test', '--yes');
    expect(r.stdout).toContain('node-test is set up and the example test passes.');
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'server/__tests__/example.test.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'client/__tests__'))).toBe(false);
    expect(detect(dir).map(f => [f.dir, f.runner])).toEqual([['server', 'node-test']]);

    const bad = await cli('init-tests', dir, '--test-dir', 'docs/_test', '--runner', 'jest', '--yes');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('packages here: client, server');
    expect((await cli('init-tests', dir, '--test-dir')).status).toBe(2);
  });
});

describe('setting up the chosen framework', () => {
  const plain = () => project({ 'package.json': '{\n    "name": "p",\n    "scripts": { "test": "echo \\"Error: no test specified\\" && exit 1" }\n}\n' });

  test('each framework writes its script and files, and detection then finds it', async () => {
    for (const [runner, files] of [['jest', ['jest.config.js', 'test/example.test.js']], ['vitest', ['test/example.test.js']],
      ['node-test', ['test/example.test.js']], ['mocha', ['.mocharc.json', 'test/example.test.js']]] as [string, string[]][]) {
      const dir = plain();
      const r = provision(dir, runner, { install: false });
      expect(r).toMatchObject({ ok: true, written: [...files, 'package.json (scripts.test)'], skipped: [] });
      const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      expect(raw).toMatch(/^\{\n {4}"name"/);
      expect(raw.endsWith('}\n')).toBe(true);
      expect(JSON.parse(raw).scripts.test).toBe(r.plan.script);
      expect(detect(dir).map(f => f.runner)).toEqual([runner]);
    }
  });

  test('Playwright and Cypress folders are left out of the unit test runner', async () => {
    // Vitest's default pattern matches *.spec.ts, so it would run Playwright's specs (and fail) without the exclude.
    const pw = suggest(project({
      'package.json': { devDependencies: { '@playwright/test': '^1', typescript: '^5' } },
      'playwright.config.ts': "export default defineConfig({ testDir: './tests/e2e/', workers: 1 });\n",
    })).project;
    expect(pw.e2eDirs).toEqual(['tests/e2e']);
    const vitest = setupPlan(pw, 'vitest').files.find(f => f.path === 'vitest.config.ts');
    expect(vitest.content).toBe("import { configDefaults, defineConfig } from 'vitest/config';\n\nexport default defineConfig({\n  test: {\n"
      + "    exclude: [...configDefaults.exclude, 'tests/e2e/**'],\n  },\n});\n");
    expect(setupPlan(pw, 'jest').files[0].content).toContain("testPathIgnorePatterns: ['/node_modules/', '/dist/', '/tests/e2e/'],");

    const both = suggest(project({ 'package.json': { dependencies: { react: '^18' }, devDependencies: { '@playwright/test': '^1', cypress: '^13' } } })).project;
    expect(both.e2eDirs).toEqual(['e2e', 'cypress']);
    expect(setupPlan(both, 'vitest').files[0].content).toContain("environment: 'jsdom',\n    exclude: [...configDefaults.exclude, 'e2e/**', 'cypress/**'],");
    const vite = setupPlan({ ...both, vite: true }, 'vitest');
    expect(vite.files.map(f => f.path)).toEqual(['test/example.test.js']);
    expect(vite.notes[1]).toContain("exclude: [...configDefaults.exclude, 'e2e/**', 'cypress/**']");

    const plain = suggest(project({ 'package.json': {} })).project;
    expect(plain.e2eDirs).toEqual([]);
    expect(setupPlan(plain, 'vitest').files.map(f => f.path)).toEqual(['test/example.test.js']);
  });

  test('TypeScript and ES modules get their own setup', async () => {
    const p = suggest(project({ 'package.json': { type: 'module' }, 'tsconfig.json': '{}' })).project;
    const jest = setupPlan(p, 'jest');
    expect(jest.script).toBe('node --experimental-vm-modules node_modules/jest/bin/jest.js');
    expect(jest.files[0].content).toContain("export default {\n  preset: 'ts-jest/presets/default-esm',");
    expect(JSON.parse(setupPlan(p, 'mocha').files[0].content)).toEqual({ spec: 'test/**/*.test.ts', 'node-option': ['import=tsx'] });
    expect(setupPlan(p, 'node-test').files[0].content).toContain("import { describe, it } from 'node:test';");
    expect(setupPlan({ ...p, frontend: ['react'] }, 'vitest').files[0]).toEqual(expect.objectContaining({ path: 'vitest.config.ts' }));
  });

  test('keeps existing files, refuses a real test script, existing tests and unknown frameworks; a dry run writes nothing', async () => {
    const dir = plain();
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'test/example.test.js'), 'mine\n');
    expect(provision(dir, 'vitest', { install: false })).toMatchObject({ ok: true, skipped: ['test/example.test.js'] });
    expect(fs.readFileSync(path.join(dir, 'test/example.test.js'), 'utf8')).toBe('mine\n');

    expect(provision(dir, 'jest', { install: false }).error).toContain('tests are already set up');
    expect(provision(project({ 'package.json': { scripts: { test: 'node run-tests.js' } } }), 'jest', { install: false }).error)
      .toContain('package.json already has a test script ("node run-tests.js")');
    expect(provision(plain(), 'karma', { install: false }).error).toContain('unknown framework "karma"');

    const dry = plain();
    const before = fs.readFileSync(path.join(dry, 'package.json'), 'utf8');
    expect(provision(dry, 'jest', { dryRun: true })).toMatchObject({ ok: true, dryRun: true, written: [] });
    expect(fs.readFileSync(path.join(dry, 'package.json'), 'utf8')).toBe(before);
    expect(fs.readdirSync(dry)).toEqual(['package.json']);
  });

  test('installs first and changes nothing when the install fails; runs the example test after', async () => {
    const dir = plain();
    const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    const calls = [];
    const failing = (cmd, args) => { calls.push(args[1]); return { status: 1, stdout: '', stderr: 'E404' }; };
    const r = provision(dir, 'jest', { run: failing });
    expect(r).toMatchObject({ ok: false, error: 'installing failed: npm install -D jest', written: [] });
    expect(calls).toEqual(['npm install -D jest']);
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['package.json']);

    // node:test needs no packages: the example test really runs
    const real = provision(plain(), 'node-test');
    expect(real.ok).toBe(true);
    expect(real.steps.map(s => [s.cmd, s.status])).toEqual([['npm test', 0]]);
  });

  test('init-tests asks for a framework and the language when it cannot prompt, and applies with --runner, --language and --yes', async () => {
    const dir = plain();
    const list = await cli('init-tests', dir);
    expect(list.status).toBe(2);
    expect(list.stdout).toContain('Detected language: JavaScript (no tsconfig.json and no typescript dependency)');
    expect(list.stdout).not.toContain('1. jest');
    expect(list.stderr).toContain('confirm the language with --language javascript|typescript');

    const pick = await cli('init-tests', dir, '--language', 'javascript');
    expect(pick.status).toBe(2);
    expect(pick.stderr).toContain('pick one with --runner <name>');
    expect(pick.stdout).toContain('Supported test frameworks for JavaScript, best first:\n\n1. jest (recommended)');

    const noYes = await cli('init-tests', dir, '--language', 'javascript', '--runner', 'node-test');
    expect(noYes.status).toBe(2);
    expect(noYes.stderr).toContain('confirm with --yes');

    const dry = await cli('init-tests', dir, '--language', 'typescript', '--runner', 'node-test', '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('test/example.test.ts');
    expect(dry.stdout).toContain('Dry run: nothing was changed.');
    expect(fs.readdirSync(dir)).toEqual(['package.json']);

    const done = await cli('init-tests', dir, '--language', 'javascript', '--runner', 'node-test', '--yes');
    expect(done.stdout).toContain('node-test is set up and the example test passes.');
    expect(done.status).toBe(0);
    expect((await cli('init-tests', dir, '--language', 'javascript', '--runner', 'jest', '--yes')).stderr).toContain('tests are already set up');
    expect((await cli('init-tests', dir, '--language', 'cobol')).status).toBe(2);
  });
});
