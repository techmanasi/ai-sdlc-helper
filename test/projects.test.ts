import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { main } from '../src/cli/main.js';
import { configDir } from '../src/configDir.js';
import { doctor, doctorOk, type Spawn } from '../src/registry/doctor.js';
import {
  RegistryError, projectDir, readRegistry, registryFile, withProject, writeRegistry,
} from '../src/registry/projects.js';
import { pathWith, project, tmp, write } from './helpers.js';

const CONFIG = { suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'true' }], agent: { codeSearch: 'none' }, ui: { timezone: 'UTC' } };

/** A git repository holding <files>, at its real path (git reports /private/var for /var on macOS). */
const repo = (files: Record<string, unknown> = {}): string => {
  const dir = fs.realpathSync(project(files));
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return dir;
};

/** An env with its own registry folder and a PATH holding stand-ins for <programs>. */
const envWith = (...programs: string[]): NodeJS.ProcessEnv => ({ ...pathWith(...programs), AI_SDLC_HELPER_CONFIG_DIR: tmp('ai-sdlc-cfg-') });

interface Result { status: number; stdout: string; stderr: string; asked: string[] }

/** Runs the command line with <answers> given in turn at the prompt; without answers there is no terminal. */
async function cli(args: string[], env: NodeJS.ProcessEnv, answers?: string[], cwd?: string): Promise<Result> {
  let stdout = '';
  let stderr = '';
  const asked: string[] = [];
  const ask = answers && (async (q: string) => { asked.push(q.trim()); return answers.shift() ?? ''; });
  const status = await main(args, { out: t => { stdout += `${t}\n`; }, err: t => { stderr += `${t}\n`; }, env, ask, cwd });
  return { status, stdout, stderr, asked };
}

