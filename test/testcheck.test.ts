import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { main } from '../src/cli/main.js';
import { Keys } from '../src/testcheck/keys.js';
import { project, tmp as tmpDir, write } from './helpers.js';

const SERVER = { SDLC_TEST_DIRS: 'server/__tests__', SDLC_KEY_DIR: 'server' };
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

/** The testcheck command in-process, in <cwd>, with the test layout in <env> and <input> as stdin. */
async function tc(cwd: string, args: string[], { env = SERVER as NodeJS.ProcessEnv, input }: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  let stdout = '';
  let stderr = '';
  const io = { out: (t: string) => { stdout += `${t}\n`; }, err: (t: string) => { stderr += `${t}\n`; }, cwd, env: { ...process.env, ...env }, stdin: () => input ?? '' };
  await new Promise(r => setImmediate(r)); // lets the test worker answer its runner between the synchronous runs
  const status = await main(['testcheck', ...args], io);
  return { status, stdout, stderr };
}
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let tmp: string;
// A new, empty folder. Every test starts with one; a test that checks several cases calls it between them.
const fresh = () => { tmp = tmpDir('tc-'); };
beforeEach(fresh);
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const p = (n: string) => path.join(tmp, n);
const FA = () => p('server/__tests__/a.test.js');
const FB = () => p('server/__tests__/b.test.js');
const KA = '__tests__/a.test.js';
const KB = '__tests__/b.test.js';
const writeJson = (n: string, o: unknown) => { fs.writeFileSync(p(n), JSON.stringify(o)); return n; };
const file = (name: string, assertions: [string, string][]) => ({
  name, status: assertions.some(a => a[1] === 'failed') ? 'failed' : 'passed',
  assertionResults: assertions.map(([fullName, status]) => ({ fullName, status })),
});
const suiteFail = (name: string) => ({ name, status: 'failed', assertionResults: [] });
const jestJson = (files: unknown[]) => ({ testResults: files });
const claimsFile = (lines: string[]) => { fs.writeFileSync(p('test-issues.md'), lines.join('\n') + '\n'); return 'test-issues.md'; };
const run = (...args: string[]) => tc(tmp, args);
const readNow = () => JSON.parse(fs.readFileSync(p('now.json'), 'utf8'));
const NOT_CLAIMED = 'failing test is NOT claimed as a test defect (source bug, not test repair)';

describe('testcheck unclaimed', () => {
  test('prints the failing keys that are not claimed, a failed suite by its suite key, and nothing when all pass or are claimed', async () => {
    let now = writeJson('now.json', jestJson([file(FA(), [['one', 'failed'], ['two', 'failed'], ['ok', 'passed']]), file(FB(), [['three', 'failed']])]));
    let r = await run('unclaimed', now, claimsFile(['server/__tests__/a.test.js :: two :: spec says so']));
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean).sort()).toEqual([`${KA}::one`, `${KB}::three`]);

    fresh();
    now = writeJson('now.json', jestJson([file(FA(), [['one', 'failed'], ['ok', 'passed']])]));
    r = await run('unclaimed', now, claimsFile(['server/__tests__/a.test.js :: one :: spec']));
    expect(r).toMatchObject({ status: 0, stdout: '' });
    // a missing claim file means nothing is claimed
    expect((await run('unclaimed', now, 'absent.md')).stdout.trim()).toBe(`${KA}::one`);

    fresh();
    now = writeJson('now.json', jestJson([file(FA(), [['ok', 'passed']])]));
    expect(await run('unclaimed', now, 'absent.md')).toMatchObject({ status: 0, stdout: '' });

    fresh();
    now = writeJson('now.json', jestJson([suiteFail(FA())]));
    expect((await run('unclaimed', now, 'absent.md')).stdout.trim()).toBe(`${KA}::<suite failed to run>`);
  });

  test('missing arguments and an unknown check give usage and exit 2; an unreadable result file is an error', async () => {
    for (const cmd of ['unclaimed', 'merge-retry', 'resumecheck']) {
      const r = await run(cmd);
      expect([cmd, r.status]).toEqual([cmd, 2]);
      expect(r.stderr).toMatch(/usage/i);
    }
    const nope = await run('nope');
    expect(nope.status).toBe(2);
    expect(nope.stderr).toContain('resumecheck');
    expect(await run('namecheck', 'missing.json', 'missing.json')).toMatchObject({ status: 1, stderr: expect.stringContaining('ERROR:') });
  });

  test('without SDLC_TEST_DIRS the layout comes from the settings; without settings it is an error', async () => {
    write(tmp, 'server/package.json', { name: 'server' });
    write(tmp, 'sdlc.config.json', { suites: [{ dir: 'server', runner: 'jest', testCmd: 'npx jest', testGlobs: ['__tests__/**'] }], agent: { codeSearch: 'none' }, ui: { timezone: 'UTC' } });
    const now = writeJson('now.json', jestJson([file(FA(), [['one', 'failed']])]));
    expect((await tc(tmp, ['unclaimed', now, 'absent.md'], { env: { SDLC_TEST_DIRS: '' } })).stdout).toBe(`${KA}::one\n`);
    const none = await tc(project({ 'x.txt': '' }), ['claimed', 'a.md'], { env: { SDLC_TEST_DIRS: '' } });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('no test layout');
  });
});

