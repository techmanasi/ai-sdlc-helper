import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

let base: string;
let repo: string;
let bin: string;
let config: string;
let server: RunningServer | undefined;
const initial = JSON.stringify({ agent: { model: 'keep-me', codeSearch: 'none' } }, null, 2) + '\n';
const endpoint = '/api/projects/shop/code-search';

async function install(name: string, script: string) {
  await fs.writeFile(path.join(bin, name), '#!' + process.execPath + '\n' + script, { mode: 0o755 });
}
const build = `
  const fs = require('node:fs');
  fs.appendFileSync('calls', JSON.stringify([process.argv.slice(2), process.cwd(), process.env.BUILD_MARK]) + '\\n');
  fs.mkdirSync('graft', { recursive: true });
  console.log('built index');
`;

beforeEach(async () => {
  vi.mocked(spawn).mockClear();
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'indexer-http-')));
  repo = path.join(base, 'shop');
  bin = path.join(base, 'bin');
  config = path.join(repo, 'sdlc.config.json');
  await fs.mkdir(repo);
  await fs.mkdir(bin);
  await promisify(execFile)('git', ['init', '-q', repo]);
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  await fs.writeFile(config, initial);
  await install('graft', build);
  server = await startServer({ cwd: repo, port: 0, env: {
    ...process.env, PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter), BUILD_MARK: 'from-server',
    AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'registry'),
  } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
  await fs.rm(base, { recursive: true, force: true });
});

