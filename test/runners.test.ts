import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { main } from '../src/cli/main.js';
import { parseJestLike } from '../src/runners/jest.js';
import { parseJUnit } from '../src/runners/junit.js';
import { mochaConfigWithoutSpec, mochaCrashFile, parseMocha } from '../src/runners/mocha.js';
import { parseNodeTest } from '../src/runners/nodeTest.js';
import { suiteFiles } from '../src/runners/files.js';
import { runSuite, runSuites } from '../src/runners/run.js';
import type { RunParts, RunSuite, Spawn } from '../src/runners/types.js';
import { resolve } from '../src/config/settings.js';
import { testsPass } from '../src/pipeline/gates.js';
import type { Ctx } from '../src/pipeline/context.js';
import { project } from './helpers.js';

// Real output of each runner for test/math.test.js (pass, fail, nested, skipped) and test/broken.test.js (throws on
// load), recorded from a project at /project (assets/runners/node-test-reporter.mjs for node:test, Node 18 and 22).
const FIX = fileURLToPath(new URL('./fixtures/runners', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const fixture = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const keys = (parts: RunParts) => parts.tests.map(t => `${t.status} ${t.file} :: ${t.name}`).sort();
const MATH = [
  'failed test/math.test.js :: math fails', 'passed test/math.test.js :: math adds', 'passed test/math.test.js :: math inner deep',
  'passed test/math.test.js :: top level', 'skipped test/math.test.js :: math skipped one',
];

async function cli(args: string[], cwd?: string) {
  let stdout = '';
  let stderr = '';
  await new Promise(r => setImmediate(r)); // lets the test worker answer its runner between the synchronous runs
  const status = await main(args, { out: t => { stdout += `${t}\n`; }, err: t => { stderr += `${t}\n`; }, cwd });
  return { status, stdout, stderr };
}

describe("parsing each runner's report", () => {
  test('jest, vitest and mocha report the same tests, statuses and broken file', () => {
    const jest = parseJestLike(JSON.parse(fixture('jest.json')), { root: '/project' });
    const vitest = parseJestLike(JSON.parse(fixture('vitest.json')), { root: '/project' });
    const mocha = parseMocha(JSON.parse(fixture('mocha.json')), { root: '/project' });
    for (const parts of [jest, vitest, mocha]) expect(keys(parts)).toEqual(MATH);
    expect(jest.suiteErrors).toEqual([expect.objectContaining({ file: 'test/broken.test.js' })]);
    expect(vitest.suiteErrors[0]).toEqual({ file: 'test/broken.test.js', message: expect.stringContaining('boom at load') });
    expect(jest.tests.find(t => t.status === 'failed')!.message).toContain('assert.strictEqual');
    expect(mocha.tests.find(t => t.status === 'failed')!.message).toMatch(/1 !== 2|Expected values to be strictly equal/);
    expect(mochaCrashFile(fixture('mocha-broken.err'), '/project')).toBe('test/broken.test.js');
    expect(mochaCrashFile('Error at node:internal/x.js:1:2\n at (/elsewhere/node_modules/a/b.js:3:4)', '/project')).toBeNull();
  });

  test('node:test on Node 18 and 22: full names from nesting, containers left out, skip and todo, a file that fails to load', () => {
    for (const v of ['18', '22']) {
      const parts = parseNodeTest(fixture(`node-test-${v}.jsonl`), { root: '/project' });
      expect(keys(parts)).toEqual([...MATH.slice(0, 3), 'passed test/math.test.js :: parent child ok', MATH[3],
        'skipped test/math.test.js :: math later', MATH[4]].sort());
      expect(parts.suiteErrors.map(e => e.file)).toEqual(['test/broken.test.js']);
    }
  });

  test('node:test on Node 18 names ES module files by file: URL; they come out as paths', () => {
    const lines = [
      { event: 'start', name: 'esm ok', nesting: 0, file: 'file:///project/src/a.test.mjs' },
      { event: 'pass', name: 'esm ok', nesting: 0, file: 'file:///project/src/a.test.mjs' },
      { event: 'fail', name: 'file:///project/src/b.test.mjs', nesting: 0, file: 'file:///project/src/b.test.mjs', failureType: 'testCodeFailure', message: 'boom' },
    ].map(l => JSON.stringify(l)).join('\n');
    const parts = parseNodeTest(lines, { root: '/project' });
    expect(parts.tests).toEqual([{ file: 'src/a.test.mjs', name: 'esm ok', status: 'passed', message: null }]);
    expect(parts.suiteErrors).toEqual([{ file: 'src/b.test.mjs', message: 'boom' }]);
  });

  test('JUnit XML: nested suites, classnames, file attributes, failures, errors, skips and entities', () => {
    const xml = `<?xml version="1.0"?><testsuites>
      <testsuite name="test/a.test.js" file="test/a.test.js">
        <testsuite name="math">
          <testcase name="adds" classname="test"/>
          <testcase name="fails &amp; &lt;stops&gt;" classname="test"><failure message="1 &quot;!=&quot; 2">trace</failure></testcase>
          <testcase name="later"><skipped/></testcase>
        </testsuite>
      </testsuite>
      <testsuite name="jest tests"><testcase classname="api returns 404" name="returns 404" file="src/api.test.ts"><error message="boom"/></testcase></testsuite>
    </testsuites>`;
    expect(parseJUnit(xml, { root: '/project' }).tests).toEqual([
      { file: 'test/a.test.js', name: 'math adds', status: 'passed', message: null },
      { file: 'test/a.test.js', name: 'math fails & <stops>', status: 'failed', message: '1 "!=" 2' },
      { file: 'test/a.test.js', name: 'math later', status: 'skipped', message: null },
      { file: 'src/api.test.ts', name: 'api returns 404', status: 'failed', message: 'boom' },
    ]);
  });
});

describe('test files and settings', () => {
  test("a suite's test files by its globs, without node_modules and dot folders", () => {
    const dir = project({ 'pkg/test/a.test.js': '', 'pkg/test/sub/b.test.js': '', 'pkg/test/helper.js': '', 'pkg/node_modules/x/test/c.test.js': '', 'pkg/.cache/test/d.test.js': '' });
    expect(suiteFiles(dir, { dir: 'pkg', testGlobs: ['test/**/*.test.js'] })).toEqual(['pkg/test/a.test.js', 'pkg/test/sub/b.test.js']);
  });

  test('mocha settings without spec, from .mocharc.json (with comments), .yml, .cjs and package.json', () => {
    expect(mochaConfigWithoutSpec(project({ '.mocharc.json': '{ // c\n "spec": "test/**", /* x */ "timeout": 5000, "require": ["./setup.js"] }\n' })))
      .toEqual({ timeout: 5000, require: ['./setup.js'] });
    expect(mochaConfigWithoutSpec(project({ '.mocharc.yml': "spec: 'test/**'\nrecursive: true\nnode-option:\n  - import=tsx\n" })))
      .toEqual({ recursive: true, 'node-option': ['import=tsx'] });
    expect(mochaConfigWithoutSpec(project({ '.mocharc.cjs': "module.exports = { spec: ['a'], ui: 'tdd' };\n", 'package.json': { mocha: { ui: 'bdd', timeout: 9 } } })))
      .toEqual({ ui: 'tdd', timeout: 9 });
    expect(mochaConfigWithoutSpec(project({}))).toEqual({});
  });
});

const suite = (runner: string, extra: Partial<RunSuite> = {}): RunSuite =>
  ({ name: 's', dir: '.', runner, packageManager: 'npm', testGlobs: ['test/**/*.test.js'], testCmd: '', ...extra });

// A stand-in for the process: records each command and writes the report <reportFor> gives for it.
type Reply = { report?: string; stderr?: string; status?: number };
const fakeRunner = (reportFor: (command: string) => Reply, calls: { command: string; cwd: string }[]): Spawn => ((_sh: string, args: string[], opts: any) => {
  const command = args[1];
  calls.push({ command, cwd: opts.cwd });
  const out = (command.match(/(?:--outputFile=|output=)'([^']+)'/) || [])[1];
  const { report, stderr = '', status = 1 } = reportFor(command);
  if (report && out) fs.writeFileSync(out, report);
  return { status, stdout: '', stderr };
}) as unknown as Spawn;

describe('running', () => {
  const nodeTestFiles = {
    'test/math.test.js': "const { describe, it } = require('node:test');\nconst assert = require('node:assert');\n"
      + "describe('math', () => {\n  it('adds', () => assert.strictEqual(1 + 1, 2));\n  it('fails', () => assert.strictEqual(1, 2));\n});\n",
    'test/broken.test.js': "throw new Error('boom at load');\n",
  };

  test("node:test: the project's own command with the reporter added; a narrowed run re-runs the file", () => {
    const dir = project(nodeTestFiles);
    const all = runSuite(suite('node-test', { testCmd: 'node --test test/math.test.js test/broken.test.js' }), { root: dir });
    expect(all).toMatchObject({ runner: 'node-test', ok: false, exitCode: 1, command: 'node --test test/math.test.js test/broken.test.js' });
    expect(keys(all)).toEqual(['failed test/math.test.js :: math fails', 'passed test/math.test.js :: math adds']);
    expect(all.suiteErrors.map(e => e.file)).toEqual(['test/broken.test.js']);

    const one = runSuite(suite('node-test', { testCmd: 'unused' }), { root: dir, files: ['test/math.test.js'], names: ['math adds'] });
    expect(one.command).toBe("node --test 'test/math.test.js'");
    expect(keys(one)).toEqual(keys(all));
    expect(one.suiteErrors).toEqual([]);
  });

  test("the suite's runCmd (the project's Node) runs the whole suite, and built commands switch Node the same way", () => {
    const dir = project(nodeTestFiles);
    const calls: { command: string; cwd: string }[] = [];
    const spawn = fakeRunner(() => ({ status: 0 }), calls);
    runSuite(suite('node-test', { testCmd: 'npm test', runCmd: 'fnm exec --using=16 -- npm test' }), { root: dir, spawn });
    runSuite(suite('node-test', { testCmd: 'npm test' }), { root: dir, files: ['test/math.test.js'], spawn, node: { switchTo: '16', manager: 'fnm' } });
    runSuite(suite('jest'), { root: dir, files: ['test/math.test.js'], spawn, node: { switchTo: '16', manager: 'fnm' } });
    expect(calls.map(c => c.command)).toEqual([
      'fnm exec --using=16 -- npm test',
      "fnm exec --using=16 -- sh -c 'node --test '\\''test/math.test.js'\\'''",
      expect.stringMatching(/^fnm exec --using=16 -- sh -c 'npx jest --json/),
    ]);
  });

  test('jest: whole suite, one file and one test by full name, also from a suite folder below the root, and a worker limit', () => {
    const dir = project({ 'server/__tests__/a.test.js': '', 'server/__tests__/b.test.js': '' });
    const calls: { command: string; cwd: string }[] = [];
    const report = (files: string[], tests: [string, string, string][]) => JSON.stringify({ testResults: files.map(f => ({
      name: path.join(dir, f), status: 'passed',
      assertionResults: tests.filter(t => t[0] === f).map(([, fullName, status]) => ({ fullName, status, failureMessages: status === 'failed' ? ['nope'] : [] })),
    })) });
    const A = 'server/__tests__/a.test.js';
    const B = 'server/__tests__/b.test.js';
    const spawn = fakeRunner(command => (command.includes(' -t ')
      ? { status: 0, report: report([A], [[A, 'a works', 'passed'], [A, 'a breaks', 'skipped']]) }
      : { status: 1, report: report([A, B], [[A, 'a works', 'passed'], [A, 'a breaks', 'failed'], [B, 'b ok', 'passed']]) }), calls);
    const s = suite('jest', { dir: 'server', testGlobs: ['__tests__/**'] });
    const all = runSuite(s, { root: dir, spawn, maxWorkers: 2 });
    expect(all.ok).toBe(false);
    expect(keys(all)).toEqual([`failed ${A} :: a breaks`, `passed ${A} :: a works`, `passed ${B} :: b ok`]);
    expect(calls[0]).toEqual({ command: expect.stringMatching(/^npx jest --json --outputFile='[^']+' --maxWorkers=2$/), cwd: fs.realpathSync(path.join(dir, 'server')) });
    const one = runSuite(s, { root: dir, files: [A], names: ['a works'], spawn });
    expect(one.command).toContain("'__tests__/a.test.js' -t '^(?:a works)$'");
    expect(one).toMatchObject({ ok: true, exitCode: 0 });
    expect(keys(one)).toEqual([`passed ${A} :: a works`, `skipped ${A} :: a breaks`]);
  });

  test('generic JUnit: runs the command and reads its report; no report is an error with the output', () => {
    const xml = '<testsuites><testsuite name="suite" file="t/x.test.sh"><testcase name="one"/><testcase name="two"><failure message="no"/></testcase></testsuite></testsuites>';
    const dir = project({ 'make-report.sh': `mkdir -p out && printf '%s' '${xml}' > out/junit.xml && exit 1\n` });
    const r = runSuite(suite('generic-junit', { testCmd: 'sh make-report.sh', report: 'out/junit.xml' }), { root: dir });
    expect(r).toMatchObject({ ok: false, exitCode: 1 });
    expect(keys(r)).toEqual(['failed t/x.test.sh :: suite two', 'passed t/x.test.sh :: suite one']);

    const none = runSuite(suite('generic-junit', { testCmd: 'echo cannot start >&2; exit 127', report: 'out/missing.xml' }), { root: dir });
    expect(none).toMatchObject({ ok: false, exitCode: 127, noReport: true, tests: [] });
    expect(none.suiteErrors[0]).toEqual({ file: null, message: 'cannot start' });
  });

  test("a run that exits non-zero with every test passed reports the runner's output as a suite error", () => {
    const xml = '<testsuites><testsuite name="suite" file="t/x.test.sh"><testcase name="one"/></testsuite></testsuites>';
    const dir = project({ 'make-report.sh': `mkdir -p out && printf '%s' '${xml}' > out/junit.xml && echo coverage threshold not met >&2 && exit 1\n` });
    const r = runSuite(suite('generic-junit', { testCmd: 'sh make-report.sh', report: 'out/junit.xml' }), { root: dir });
    expect(r).toMatchObject({ ok: false, exitCode: 1 });
    expect(keys(r)).toEqual(['passed t/x.test.sh :: suite one']);
    expect(r.suiteErrors).toHaveLength(1);
    expect(r.suiteErrors[0].file).toBeNull();
    expect(r.suiteErrors[0].message).toContain('coverage threshold not met');
  });

  test('vitest: the command it builds and the report it reads', () => {
    const calls: { command: string; cwd: string }[] = [];
    const r = runSuite(suite('vitest', { packageManager: 'pnpm' }), {
      root: '/project', files: ['test/math.test.js'], names: ['math adds', 'a|b'], maxWorkers: 1,
      spawn: fakeRunner(() => ({ report: fixture('vitest.json') }), calls),
    });
    expect(calls[0].command).toMatch(/^pnpm exec vitest run --reporter=json --outputFile='[^']+' --maxWorkers=1 'test\/math.test.js' -t '\^\(\?:math adds\|a\\\|b\)\$'$/);
    expect(keys(r)).toEqual(MATH);
    expect(r.suiteErrors).toEqual([]);
  });

  test('a Vitest RPC timeout is put on the file that ran over 60s', () => {
    const file = (name: string, ms: number) => ({ name: `/project/${name}`, status: 'passed', startTime: 1000, endTime: 1000 + ms, assertionResults: [{ fullName: 'ok', title: 'ok', ancestorTitles: [], status: 'passed' }] });
    const report = JSON.stringify({ testResults: [file('test/slow.test.js', 70000), file('test/fast.test.js', 1000)] });
    const text = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"';
    const go = (stderr: string) => runSuite(suite('vitest'), { root: '/project', spawn: fakeRunner(() => ({ report, stderr }), []) });
    const r = go(text);
    expect(r.suiteErrors).toHaveLength(1);
    expect(r.suiteErrors[0].file).toBe('test/slow.test.js');
    expect(r.suiteErrors[0].message).toContain(text);
    expect(go('some other failure').suiteErrors.map(e => e.file)).toEqual([null]);
  });

  test('vitest for real: one file of a project, through its own vitest', () => {
    const dir = project({
      'package.json': { name: 'p', type: 'module', scripts: { test: 'vitest run' } },
      'test/a.test.js': "import { test, expect } from 'vitest';\ntest('one', () => expect(1).toBe(1));\ntest('two', () => expect(1).toBe(2));\n",
      'test/b.test.js': "import { test } from 'vitest';\ntest('other', () => {});\n",
    });
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    const r = runSuite(suite('vitest'), { root: dir, files: ['test/a.test.js'] });
    expect(keys(r)).toEqual(['failed test/a.test.js :: two', 'passed test/a.test.js :: one']);
    expect(r.ok).toBe(false);
  });

  test('mocha: one file that fails to load stops mocha, so the files run one by one with a spec-less config', () => {
    const dir = project({ 'test/math.test.js': '', 'test/broken.test.js': '', '.mocharc.json': { spec: 'test/**/*.test.js', timeout: 100 } });
    const real = fs.realpathSync(dir);
    const calls: { command: string; cwd: string }[] = [];
    const crash = fixture('mocha-broken.err').replace(/\/project/g, real);
    const r = runSuite(suite('mocha'), { root: dir, spawn: fakeRunner(command => {
      if (command.includes("'test/broken.test.js'") || !command.includes('--config')) return { stderr: crash };
      return { report: fixture('mocha.json').replace(/\/project/g, real) };
    }, calls) });
    expect(calls.map(c => c.command.replace(/'[^']*sdlc-run-[^']*'/g, 'TMP'))).toEqual([
      'npx mocha --reporter json --reporter-option output=TMP',
      "npx mocha --reporter json --reporter-option output=TMP --config TMP --no-package 'test/broken.test.js'",
      "npx mocha --reporter json --reporter-option output=TMP --config TMP --no-package 'test/math.test.js'",
    ]);
    expect(keys(r)).toEqual(MATH);
    expect(r.suiteErrors.map(e => e.file)).toEqual(['test/broken.test.js']);
    expect(r.command).toContain('then file by file: test/broken.test.js failed to load');
  });
});

describe('flaky-suite guard', () => {
  // A test that fails on its first run in a folder and passes after (a marker file remembers the run).
  const flakyFiles = {
    'test/flaky.test.js': "const { test } = require('node:test');\nconst fs = require('node:fs');\nconst path = require('node:path');\n"
      + "const mark = path.join(__dirname, '..', 'ran');\n"
      + "test('sometimes', () => { const first = !fs.existsSync(mark); fs.writeFileSync(mark, ''); if (first) throw new Error('load'); });\n",
    'test/steady.test.js': "const { test } = require('node:test');\ntest('always', () => {});\n",
    'test/bad.test.js': "const { test } = require('node:test');\ntest('never', () => { throw new Error('real'); });\n",
  };
  const s = suite('node-test', { testCmd: 'node --test test/flaky.test.js test/steady.test.js' });

  test('without retry a flaky failure is reported; with retry only the failed file runs again and the test is listed as flaky', () => {
    expect(runSuite(s, { root: project(flakyFiles) }).ok).toBe(false);
    const r = runSuite(s, { root: project(flakyFiles), retry: true });
    expect(r).toMatchObject({ ok: true, exitCode: 0, retried: { files: ['test/flaky.test.js'], flaky: [{ file: 'test/flaky.test.js', name: 'sometimes' }] } });
    expect(r.command).toBe("node --test test/flaky.test.js test/steady.test.js ; retry: node --test 'test/flaky.test.js'");
    expect(keys(r)).toEqual(['passed test/flaky.test.js :: sometimes', 'passed test/steady.test.js :: always']);
  });

  test('a suite error that clears on re-run is reported as flaky, not dropped', () => {
    const files = {
      'test/late.test.js': "const { test } = require('node:test');\nconst fs = require('node:fs');\nconst path = require('node:path');\n"
        + "const mark = path.join(__dirname, '..', 'loaded');\nconst first = !fs.existsSync(mark);\nfs.writeFileSync(mark, '');\nif (first) throw new Error('load');\ntest('fine', () => {});\n",
      'test/steady.test.js': flakyFiles['test/steady.test.js'],
    };
    const r = runSuite(suite('node-test', { testCmd: 'node --test test/late.test.js test/steady.test.js' }), { root: project(files), retry: true });
    expect(r.ok).toBe(true);
    expect(r.retried?.flaky).toEqual([{ file: 'test/late.test.js', name: '<suite failed to run>' }]);
  });

  test('a real failure still fails after the retry', () => {
    const r = runSuite(suite('node-test', { testCmd: 'node --test test/bad.test.js test/steady.test.js' }), { root: project(flakyFiles), retry: true });
    expect(r).toMatchObject({ ok: false, retried: { files: ['test/bad.test.js'], flaky: [] } });
    expect(keys(r)).toEqual(['failed test/bad.test.js :: never', 'passed test/steady.test.js :: always']);
  });
});

describe('command line', () => {
  test('run writes the result and exits 0, 1 or 3; parse-report converts a report', async () => {
    const dir = project({
      'package.json': { scripts: { test: 'node --test test/a.test.js' } },
      'test/a.test.js': "const { test } = require('node:test');\ntest('ok', () => {});\n",
    });
    const out = path.join(dir, 'r.json');
    const ok = await cli(['run', dir, '--out', out]);
    expect(ok.stdout).toBe(`${path.basename(dir)} (node-test): 1 passed, 0 failed, 0 skipped, 0 file errors\n`);
    expect(ok.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ ok: true, tests: [{ file: 'test/a.test.js', name: 'ok', status: 'passed' }] });

    fs.writeFileSync(path.join(dir, 'test/a.test.js'), "const { test } = require('node:test');\ntest('ok', () => { throw new Error('x is wrong'); });\n");
    const failed = await cli(['run', dir]);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain('FAIL  test/a.test.js :: ok\n      x is wrong');
    const json = await cli(['run', dir, '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, tests: [{ status: 'failed' }] });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test test/a.test.js; exit 0' } }));
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), JSON.stringify({ suites: [{ runner: 'generic-junit', testCmd: 'true', report: 'none.xml' }] }));
    expect((await cli(['run', dir, '--out', out])).status).toBe(3);

    const parsed = await cli(['parse-report', 'vitest', path.join(FIX, 'vitest.json'), '--root', '/project']);
    expect(keys(JSON.parse(parsed.stdout))).toEqual(MATH);
    expect((await cli(['parse-report', 'karma', 'x'])).status).toBe(2);
    expect((await cli(['run', dir, '--max-workers', '0'])).status).toBe(2);
  });

  test('every suite runs and the results merge; --file runs only the suites holding the files, also given as absolute paths', async () => {
    const t = (name: string) => `const { test } = require('node:test');\ntest('${name}', () => {});\n`;
    const dir = project({
      'sdlc.config.json': { suites: [
        { name: 'a', dir: 'a', runner: 'node-test', testCmd: 'node --test a/x.test.js', testGlobs: ['**/*.test.js'] },
        { name: 'b', dir: 'b', runner: 'node-test', testCmd: 'node --test b/y.test.js', testGlobs: ['**/*.test.js'] },
      ], agent: { codeSearch: 'none' }, ui: { timezone: 'UTC' } },
      'a/x.test.js': t('in a'), 'b/y.test.js': t('in b'),
    });
    const out = path.join(dir, 'r.json');
    const all = await cli(['run', dir, '--out', out]);
    expect(all.stdout).toBe('a (node-test): 1 passed, 0 failed, 0 skipped, 0 file errors\nb (node-test): 1 passed, 0 failed, 0 skipped, 0 file errors\n');
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({ suite: 'a+b', ok: true, tests: [{ file: 'a/x.test.js' }, { file: 'b/y.test.js' }] });
    expect((await cli(['run', dir, '--out', out, '--file', 'b/y.test.js'])).stdout).toBe('b (node-test): 1 passed, 0 failed, 0 skipped, 0 file errors\n');
    expect((await cli(['run', '--file', path.join(dir, 'a/x.test.js'), '--file', './b/y.test.js'], dir)).stdout).toMatch(/^a \(node-test\): 1 passed.*\nb \(node-test\): 1 passed/);
    const none = await cli(['run', dir, '--file', 'c/z.test.js']);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('ERROR: no suite holds c/z.test.js (suites: a in a, b in b)');
    expect(runSuites({ suites: [] }, { root: dir, suite: 'x' })).toEqual({ error: 'no suite "x" (suites: )' });
  });

  test('a command and an option arriving as one argument, and an unknown option, are usage errors', async () => {
    const one = await cli(['run --out x']);
    expect(one.status).toBe(2);
    expect(one.stderr).toContain('"run --out x" arrived as one argument');
    expect((await cli(['run', '--outt', 'x'])).stderr).toContain('unknown option "--outt"');
  });
});