describe('the config folder', () => {
  test('AI_SDLC_HELPER_CONFIG_DIR, else XDG_CONFIG_HOME, else ~/.config; %APPDATA% on Windows', () => {
    expect(configDir({ AI_SDLC_HELPER_CONFIG_DIR: '/x/cfg', XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe(path.resolve('/x/cfg'));
    expect(configDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/a' }, 'linux')).toBe('/xdg/ai-sdlc-helper');
    expect(configDir({ HOME: '/home/a' }, 'darwin')).toBe('/home/a/.config/ai-sdlc-helper');
    expect(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toBe('C:\\Users\\a\\AppData\\Roaming\\ai-sdlc-helper');
  });
});

describe('the registry file', () => {
  test('missing is empty; what is written reads back, sorted, with no temporary file left', () => {
    const env = envWith();
    expect(readRegistry(env)).toEqual([]);
    const b = { name: 'b', path: '/p/b', addedAt: '2026-01-01T00:00:00.000Z', overrides: { maxParallel: 1 } };
    const a = { name: 'a', path: '/p/a', addedAt: '2026-01-02T00:00:00.000Z' };
    writeRegistry([b, a], env);
    expect(readRegistry(env)).toEqual([a, b]);
    expect(fs.readdirSync(path.dirname(registryFile(env)))).toEqual(['projects.json']);
  });

  test('a corrupt file is a clear error, for the library and the commands', async () => {
    const env = envWith();
    write(env.AI_SDLC_HELPER_CONFIG_DIR!, 'projects.json', '{ not json');
    expect(() => readRegistry(env)).toThrow(RegistryError);
    expect(() => readRegistry(env)).toThrow(/projects\.json is not valid JSON .*delete it to start a new registry/);
    const r = await cli(['list'], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^ERROR: .*projects\.json is not valid JSON/);
    write(env.AI_SDLC_HELPER_CONFIG_DIR!, 'projects.json', { projects: [{ name: 'Bad Name', path: '/p', addedAt: 'x' }] });
    expect(() => readRegistry(env)).toThrow(/projects\[0\]\.name is not a valid name/);
    write(env.AI_SDLC_HELPER_CONFIG_DIR!, 'projects.json', { other: [] });
    expect(() => readRegistry(env)).toThrow(/has no "projects" list/);
  });

  test('names are unique and checked; the same path updates its entry and keeps addedAt', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const first = withProject([], { name: 'shop', path: '/p/shop', now, overrides: { maxParallel: 2 } });
    expect(first.entry).toEqual({ name: 'shop', path: '/p/shop', addedAt: now.toISOString(), overrides: { maxParallel: 2 } });
    const again = withProject(first.entries, { name: 'store', path: '/p/shop' });
    expect(again).toMatchObject({ updated: true, entry: { name: 'store', addedAt: now.toISOString(), overrides: { maxParallel: 2 } } });
    expect(again.entries).toHaveLength(1);
    expect(() => withProject(first.entries, { name: 'shop', path: '/p/other' })).toThrow(/already used by \/p\/shop/);
    expect(() => withProject([], { name: 'Shop_1', path: '/p/x' })).toThrow(/lowercase letters, digits and dashes/);
  });
});

describe('add', () => {
  test('without a terminal and without --yes: shows the proposal, exits 2 and writes nothing', async () => {
    const env = envWith();
    const dir = repo({ 'package.json': { scripts: { test: 'vitest run' }, devDependencies: { vitest: '3' } } });
    const r = await cli(['add', dir], env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ERROR: confirm with --yes');
    expect(r.stdout).toContain('Settings: detected (no sdlc.config.json)');
    expect(r.stdout).toMatch(/\(\.\): vitest, javascript, npm\n {4}test command: npm test/);
    expect(r.stdout).toContain('Backlog folder: Docs/backlog (no index.md yet)');
    expect(r.stdout).toContain('"runner": "vitest"');
    expect(fs.existsSync(registryFile(env))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'sdlc.config.json'))).toBe(false);
  });

  test('asks before registering, writing sdlc.config.json and creating the backlog index; answers are kept to', async () => {
    const env = envWith();
    const dir = repo({ 'package.json': { scripts: { test: 'vitest run' }, devDependencies: { vitest: '3' } } });
    const no = await cli(['add', dir, '--name', 'shop'], env, ['n']);
    expect(no.asked).toEqual([`Register shop (${dir})? [y/N]:`]);
    expect(no.stdout).toContain('Nothing was changed.');
    expect(fs.existsSync(registryFile(env))).toBe(false);

    const r = await cli(['add', dir, '--name', 'shop'], env, ['y', 'yes', 'n']);
    expect(r.status).toBe(0);
    expect(r.asked).toEqual([`Register shop (${dir})? [y/N]:`, 'Write sdlc.config.json with these settings? [y/N]:', 'Create Docs/backlog/index.md? [y/N]:']);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'sdlc.config.json'), 'utf8'));
    expect(written).toEqual({ backlogDir: 'Docs/backlog', suites: [{ name: path.basename(dir), dir: '.', runner: 'vitest', testCmd: 'npm test', testGlobs: expect.any(Array) }] });
    expect(fs.existsSync(path.join(dir, 'Docs/backlog/index.md'))).toBe(false);
    expect(readRegistry(env)).toEqual([{ name: 'shop', path: dir, addedAt: expect.any(String) }]);
  });

  test('--yes with a config: registers the git root under the folder name and creates the backlog index', async () => {
    const env = envWith();
    const dir = repo({ 'sdlc.config.json': { ...CONFIG, backlogDir: 'work/items' }, 'sub/x.txt': '' });
    const r = await cli(['add', path.join(dir, 'sub'), '--yes', '--max-parallel', '2', '--worktree-base', '../wt'], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Settings: from sdlc.config.json');
    expect(r.stdout).not.toContain('sdlc.config.json to write');
    const [entry] = readRegistry(env);
    expect(entry).toMatchObject({ name: path.basename(dir).toLowerCase(), path: dir, overrides: { maxParallel: 2, worktreeBase: '../wt' } });
    expect(fs.readFileSync(path.join(dir, 'work/items/index.md'), 'utf8')).toContain('work/items/<slug>/brief.md');

    // Re-adding the same path updates the entry; its overrides stay.
    const again = await cli(['add', dir, '--yes', '--name', 'renamed'], env);
    expect(again.stdout).toContain('Updated renamed');
    expect(readRegistry(env)).toEqual([{ ...entry, name: 'renamed' }]);
  });

  test('--yes --commit commits the written files to git', async () => {
    const env = envWith();
    const dir = repo({ 'package.json': { name: 'app', scripts: { test: 'vitest' } } });
    spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test'], { encoding: 'utf8' });
    spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { encoding: 'utf8' });
    spawnSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8' });
    spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'initial'], { encoding: 'utf8' });
    const r = await cli(['add', dir, '--yes', '--commit'], env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Committed');
    const log = spawnSync('git', ['-C', dir, 'log', '-1', '--oneline'], { encoding: 'utf8' }).stdout;
    expect(log).toContain('chore: setup ai-sdlc-helper');
  });

  test('refuses a folder outside git, a name in use and a bad --max-parallel; a default name in use gets a number', async () => {
    const env = envWith();
    const plain = fs.realpathSync(project({ 'a.txt': '' }));
    const notGit = await cli(['add', plain, '--yes'], env);
    expect(notGit.status).toBe(1);
    expect(notGit.stderr).toContain('is not in a git repository');

    const one = repo({ 'sdlc.config.json': CONFIG });
    const two = repo({ 'sdlc.config.json': CONFIG });
    await cli(['add', one, '--yes', '--name', 'app'], env);
    const clash = await cli(['add', two, '--yes', '--name', 'app'], env);
    expect(clash.status).toBe(1);
    expect(clash.stderr).toContain(`the name "app" is already used by ${one}`);
    expect((await cli(['add', two, '--max-parallel', '0'], env)).status).toBe(2);

    const base = path.join(tmp('ai-sdlc-twins-'), 'twin');
    for (const d of [base, `${base}-b/twin`]) {
      fs.mkdirSync(d, { recursive: true });
      write(d, 'sdlc.config.json', CONFIG);
      spawnSync('git', ['init', '-q'], { cwd: d });
    }
    await cli(['add', base, '--yes'], env);
    await cli(['add', `${base}-b/twin`, '--yes'], env);
    expect(readRegistry(env).map(e => e.name)).toEqual(['app', 'twin', 'twin-2']);
  });
});