async function request(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  const res = await fetch('http://127.0.0.1:' + server!.port + pathname, {
    method, headers: { 'x-sdlc-token': server!.token, 'content-type': 'application/json', connection: 'close', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  return { status: res.status, json: await res.json() };
}
const inspect = () => request('GET', endpoint);
const setup = (body: unknown) => request('POST', endpoint + '/setup', body);
const saved = () => fs.readFile(config, 'utf8');
const calls = () => fs.readFile(path.join(repo, 'calls'), 'utf8');
const buildGraft = () => setup({ indexer: 'graft', build: true });

describe('project code search setup over HTTP', () => {
  it('inspects the project behind the token, Origin and JSON guards', async () => {
    expect(await inspect()).toMatchObject({ status: 200, json: { setting: 'none', current: 'none', indexers: expect.arrayContaining([
      expect.objectContaining({ name: 'graft', command: 'graft', installed: true, index: 'graft', indexed: false, canBuild: true }),
      expect.objectContaining({ name: 'graphify', installed: false, canBuild: false }),
    ]) } });
    const post = (headers: Record<string, string>) => request('POST', endpoint + '/setup', { indexer: 'graft' }, headers);
    expect((await request('GET', endpoint, undefined, { 'x-sdlc-token': '' })).status).toBe(401);
    expect((await post({ 'x-sdlc-token': '' })).status).toBe(401);
    expect((await post({ origin: 'https://other.example' })).status).toBe(403);
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(415);
    expect(await saved()).toBe(initial);
  });

  it('builds and rebuilds Graft in the project with the server environment and fresh doctor results', async () => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      expect(await buildGraft()).toMatchObject({ status: 200, json: {
        ok: true, codeSearch: 'graft', output: expect.stringContaining('built index'),
        checks: expect.arrayContaining([expect.objectContaining({ name: 'code indexer', ok: true })]),
      } });
      expect((await calls()).trimEnd().split('\n')).toEqual(Array(attempt).fill(JSON.stringify([['build'], repo, 'from-server'])));
    }
    expect(JSON.parse(await saved()).agent).toMatchObject({ codeSearch: 'graft', model: 'keep-me' });
    expect(await inspect()).toMatchObject({ json: { setting: 'graft', current: 'graft',
      indexers: expect.arrayContaining([expect.objectContaining({ name: 'graft', indexed: true })]) } });
  });

  it('passes the declared builder its literal arguments even when display text differs', async () => {
    await install('builder', build);
    await install('graft', 'process.exit(22)');
    const args = ['two words', '$BUILD_MARK', '*.json'];
    const tool = { command: 'graft', guide: 'search', build: 'run the local builder', buildArgv: ['builder', ...args] };
    await fs.writeFile(config, JSON.stringify({ agent: { codeIndexers: { local: tool } } }));
    expect(await setup({ indexer: 'local', build: true })).toMatchObject({ status: 200, json: { ok: true, codeSearch: 'local' } });
    expect(JSON.parse(await calls())).toEqual([args, repo, 'from-server']);
  });

  it.each([
    { name: 'explicit false replaces a stale selection', missing: false, body: { indexer: 'graft', build: false } },
    { name: 'omitted build creates a missing config', missing: true, body: { indexer: 'graft' } },
  ])('configures without spawning when $name', async ({ missing, body }) => {
    if (missing) await fs.unlink(config);
    else {
      await fs.writeFile(config, JSON.stringify({ agent: { codeSearch: 'retired' } }));
      expect(await inspect()).toMatchObject({ status: 200, json: { setting: 'retired' } });
    }
    const result = await setup(body);
    expect(result).toMatchObject({ status: 200, json: { ok: true, codeSearch: 'graft' } });
    expect(result.json).not.toHaveProperty('output');
    expect(vi.mocked(spawn).mock.calls.some(([file]) => path.basename(file) === 'graft')).toBe(false);
    expect(JSON.parse(await saved()).agent.codeSearch).toBe('graft');
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['unknown', 'constructor', '__proto__'])('rejects unknown indexer %s without saving', async indexer => {
    expect(await setup({ indexer })).toMatchObject({ status: 400, json: { ok: false, error: "unknown indexer: '" + indexer + "'" } });
    expect(await saved()).toBe(initial);
  });

  it.each([
    { name: 'array', body: [] }, { name: 'null', body: null }, { name: 'missing name', body: {} },
    { name: 'empty name', body: { indexer: '' } }, { name: 'numeric name', body: { indexer: 1 } },
    { name: 'string build flag', body: { indexer: 'graft', build: 'false' } },
  ])('rejects a malformed request with $name', async ({ body }) => {
    expect(await setup(body)).toMatchObject({ status: 400, json: { ok: false, error: expect.stringMatching(/.+/) } });
    expect(await saved()).toBe(initial);
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['graphify', 'graft'])('refuses an unavailable executable build for %s', async indexer => {
    await install('graphify', build);
    await fs.unlink(path.join(bin, 'graft'));
    expect(await setup({ indexer, build: true })).toMatchObject({ status: 400, json: { ok: false,
      error: "cannot build indexer '" + indexer + "': no executable build command or binary not on PATH" } });
    expect(await saved()).toBe(initial);
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a build when the indexer exists but its declared builder is missing', async () => {
    const data = JSON.stringify({ agent: { codeSearch: 'none', codeIndexers: {
      local: { command: 'graft', guide: 'search', build: 'build locally', buildArgv: ['missing-builder', 'build'] },
    } } });
    await fs.writeFile(config, data);
    expect(await inspect()).toMatchObject({ status: 200, json: { indexers: expect.arrayContaining([
      expect.objectContaining({ name: 'local', installed: true, canBuild: false }),
    ]) } });
    expect(await setup({ indexer: 'local', build: true })).toMatchObject({ status: 400, json: { ok: false,
      error: "cannot build indexer 'local': no executable build command or binary not on PATH" } });
    expect(await saved()).toBe(data);
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows configure-only selection of a known indexer whose binary is missing', async () => {
    await fs.unlink(path.join(bin, 'graft'));
    expect(await setup({ indexer: 'graft', build: false })).toMatchObject({ status: 200, json: {
      ok: true, codeSearch: 'graft', checks: expect.arrayContaining([expect.objectContaining({ name: 'code indexer', ok: false })]),
    } });
    expect(JSON.parse(await saved()).agent).toMatchObject({ codeSearch: 'graft', model: 'keep-me' });
    expect(await inspect()).toMatchObject({ status: 200, json: { setting: 'graft', current: 'none' } });
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns a structured error when the configuration path is a directory', async () => {
    await fs.unlink(config);
    await fs.mkdir(config);
    expect(await request('POST', endpoint + '/setup', { indexer: 'graft' }, {}, AbortSignal.timeout(2000))).toMatchObject({ status: 400, json: {
      ok: false, error: expect.stringContaining('sdlc.config.json'),
    } });
  });

  it('reports the terminating signal when a builder is killed', async () => {
    await install('graft', "process.kill(process.pid, 'SIGKILL');");
    expect(await buildGraft()).toMatchObject({ status: 400, json: {
      ok: false, error: expect.stringMatching(/graft build.*SIGKILL/),
    } });
    expect(await saved()).toBe(initial);
  });

  it.each([
    { name: 'unparseable JSON', data: '{' }, { name: 'invalid settings field', data: '{"agent":{"unknownField":true}}' },
  ])('refuses to start the child for $name', async ({ data }) => {
    await fs.writeFile(config, data);
    expect(await buildGraft()).toMatchObject({ status: 400, json: { ok: false, error: expect.stringMatching(/.+/) } });
    expect(await saved()).toBe(data);
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns both output streams and preserves settings on a nonzero exit, then permits retry', async () => {
    await install('graft', "console.log('scan started'); console.error('invalid input'); process.exitCode = 7;");
    const result = await buildGraft();
    expect(result).toMatchObject({ status: 400, json: { ok: false, error: 'graft build exited with code 7', output: expect.stringContaining('scan started') } });
    expect(result.json).toMatchObject({ output: expect.stringContaining('invalid input') });
    expect(await saved()).toBe(initial);
    await install('graft', build);
    expect((await buildGraft()).status).toBe(200);
  });
});

async function waitForChild(pending: ReturnType<typeof buildGraft>) {
  const marker = path.join(repo, 'started');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await fs.readFile(marker, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 1) return pid;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await Promise.race([delay(20), pending.then(reply => { throw new Error('build ended before child started: ' + JSON.stringify(reply)); })]);
  }
  throw new Error('indexer did not start');
}

describe('settings consistency during a build', () => {
  it('rejects overlapping setup and preserves an intervening edit when the first build finishes', async () => {
    await install('graft', `
      const fs = require('node:fs');
      fs.writeFileSync('started', String(process.pid));
      const interval = setInterval(() => {
        if (fs.existsSync('release')) { console.log('index finished'); clearInterval(interval); }
      }, 20);
      setTimeout(() => process.exit(8), 8000).unref();
    `);
    const pending = buildGraft();
    const edited = JSON.stringify({ agent: { codeSearch: 'none', model: 'changed' } });
    try {
      await waitForChild(pending);
      const overlap = await setup({ indexer: 'graphify' });
      expect(overlap.status).toBeGreaterThanOrEqual(400);
      expect(overlap.json).toMatchObject({ ok: false, error: expect.stringMatching(/.+/) });
      expect(await saved()).toBe(initial);
      await fs.writeFile(config, edited);
    } finally {
      await fs.writeFile(path.join(repo, 'release'), '');
    }
    expect(await pending).toMatchObject({ status: 400, json: { ok: false, error: expect.stringMatching(/.+/), output: expect.stringContaining('index finished') } });
    expect(await saved()).toBe(edited);
    expect((await setup({ indexer: 'graft' })).status).toBe(200);
    expect(await inspect()).toMatchObject({ json: { setting: 'graft' } });
  });

  it('keeps the project build guard until a timed-out child exits', async () => {
    await install('graft', `
      process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync('started', String(process.pid));
      setTimeout(() => process.exit(9), 10000);
    `);
    const schedule = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 120000) expire = () => fn(...args);
      return schedule(fn, ms, ...args);
    }) as typeof setTimeout);
    const pending = buildGraft();
    const pid = await waitForChild(pending);
    try {
      expect(expire).toBeTypeOf('function');
      expire!();
      // Either the response waits for exit, or a completed response must not release the guard early.
      const first = await Promise.race([pending.then(() => 'finished'), delay(100).then(() => 'pending')]);
      if (first === 'finished') {
        expect(await buildGraft()).toMatchObject({ status: 400, json: { ok: false, error: expect.stringMatching(/already in progress/i) } });
      }
      await pending;
      if (first === 'pending') expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      await pending;
    }
  });

  it('enforces the 120 second deadline and terminates a child that ignores SIGTERM', async () => {
    await install('graft', `
      process.on('SIGTERM', () => {});
      require('node:fs').writeFileSync('started', String(process.pid));
      setTimeout(() => { require('node:fs').writeFileSync('expired-naturally', ''); process.exit(9); }, 10000);
    `);
    const schedule = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms === 120000) expire = () => fn(...args);
      return schedule(fn, ms, ...args);
    }) as typeof setTimeout);
    const pending = buildGraft();
    const pid = await waitForChild(pending);
    expect(expire).toBeTypeOf('function');
    expire!();
    expect(await pending).toMatchObject({ status: 400, json: { ok: false, error: 'build timed out after 120s' } });
    expect(await saved()).toBe(initial);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
    await expect(fs.stat(path.join(repo, 'expired-naturally'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