/**
 * A jest project whose `jest` is a stand-in: it records its arguments (args.txt) and writes a report with one test,
 * which fails once when the file fail-once exists.
 */
function fakeJest(settings?: object): string {
  const dir = project({
    'package.json': { scripts: { test: 'jest' }, devDependencies: { jest: '^29' } },
    ...(settings ? { 'sdlc.config.json': { agent: { codeSearch: 'none' }, ui: { timezone: 'UTC' }, ...settings } } : {}),
    'test/a.test.js': '',
  });
  const bin = path.join(dir, 'node_modules/.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'jest'), `#!/bin/sh
dir="$(cd "$(dirname "$0")/../.." && pwd)"
echo "$*" >> "$dir/args.txt"
for a in "$@"; do case "$a" in --outputFile=*) out="\${a#--outputFile=}" ;; esac; done
st=passed; rc=0
if [ -e "$dir/fail-once" ]; then rm "$dir/fail-once"; st=failed; rc=1; fi
printf '{"testResults":[{"name":"%s/test/a.test.js","assertionResults":[{"title":"ok","status":"%s","failureMessages":["boom"]}]}]}' "$dir" "$st" > "$out"
exit $rc
`, { mode: 0o755 });
  return fs.realpathSync(dir);
}
const workerArgs = (dir: string) => fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trim().split('\n').map(l => (l.match(/--maxWorkers=(\d+)/) || [])[1] || '-');
const failOnce = (dir: string) => fs.writeFileSync(path.join(dir, 'fail-once'), '');

describe('tests.retry and tests.maxWorkers', () => {
  test('run: the settings are the defaults, --retry, --no-retry and --max-workers <n|auto> override them', async () => {
    const plain = fakeJest();
    failOnce(plain);
    expect((await cli(['run', plain])).status).toBe(1);
    failOnce(plain);
    const retried = await cli(['run', plain, '--retry']);
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain('FLAKY test/a.test.js :: ok');
    expect(workerArgs(plain)).toEqual(['-', '-', '-']);

    const set = fakeJest({ tests: { retry: true, maxWorkers: 3 } });
    failOnce(set);
    expect((await cli(['run', set])).status).toBe(0);
    failOnce(set);
    expect((await cli(['run', set, '--no-retry', '--max-workers', '1'])).status).toBe(1);
    await cli(['run', set, '--max-workers', 'auto']);
    expect(workerArgs(set)).toEqual(['3', '3', '1', String(Math.max(1, Math.floor(os.availableParallelism() / 2)))]);

    expect((await cli(['run', set, '--retry', '--no-retry'])).stderr).toContain('use --retry or --no-retry, not both');
    expect((await cli(['run', set, '--max-workers', 'half'])).status).toBe(2);
  });

  test('the pipeline gate retries unless tests.retry is false, and passes tests.maxWorkers to every run', () => {
    const gate = (dir: string) => {
      const { config } = resolve(dir, { env: process.env });
      const lines: string[] = [];
      fs.mkdirSync(path.join(dir, 'logs'));
      const ctx = { root: dir, log: 'logs', config, env: process.env, out: (l: string) => { lines.push(l); } } as unknown as Ctx;
      return { ok: testsPass(ctx), lines };
    };
    const limited = fakeJest({ tests: { maxWorkers: 2 } });
    failOnce(limited);
    const r = gate(limited);
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(['WARNING: flaky test failed, then passed on retry; not counted as a failure: test/a.test.js :: ok']);
    expect(workerArgs(limited)).toEqual(['2', '2']);

    const noRetry = fakeJest({ tests: { retry: false } });
    failOnce(noRetry);
    expect(gate(noRetry).ok).toBe(false);
    expect(workerArgs(noRetry)).toEqual(['-']);
  });
});