describe('list and remove', () => {
  test('list as text and JSON; remove forgets a project and names the registered ones when it is unknown', async () => {
    const env = envWith();
    expect((await cli(['list'], env)).stdout).toContain('No projects are registered');
    const dir = repo({ 'sdlc.config.json': CONFIG });
    await cli(['add', dir, '--yes', '--name', 'shop'], env);
    writeRegistry([...readRegistry(env), { name: 'gone', path: '/no/such/folder', addedAt: 'x' }], env);
    const text = await cli(['list'], env);
    expect(text.stdout).toBe(`gone  /no/such/folder  (missing)\nshop  ${dir}\n`);
    expect(JSON.parse((await cli(['list', '--json'], env)).stdout).map((e: any) => e.name)).toEqual(['gone', 'shop']);

    expect((await cli(['remove'], env)).status).toBe(2);
    const unknown = await cli(['remove', 'nope'], env);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('no project "nope" (registered: gone, shop)');
    expect((await cli(['remove', 'gone'], env)).status).toBe(0);
    expect(readRegistry(env).map(e => e.name)).toEqual(['shop']);
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('doctor', () => {
  const ready = () => repo({ 'sdlc.config.json': CONFIG, 'Docs/backlog/index.md': '# Backlog\n' });

  test('passes when everything is there; claude missing fails, a missing indexer is only recommended', async () => {
    const dir = ready();
    const ok = await cli(['doctor', dir], envWith('claude'));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/✓ claude CLI: .*\/claude/);
    expect(ok.stdout).toContain('✓ settings: settings resolve');
    expect(ok.stdout).toContain('All required checks passed.');

    const missing = await cli(['doctor', dir], envWith());
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('✗ claude CLI: the claude command is not on PATH\n    fix: install Claude Code');
    expect(missing.stdout).toContain('1 required check failed.');

    const auto = repo({ 'sdlc.config.json': { ...CONFIG, agent: { codeSearch: 'auto' } }, 'Docs/backlog/index.md': '' });
    const r = await cli(['doctor', auto], envWith('claude'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/✗ code indexer: no code indexer is available.*\(recommended\)/);
  });

  test('fails for bad settings and a missing backlog index; --run-tests runs each suite once', async () => {
    const env = envWith('claude');
    const bad = repo({ 'sdlc.config.json': { backlogDir: 5 } });
    const r = await cli(['doctor', bad], env);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('✗ settings: sdlc.config.json: backlogDir: must be a non-empty string');
    expect(r.stdout).toContain('✗ backlog index: Docs/backlog/index.md is missing');

    const failing = repo({ 'sdlc.config.json': { ...CONFIG, suites: [{ ...CONFIG.suites[0], testCmd: 'echo boom >&2; false' }] }, 'Docs/backlog/index.md': '' });
    expect((await cli(['doctor', failing], env)).status).toBe(0);
    const run = await cli(['doctor', failing, '--run-tests'], env);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/✗ tests: app: echo boom >&2; false exited 1:\n {4}boom/);
    expect((await cli(['doctor', ready(), '--run-tests'], env)).stdout).toContain('✓ tests: app: true passed');
  });

  test('--project picks a registered project; an unknown one is an error', async () => {
    const env = envWith('claude');
    const dir = ready();
    await cli(['add', dir, '--yes', '--name', 'shop'], env);
    const r = await cli(['doctor', '--project', 'shop'], env, undefined, '/');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`✓ git repository: ${dir}`);
    expect((await cli(['doctor', '--project', 'nope'], env)).status).toBe(2);
  });

  test('git, the tool Node and the claude lookup go through the injected spawn, lookup and version', () => {
    const dir = ready();
    const spawn: Spawn = () => ({ status: null, stdout: '', stderr: 'not found' });
    const which = (name: string) => (name === 'claude' ? '/bin/claude' : null);
    const checks = doctor(dir, { env: { PATH: '/usr/bin:/bin' }, spawn, which, nodeVersion: '16.20.0' });
    const by = Object.fromEntries(checks.map(c => [c.name, c]));
    expect(by['tool Node']).toMatchObject({ ok: false, required: true, detail: 'the tool runs on Node 16.20.0 (needs 18 or newer)' });
    expect(by.git).toMatchObject({ ok: false, detail: 'git is not on PATH', fix: 'install git' });
    expect(by['git repository'].ok).toBe(false);
    expect(by['claude CLI']).toMatchObject({ ok: true, detail: '/bin/claude' });
    expect(doctorOk(checks)).toBe(false);
  });
});

describe('projectDir', () => {
  test('a registered name, else a path (its git root), else the registered project holding cwd, else cwd\'s git root', () => {
    const env = envWith();
    const shop = repo({ 'sub/deep/x.txt': '' });
    const other = repo({ 'lib/x.txt': '' });
    writeRegistry([{ name: 'shop', path: shop, addedAt: 'x' }], env);
    expect(projectDir('shop', '/', env)).toBe(shop);
    expect(projectDir('lib', other, env)).toBe(other);
    expect(projectDir(undefined, path.join(shop, 'sub/deep'), env)).toBe(shop);
    expect(projectDir(undefined, path.join(other, 'lib'), env)).toBe(other);
    const plain = fs.realpathSync(tmp());
    expect(projectDir(undefined, plain, env)).toBe(plain);
    expect(() => projectDir('nope', plain, env)).toThrow(/"nope" is not a registered project or a folder \(registered: shop\)/);
  });
});
