import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { argsProblem } from '../src/cli/args.js';
import { expandGlob } from '../src/config/globs.js';
import { testFiles as testFilesOf, testSpec as testSpecOf } from '../src/config/settings.js';
import { renderSkill, skillNames } from '../src/config/skills.js';
import { project, run, tmp } from './helpers.js';

// Suites here carry only the fields under test.
const testSpec = (suite: object) => testSpecOf(suite as any);
const testFiles = (config: object) => testFilesOf(config as any);
const cli = (...args) => run(args);
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const BESIDE = { suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['src/**/*.test.ts'] }], agent: { codeSearch: 'none' }, ui: { timezone: 'UTC' } };

describe('test files from the settings', () => {
  test('globs with {a,b} and extglobs become globs git understands', () => {
    expect(expandGlob('src/**/*.{test,spec}.ts')).toEqual(['src/**/*.test.ts', 'src/**/*.spec.ts']);
    expect(expandGlob('**/?(*.)+(spec|test).[jt]s?(x)')).toEqual(['**/spec.[jt]s', '**/spec.[jt]sx', '**/test.[jt]s', '**/test.[jt]sx',
      '**/*.spec.[jt]s', '**/*.spec.[jt]sx', '**/*.test.[jt]s', '**/*.test.[jt]sx']);
    expect(expandGlob('plain/**')).toEqual(['plain/**']);
  });

  test('a folder that holds only tests is guarded as a folder; tests beside the source by their globs', () => {
    expect(testSpec({ dir: 'server', testGlobs: ['__tests__/**'] })).toEqual({ folder: 'server/__tests__', globs: ['server/__tests__/**'], pathspecs: ['server/__tests__'], patterns: ['^server/__tests__/'] });
    const beside = testSpec({ dir: '.', testGlobs: ['src/**/*.test.ts'] });
    expect(beside).toMatchObject({ folder: null, pathspecs: [':(glob)src/**/*.test.ts'] });
    expect(new RegExp(beside.patterns[0]).test('src/a/b.test.ts')).toBe(true);
    expect(new RegExp(beside.patterns[0]).test('src/a/b.ts')).toBe(false);
    expect(testSpec({ dir: 'web', testGlobs: ['test/**/*.js'] }).folder).toBeNull(); // test/ may hold helpers that are not tests
    expect(testFiles({ suites: [{ dir: 'server', testGlobs: ['__tests__/**'] }, { dir: 'web', testGlobs: ['**/*.spec.ts'] }] }))
      .toBe('server/__tests__/; files matching web/**/*.spec.ts');
  });

  test('git matches the pathspecs as the pipeline uses them', () => {
    const dir = project({ 'src/a.ts': 'a', 'src/a.test.ts': 'a', 'src/deep/b.test.ts': 'b', 'src/deep/b.ts': 'b' });
    git(dir, 'init', '-q');
    const specs = testSpec({ dir: '.', testGlobs: ['src/**/*.test.ts'] }).pathspecs;
    expect(git(dir, 'ls-files', '--others', '--', ...specs).split('\n').sort()).toEqual(['src/a.test.ts', 'src/deep/b.test.ts']);
    expect(git(dir, 'ls-files', '--others', '--', 'src', ':(exclude,glob)src/**/*.test.ts').split('\n').sort()).toEqual(['src/a.ts', 'src/deep/b.ts']);
  });

  test('layout prints the folders, patterns and test command, or exits 1 with the settings errors', async () => {
    const dir = project({ 'sdlc.config.json': BESIDE, 'src/x.ts': '' });
    const r = await cli('layout', dir);
    expect(JSON.parse(r.stdout)).toEqual({
      root: dir, backlogDir: 'Docs/backlog', testDirs: ['src'], sourceDirs: ['.'], testCmd: 'npm test', keyDir: '.',
      testFiles: 'files matching src/**/*.test.ts', testPathspecs: [':(glob)src/**/*.test.ts'], testPatterns: [expect.any(String)],
    });
    const bad = await cli('layout', project({ 'a.txt': '' }));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('ERROR: no test suite found');
  });

  test('skills get the test files, test command, framework, backlog folder and branch prefix from the settings', () => {
    const skills = tmp('sdlc-skills-');
    fs.mkdirSync(path.join(skills, 'parts'));
    fs.writeFileSync(path.join(skills, 'parts/code-search.md'), 'GREP');
    fs.writeFileSync(path.join(skills, 'demo.md'), '{{TEST_FILES}}|{{TEST_PATHSPECS}}|{{TEST_CMD}}|{{TEST_FRAMEWORK}}|{{BACKLOG_DIR}}|{{BRANCH_PREFIX}}|{{CODE_SEARCH}}');
    const opts = { skillsDir: skills, partsDir: path.join(skills, 'parts'), env: { PATH: '/usr/bin:/bin' } };
    const dir = project({ 'sdlc.config.json': { ...BESIDE, backlogDir: 'work/items', git: { branchPrefix: 'feature/' } }, 'src/x.ts': '' });
    expect(renderSkill('demo', dir, opts)).toBe("files matching src/**/*.test.ts|':(glob)src/**/*.test.ts'|npm test|"
      + "node:test tests (describe/it from 'node:test', assert from 'node:assert/strict'), in JavaScript|work/items|feature/|GREP");
    // settings that cannot be resolved: wording that sends the agent to find out
    expect(renderSkill('demo', project({ 'sdlc.config.json': { backlogDir: 'items' } }), opts))
      .toBe("the project's test files|<the test files>|the project's test command|tests in the style the project already uses|items|sdlc/|GREP");
  });
});