describe('testcheck merge-retry', () => {
  const FLAKY = (key: string) => `${key} :: first run: failed :: re-run: passed`;
  const WARNING = (key: string) => `WARNING: flaky test passed on re-run, not rejected: ${key}`;
  const flaky = 'flaky-tests.md';

  test('a key that passed on re-run is marked passed, with a WARNING and a line appended to flaky-tests.md; the rest of now.json is unchanged', async () => {
    fs.writeFileSync(p(flaky), 'earlier line\n');
    const before: any = jestJson([file(FA(), [['flaky', 'failed'], ['keep pass', 'passed'], ['keep fail', 'failed']]), file(FB(), [['b ok', 'passed']])]);
    before.numTotalTests = 4;
    const now = writeJson('now.json', before);
    const re = writeJson('retry-1.json', jestJson([file(FA(), [['flaky', 'passed']])]));
    const r = await run('merge-retry', now, claimsFile([]), flaky, re);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(WARNING(`${KA}::flaky`));
    expect(fs.readFileSync(p(flaky), 'utf8').split('\n').filter(Boolean)).toEqual(['earlier line', FLAKY(`${KA}::flaky`)]);
    const expected = JSON.parse(JSON.stringify(before));
    expected.testResults[0].assertionResults[0].status = 'passed';
    expect(readNow()).toEqual(expected);
  });

  test('several re-run files are treated together, and a suite that failed to run counts as passed when it passes on re-run', async () => {
    let now = writeJson('now.json', jestJson([file(FA(), [['a1', 'failed']]), file(FB(), [['b1', 'failed']])]));
    const r1 = writeJson('retry-1.json', jestJson([file(FA(), [['a1', 'passed']])]));
    const r2 = writeJson('retry-2.json', jestJson([file(FB(), [['b1', 'passed']])]));
    let r = await run('merge-retry', now, claimsFile([]), flaky, r1, r2);
    expect(r.stdout.match(/WARNING: flaky test passed on re-run, not rejected: /g)).toHaveLength(2);
    expect(fs.readFileSync(p(flaky), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect((await run('unclaimed', now, 'absent.md')).stdout).toBe('');

    fresh();
    now = writeJson('now.json', jestJson([suiteFail(FA())]));
    const re = writeJson('retry-1.json', jestJson([file(FA(), [['t', 'passed']])]));
    r = await run('merge-retry', now, claimsFile([]), flaky, re);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(WARNING(`${KA}::<suite failed to run>`));
    expect(fs.readFileSync(p(flaky), 'utf8').trim()).toBe(FLAKY(`${KA}::<suite failed to run>`));
    expect((await run('unclaimed', now, 'absent.md')).stdout).toBe('');
  });

  test('a key that fails again, is missing from the re-run, or has an unreadable re-run file stays failing: nothing is written', async () => {
    let before = jestJson([file(FA(), [['broken', 'failed']])]);
    let now = writeJson('now.json', before);
    let cl = claimsFile(['server/__tests__/a.test.js :: other :: spec']);
    let re = writeJson('retry-1.json', jestJson([file(FA(), [['broken', 'failed']])]));
    let r = await run('merge-retry', now, cl, flaky, re);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('WARNING');
    expect(readNow()).toEqual(before);
    expect(fs.existsSync(p(flaky))).toBe(false);
    const pc = await run('precheck', now, cl, '3');
    expect(pc.status).toBe(1);
    expect(pc.stderr).toContain(`${NOT_CLAIMED}: ${KA}::broken`);

    fresh();
    now = writeJson('now.json', jestJson([file(FA(), [['gone', 'failed']])]));
    cl = claimsFile([]);
    re = writeJson('retry-1.json', jestJson([file(FB(), [['unrelated', 'passed']])]));
    r = await run('merge-retry', now, cl, flaky, re);
    expect(r.status).toBe(0);
    expect(readNow().testResults[0].assertionResults[0].status).toBe('failed');
    expect(fs.existsSync(p(flaky))).toBe(false);
    expect((await run('precheck', now, cl, '3')).stderr).toContain(`${NOT_CLAIMED}: ${KA}::gone`);

    fresh();
    now = writeJson('now.json', jestJson([file(FA(), [['x', 'failed']])]));
    fs.writeFileSync(p('retry-1.json'), '{not json');
    r = await run('merge-retry', now, claimsFile([]), flaky, 'retry-1.json', 'retry-absent.json');
    expect(r).toMatchObject({ status: 0, stderr: '' });
    expect(readNow().testResults[0].assertionResults[0].status).toBe('failed');
    expect(fs.existsSync(p(flaky))).toBe(false);

    fresh();
    now = writeJson('now.json', jestJson([suiteFail(FA())]));
    re = writeJson('retry-1.json', jestJson([suiteFail(FA())]));
    await run('merge-retry', now, claimsFile([]), flaky, re);
    expect((await run('unclaimed', now, 'absent.md')).stdout.trim()).toBe(`${KA}::<suite failed to run>`);
    expect(fs.existsSync(p(flaky))).toBe(false);

    fresh();
    before = jestJson([file(FA(), [['ok', 'passed']])]);
    now = writeJson('now.json', before);
    r = await run('merge-retry', now, claimsFile([]), flaky);
    expect(r).toMatchObject({ status: 0, stdout: '' });
    expect(fs.existsSync(p(flaky))).toBe(false);
    expect(readNow()).toEqual(before);
  });

  test('a claimed failing key is never changed or listed, and precheck exits 0 once every unclaimed failure was flaky', async () => {
    let now = writeJson('now.json', jestJson([file(FA(), [['claimed', 'failed'], ['loose', 'failed']])]));
    let cl = claimsFile(['server/__tests__/a.test.js :: claimed :: spec']);
    let re = writeJson('retry-1.json', jestJson([file(FA(), [['claimed', 'passed'], ['loose', 'passed']])]));
    const r = await run('merge-retry', now, cl, flaky, re);
    expect(r.status).toBe(0);
    const a = readNow().testResults[0].assertionResults;
    expect(a.find((x: any) => x.fullName === 'claimed').status).toBe('failed');
    expect(a.find((x: any) => x.fullName === 'loose').status).toBe('passed');
    expect(fs.readFileSync(p(flaky), 'utf8')).not.toContain('claimed');
    expect(fs.readFileSync(p(flaky), 'utf8')).toContain(`${KA}::loose`);
    expect(r.stdout).not.toContain(`${KA}::claimed`);

    fresh();
    now = writeJson('now.json', jestJson([file(FA(), [['claimed', 'failed'], ['flaky', 'failed']])]));
    cl = claimsFile(['server/__tests__/a.test.js :: claimed :: the spec says so']);
    re = writeJson('retry-1.json', jestJson([file(FA(), [['flaky', 'passed']])]));
    expect((await run('precheck', now, cl, '3')).status).toBe(1);
    await run('merge-retry', now, cl, flaky, re);
    expect(await run('precheck', now, cl, '3')).toMatchObject({ status: 0, stderr: '' });
  });
});

describe('testcheck retry-plan and retry-args', () => {
  const plan = async (keys: string[]) => {
    const r = await tc(tmp, ['retry-plan'], { input: keys.join('\n') + '\n' });
    expect(r.status).toBe(0);
    return r.stdout.split('\n').filter(Boolean).map(l => l.split('\t'));
  };

  test('names give an anchored, escaped pattern that matches only them: one line per file, an alternation for several names', async () => {
    const name = 'adds (a) item.[x] to cart';
    const [[f, pat]] = await plan([`${KA}::${name}`]);
    expect(f).toBe(KA);
    let re = new RegExp(pat);
    expect(re.test(name)).toBe(true);
    for (const other of ['adds a item.x to cart', 'adds (a) itemZx to cart', `${name} extra`, `prefix ${name}`]) expect(re.test(other)).toBe(false);

    const names = ['first (one)', 'second.two', 'third [3]'];
    const out = await plan(names.map(n => `${KA}::${n}`));
    expect(out).toHaveLength(1);
    re = new RegExp(out[0][1]);
    names.forEach(n => expect(re.test(n)).toBe(true));
    for (const other of ['first one', 'secondXtwo', 'first (one) second.two']) expect(re.test(other)).toBe(false);
    expect((await plan([`${KA}::x`, `${KB}::y`, `${KA}::z`])).map(o => o[0]).sort()).toEqual([KA, KB]);
  });

  test('a suite-failed-to-run key gives an empty pattern (the whole file), also next to named keys; empty input prints nothing', async () => {
    expect(await plan([`${KA}::<suite failed to run>`])).toEqual([[KA, '']]);
    const out = await plan([`${KA}::named`, `${KA}::<suite failed to run>`, `${KB}::other`]);
    expect(out.find(o => o[0] === KA)![1]).toBe('');
    expect(out.find(o => o[0] === KB)![1]).toMatch(/^\^.*\$$/);
    expect(await tc(tmp, ['retry-plan'], { input: '' })).toMatchObject({ status: 0, stdout: '' });
  });

  test('retry-args gives each file from the root with its failing tests, from stdin or from arguments', async () => {
    expect((await tc(tmp, ['retry-args'], { input: `${KA}::t\n${KA}::u\n${KB}::<suite failed to run>\n` })).stdout)
      .toBe('server/__tests__/a.test.js\tt\tu\nserver/__tests__/b.test.js\n');
    expect((await tc(tmp, ['retry-args', `${KA}::t`])).stdout).toBe('server/__tests__/a.test.js\tt\n');
  });
});

describe('testcheck reads RunResult files like Jest output', () => {
  // The same run of server/__tests__ as Jest reports it and as the runner adapters report it.
  const jestOut = () => jestJson([file(FA(), [['a works', 'passed'], ['a breaks', 'failed']]), suiteFail(p('server/__tests__/broken.test.js'))]);
  const runOut = () => ({ runner: 'jest', suite: 's', ok: false, exitCode: 1, command: 'x', tests: [
    { file: 'server/__tests__/a.test.js', name: 'a works', status: 'passed', message: null },
    { file: 'server/__tests__/a.test.js', name: 'a breaks', status: 'failed', message: 'nope' },
  ], suiteErrors: [{ file: 'server/__tests__/broken.test.js', message: 'boom' }] });
  const setup = () => {
    writeJson('jest.json', jestOut());
    writeJson('run.json', runOut());
    claimsFile(['server/__tests__/a.test.js :: a breaks :: contradicts the spec decision']);
  };

  test('unclaimed, namecheck, redcheck and precheck give the same answers', async () => {
    setup();
    const unclaimedJest = await run('unclaimed', 'jest.json', 'test-issues.md');
    expect(unclaimedJest.stdout).toBe('__tests__/broken.test.js::<suite failed to run>\n');
    expect((await run('unclaimed', 'run.json', 'test-issues.md')).stdout).toBe(unclaimedJest.stdout);
    expect((await run('namecheck', 'jest.json', 'run.json')).status).toBe(0);
    expect((await run('namecheck', 'run.json', 'jest.json')).status).toBe(0);
    expect((await run('redcheck', 'jest.json', 'run.json')).status).toBe(0);
    const pre = async (f: string) => (await run('precheck', f, 'test-issues.md', '3')).stderr;
    expect(await pre('run.json')).toBe(await pre('jest.json'));
    expect(await pre('run.json')).toContain(`${NOT_CLAIMED}: __tests__/broken.test.js::<suite failed to run>`);
  });

  test('precheck matches Vitest hierarchical test names with > delimiters', async () => {
    writeJson('run.json', {
      tests: [
        { file: 'server/__tests__/a.test.js', name: 'suite name a test in suite', status: 'failed', message: 'nope' },
      ],
      suiteErrors: [],
    });
    claimsFile(['server/__tests__/a.test.js :: suite name > a test in suite :: contradicts spec-1.md']);
    const pre = await run('precheck', 'run.json', 'test-issues.md', '3');
    expect(pre.status).toBe(0);
    expect(pre.stderr).toBe('');
  });

  test('namecheck and redcheck reject a removed test and one that no longer fails at red', async () => {
    setup();
    writeJson('fewer.json', { ...runOut(), tests: runOut().tests.slice(1).map(t => ({ ...t, status: 'passed' })), suiteErrors: [] });
    expect((await run('namecheck', 'run.json', 'fewer.json')).stderr).toBe('REJECT: test removed or renamed: __tests__/a.test.js::a works\n');
    const red = await run('redcheck', 'run.json', 'fewer.json');
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('REJECT: test failed at red but now PASSES on the unimplemented source (no longer detects the bug): __tests__/a.test.js::a breaks');
  });

  test('redcheck scopes validation to claimed tests in test-issues.md, ignoring unrelated suite flakes', async () => {
    setup();
    // In stillFailing.json: a breaks still fails, but broken.test.js suite error passed (e.g. was a timeout at red)
    writeJson('stillFailing.json', {
      ...runOut(),
      tests: [
        { file: 'server/__tests__/a.test.js', name: 'a works', status: 'passed', message: null },
        { file: 'server/__tests__/a.test.js', name: 'a breaks', status: 'failed', message: 'nope' },
      ],
      suiteErrors: [], // broken.test.js now passes on base
    });
    // With test-issues.md (which only claims a breaks), broken.test.js passing does NOT cause rejection:
    const redScoped = await run('redcheck', 'run.json', 'stillFailing.json', 'test-issues.md');
    expect(redScoped.status).toBe(0);
    expect(redScoped.stderr).toBe('');

    // If a breaks was repaired to pass on base (vacuous repair), it is still rejected even when scoped:
    writeJson('vacuousRepair.json', {
      ...runOut(),
      tests: [
        { file: 'server/__tests__/a.test.js', name: 'a works', status: 'passed', message: null },
        { file: 'server/__tests__/a.test.js', name: 'a breaks', status: 'passed', message: null },
      ],
      suiteErrors: [],
    });
    const redVacuous = await run('redcheck', 'run.json', 'vacuousRepair.json', 'test-issues.md');
    expect(redVacuous.status).toBe(1);
    expect(redVacuous.stderr).toContain('REJECT: test failed at red but now PASSES on the unimplemented source (no longer detects the bug): __tests__/a.test.js::a breaks');
  });

  test('merge-retry marks an unclaimed failure that passed on re-run as flaky in a RunResult file', async () => {
    setup();
    writeJson('retry.json', { tests: [{ file: 'server/__tests__/broken.test.js', name: 'x', status: 'passed' }], suiteErrors: [] });
    const r = await run('merge-retry', 'run.json', 'test-issues.md', 'flaky.md', 'retry.json');
    expect(r.stdout).toContain('WARNING: flaky test passed on re-run, not rejected: __tests__/broken.test.js::<suite failed to run>');
    expect(JSON.parse(fs.readFileSync(p('run.json'), 'utf8')).suiteErrors).toEqual([]);
    expect((await run('unclaimed', 'run.json', 'test-issues.md')).stdout).toBe('');
  });

  test('keys of a project with one suite at the root are paths from the root', () => {
    const k = new Keys({ testDirs: ['src'], keyDir: '.', pathspecs: [':(glob)src/**/*.test.ts'] }, tmp);
    expect(k.rel('/elsewhere/src/a.test.ts')).toBe('src/a.test.ts');
    expect(k.rootPath('src/a.test.ts')).toBe('src/a.test.ts');
  });
});

describe('testcheck with tests beside the source', () => {
  const env = { SDLC_TEST_DIRS: 'src', SDLC_KEY_DIR: '.', SDLC_TEST_PATHSPECS: ':(glob)src/**/*.test.ts' };
  const check = (dir: string, ...args: string[]) => tc(dir, args, { env });
  const repo = () => {
    const dir = project({ 'src/a.ts': 'export const a = 1;\n', 'src/a.test.ts': "test('a works', () => {});\n", 'Docs/backlog/s/brief.md': 'b\n' });
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'test(s): add failing tests');
    return { dir, red: git(dir, 'rev-parse', 'HEAD') };
  };

  test('diffcheck counts only test files as tests; resumecheck sees a source change beside them as implementation', async () => {
    const { dir, red } = repo();
    write(dir, 'claims.md', 'src/a.test.ts :: a works :: contradicts the spec decision\n');
    write(dir, 'src/a.test.ts', "test('a works', () => { expect(1).toBe(1); });\n");
    write(dir, 'src/a.ts', 'export const a = 2;\n');
    expect(await check(dir, 'diffcheck', red, 'claims.md')).toMatchObject({ status: 0, stderr: '' });
    write(dir, 'src/b.test.ts', 'new\n');
    expect((await check(dir, 'diffcheck', red, 'claims.md')).stderr).toContain('REJECT: changed a test file that was not claimed: src/b.test.ts');

    const resume = await check(dir, 'resumecheck', red, 'claims.md', 's');
    expect(resume.stderr).toContain('tests changed since the red-tests commit');
    expect(resume.stderr).toContain(`restore with: git checkout ${red} -- ':(glob)src/**/*.test.ts' && git clean -fd ':(glob)src/**/*.test.ts'`);
    expect(resume.stderr).not.toContain('no implementation change');
  });

  test('diffcheck rejects weaker, skipped, fewer and new tests, and no change at all', async () => {
    const { dir, red } = repo();
    write(dir, 'claims.md', 'src/a.test.ts :: a works :: spec\n');
    expect((await check(dir, 'diffcheck', red, 'claims.md')).stderr).toBe('REJECT: no test file was changed\n');
    write(dir, 'src/a.test.ts', "test.skip('a works', () => { expect(x).toBeDefined(); });\n");
    const r = await check(dir, 'diffcheck', red, 'claims.md');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('weaker matchers added');
    expect(r.stderr).toContain('skip/only/todo added in src/a.test.ts');
    write(dir, 'src/a.test.ts', '// nothing\n');
    expect((await check(dir, 'diffcheck', red, 'claims.md')).stderr).toContain('fewer it()/test() blocks than at red in src/a.test.ts');
  });

  test('resumecheck counts test changes from the lock commit: a later commit (a merge into a paused run) is not one', async () => {
    const { dir, red } = repo();
    write(dir, 'claims.md', 'src/a.test.ts :: a works :: contradicts the spec decision\n');
    write(dir, 'src/a.test.ts', "test('a works', () => {}); // merged from main\n");
    git(dir, 'commit', '-qam', "Merge branch 'main'");
    write(dir, 'src/a.ts', 'export const a = 2;\n');
    const head = git(dir, 'rev-parse', 'HEAD');
    expect((await check(dir, 'resumecheck', red, 'claims.md', 's')).stderr).toContain('tests changed since the red-tests commit');
    expect(await check(dir, 'resumecheck', red, 'claims.md', 's', head)).toMatchObject({ status: 0, stderr: '' });
    write(dir, 'src/a.test.ts', 'edited by an agent\n');
    expect((await check(dir, 'resumecheck', red, 'claims.md', 's', head)).stderr)
      .toContain(`tests changed since the commit the run continues from ${head.slice(0, 7)}: src/a.test.ts`);
  });

  test('claimed prints keys as paths from the root', async () => {
    const { dir } = repo();
    write(dir, 'claims.md', 'src/a.test.ts :: a works :: x\n');
    expect((await check(dir, 'claimed', 'claims.md')).stdout).toBe('src/a.test.ts::a works\n');
  });
});

describe('testcheck resumecheck', () => {
  const SLUG = 'alpha';
  const CLAIM = 'server/__tests__/a.test.js :: a works :: contradicts the spec decision\n';
  const commit = (dir: string, msg: string) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
  // Initial commit, red-tests commit (test file), a claim file, then an implementation commit; each shape built once.
  const templates: Record<string, { dir: string; red: string }> = {};
  function makeRepo({ impl = true, claim = CLAIM as string | null } = {}) {
    const key = String(impl);
    if (!templates[key]) {
      const dir = tmpDir('sdlc-resume-tpl-');
      git(dir, 'init', '-q');
      // No background maintenance or gc: they create and delete files in .git while the template is copied.
      git(dir, 'config', 'maintenance.auto', 'false');
      git(dir, 'config', 'gc.auto', '0');
      write(dir, 'README.md', 'x\n');
      commit(dir, 'init');
      write(dir, 'server/__tests__/a.test.js', "test('a works', () => {});\n");
      write(dir, `Docs/backlog/${SLUG}/brief.md`, 'brief\n');
      const red = commit(dir, `test(${SLUG}): add failing tests and spec/plan docs`);
      write(dir, `Docs/backlog/${SLUG}/test-issues.md`, CLAIM);
      if (impl) { write(dir, 'server/src/feature.js', 'module.exports = 1;\n'); commit(dir, 'impl'); }
      templates[key] = { dir, red };
    }
    const dir = tmpDir('sdlc-resume-');
    fs.cpSync(templates[key].dir, dir, { recursive: true });
    const claimFile = path.join(dir, `Docs/backlog/${SLUG}/test-issues.md`);
    if (claim === null) fs.rmSync(claimFile);
    else if (claim !== CLAIM) fs.writeFileSync(claimFile, claim);
    return { dir, red: templates[key].red, claimFile };
  }
  const resume = (dir: string, ...args: string[]) => tc(dir, ['resumecheck', ...args]);
  const rejects = (r: { stderr: string }) => r.stderr.split('\n').filter(l => l.startsWith('REJECT:'));
  const RESTORE = (red: string) => `git checkout ${red} -- server/__tests__ && git clean -fd server/__tests__`;

  test('passes silently when all conditions hold, also for an uncommitted or untracked implementation and an ignored test-folder file', async () => {
    let { dir, red, claimFile } = makeRepo();
    expect(await resume(dir, red, claimFile, SLUG)).toEqual({ status: 0, stdout: '', stderr: '' });
    write(dir, '.gitignore', 'server/__tests__/ignored.tmp\n');
    commit(dir, 'ignore');
    write(dir, 'server/__tests__/ignored.tmp', 'x\n');
    expect((await resume(dir, red, claimFile, SLUG)).status).toBe(0);

    ({ dir, red, claimFile } = makeRepo({ impl: false }));
    write(dir, 'server/src/feature.js', 'x\n');
    expect((await resume(dir, red, claimFile, SLUG)).status).toBe(0);

    ({ dir, red, claimFile } = makeRepo({ impl: false }));
    write(dir, 'scripts/new.sh', 'x\n');
    expect((await resume(dir, red, claimFile, SLUG)).status).toBe(0);
  });

  test('rejects a missing or unknown red-tests commit, and a missing, empty or claim-less claim file', async () => {
    const { dir, red, claimFile } = makeRepo();
    let r = await resume(dir, '', claimFile, SLUG);
    expect(r.status).toBe(1);
    expect(rejects(r)).toEqual([`REJECT: no red-tests commit found for ${SLUG} (expected a commit with subject "test(${SLUG}): add failing tests")`]);
    r = await resume(dir, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', claimFile, SLUG);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('REJECT: red-tests commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef is not a known commit');

    fs.unlinkSync(claimFile);
    expect(rejects(await resume(dir, '', claimFile, SLUG))).toHaveLength(2);
    expect(rejects(await resume(dir, red, claimFile, SLUG)).join('\n')).toContain('claim file is missing');
    fs.writeFileSync(claimFile, '');
    expect(rejects(await resume(dir, red, claimFile, SLUG)).join('\n')).toContain('claim file is empty');
    fs.writeFileSync(claimFile, 'just some prose\nno separators here\n');
    expect(rejects(await resume(dir, red, claimFile, SLUG)).join('\n')).toContain('claim file has no valid');
  });

  test('rejects a modified or untracked test file, prints the exact restore command, and changes nothing itself', async () => {
    let { dir, red, claimFile } = makeRepo();
    write(dir, 'server/__tests__/a.test.js', "test('a works', () => { expect(1).toBe(2); });\n");
    let r = await resume(dir, red, claimFile, SLUG);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`server/__tests__/a.test.js; restore with: ${RESTORE(red)}`);

    ({ dir, red, claimFile } = makeRepo());
    write(dir, 'server/__tests__/extra.test.js', 'x\n');
    r = await resume(dir, red, claimFile, SLUG);
    expect(r.stderr).toContain(`server/__tests__/extra.test.js; restore with: ${RESTORE(red)}`);
    expect(fs.existsSync(path.join(dir, 'server/__tests__/extra.test.js'))).toBe(true);

    ({ dir, red, claimFile } = makeRepo({ impl: false }));
    write(dir, 'server/__tests__/a.test.js', 'changed\n');
    write(dir, 'server/__tests__/new.test.js', 'new\n');
    const before = git(dir, 'status', '--porcelain') + git(dir, 'rev-parse', 'HEAD');
    await resume(dir, red, claimFile, SLUG);
    expect(git(dir, 'status', '--porcelain') + git(dir, 'rev-parse', 'HEAD')).toBe(before);
  });

  test('rejects when nothing but Docs/ changed since the red-tests commit, and prints every reject when several conditions fail', async () => {
    let { dir, red, claimFile } = makeRepo({ impl: false });
    expect(rejects(await resume(dir, red, claimFile, SLUG)).join('\n')).toMatch(/no implementation change/);
    write(dir, 'Docs/other.md', 'x\n');
    commit(dir, 'docs only');
    write(dir, 'Docs/more.md', 'y\n');
    expect(rejects(await resume(dir, red, claimFile, SLUG)).join('\n')).toMatch(/no implementation change/);

    ({ dir, red, claimFile } = makeRepo({ impl: false, claim: '' }));
    write(dir, 'server/__tests__/a.test.js', 'changed\n');
    const all = rejects(await resume(dir, red, claimFile, SLUG)).join('\n');
    expect(all).toContain('claim file is empty');
    expect(all).toContain('server/__tests__/a.test.js');
    expect(all).toContain('no implementation change');
  });

  test('rejects when a repair commit for this slug already exists, naming it and pointing to FROM=review', async () => {
    const { dir, red, claimFile } = makeRepo();
    write(dir, 'Docs/x.md', 'x\n');
    commit(dir, 'test(other): repair invalid tests (mechanically checked and audited)');
    expect((await resume(dir, red, claimFile, SLUG)).status).toBe(0);
    write(dir, 'server/__tests__/a.test.js', "test('a works', () => { expect(1).toBe(1); });\n");
    commit(dir, `test(${SLUG}): repair invalid tests (mechanically checked and audited)`);
    const sha = git(dir, 'log', '-1', '--format=%h');
    const r = await resume(dir, red, claimFile, SLUG);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`REJECT: test repair was already accepted in commit ${sha}: use FROM=review`);
  });
});

describe('precheck justification', () => {
  test('a claim citing the spec, the plan, a decision or an isolation defect passes; one with no such reason is rejected', async () => {
    const now = writeJson('now.json', jestJson([file(FA(), [['t', 'failed']])]));
    for (const why of ['contradicts specs-1.md §6', 'plan-1.md step 4 replaces console.error', 'decision Q2 says so', 'leaked mock from another test']) {
      const r = await run('precheck', now, claimsFile([`server/${KA} :: t :: ${why}`]), '3');
      expect([why, r.status, r.stderr]).toEqual([why, 0, '']);
    }
    const r = await run('precheck', now, claimsFile([`server/${KA} :: t :: it is just wrong`]), '3');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`claim gives no spec/plan/decision/isolation justification: ${KA}::t`);
  });
});