describe('the monitor-run skill', () => {
  test('is shipped, and renders with the project backlog folder and branch prefix filled in', () => {
    expect(skillNames()).toContain('monitor-run');
    const dir = project({ 'sdlc.config.json': { ...BESIDE, backlogDir: 'work/items', git: { branchPrefix: 'feature/' } }, 'src/x.ts': '' });
    const text = renderSkill('monitor-run', dir, { env: { PATH: '/usr/bin:/bin' } })!;
    expect(text).toContain('feature/<slug>');
    expect(text).toContain('work/items/<slug>/logs/');
    expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('the undo-run-action skill', () => {
  test('is shipped, and renders with the project backlog folder and branch prefix filled in', () => {
    expect(skillNames()).toContain('undo-run-action');
    const dir = project({ 'sdlc.config.json': { ...BESIDE, backlogDir: 'work/items', git: { branchPrefix: 'feature/' } }, 'src/x.ts': '' });
    const text = renderSkill('undo-run-action', dir, { env: { PATH: '/usr/bin:/bin' } })!;
    expect(text).toContain('feature/<slug>');
    expect(text).toContain('work/items/<slug>/logs/');
    expect(text).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

describe('command lines a shell did not split', () => {
  const CONFIG_CLI = { commands: ['detect', 'code-search', 'init-tests'], valued: ['--runner', '--test-dir'], flags: ['--json', '--list'] };

  test('a command or option arriving with what follows it as one argument is named, with the words to pass instead', () => {
    expect(argsProblem(['code-search --list', '.'], CONFIG_CLI)).toBe('"code-search --list" arrived as one argument, so the shell did not split it '
      + '(zsh and PowerShell do this with an unquoted variable). Pass each word separately: code-search --list');
    expect(argsProblem(['init-tests', '--runner vitest'], CONFIG_CLI)).toMatch(/^"--runner vitest" arrived as one argument/);
  });

  test('unknown commands and options and a missing command are errors; spaces in values and paths are fine', () => {
    expect(argsProblem(['frob'], CONFIG_CLI)).toBe('unknown command "frob" (commands: detect, code-search, init-tests)');
    expect(argsProblem(['detect', '--jsno'], CONFIG_CLI)).toBe('unknown option "--jsno"');
    expect(argsProblem([], CONFIG_CLI)).toBe('no command given');
    expect(argsProblem(['detect', './my project'], CONFIG_CLI)).toBeNull();
    expect(argsProblem(['init-tests', '--test-dir', 'detect --json'], CONFIG_CLI)).toBeNull();
    expect(argsProblem(['init-tests', '.', '--runner', 'vitest', '--json'], CONFIG_CLI)).toBeNull();
  });
});
