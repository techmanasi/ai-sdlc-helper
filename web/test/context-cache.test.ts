import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';
import { writeRegistry } from 'ai-sdlc-helper';

// One server and one repository for the whole file: the tests only read, and each changes a different input.
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
let base: string;
let repo: string;
let server: RunningServer;
let env: NodeJS.ProcessEnv;
const savedPath = process.env.PATH;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
const calls = (): string[] => { try { return fs.readFileSync(path.join(base, 'git-calls.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
/** The git calls that build a project context (see runContext). */
const contextCalls = (): number => calls().filter(l => l.includes('--show-toplevel')).length;
const get = (p: string): Promise<{ status: number; json: any }> => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: server.port, path: p, headers: { 'x-sdlc-token': server.token } }, r => {
    let text = '';
    r.on('data', d => { text += d; });
    r.on('end', () => { let json: unknown = null; try { json = JSON.parse(text); } catch { /* not JSON */ } res({ status: r.statusCode || 0, json }); });
  }).on('error', rej);
});
const config = (extra: object = {}) => fs.writeFileSync(path.join(repo, 'sdlc.config.json'),
  JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' }, ...extra }));

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-context-')));
  repo = path.join(base, 'shop');
  fs.mkdirSync(path.join(repo, 'Docs/backlog/one'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), '# Backlog\n\n- [ ] `one` - Feature: One\n');
  fs.writeFileSync(path.join(repo, 'Docs/backlog/one/brief.md'), '# one\n');
  config();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // A git that logs its arguments and then runs the real one: the independent count of spawns.
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(path.join(base, 'bin'));
  fs.writeFileSync(path.join(base, 'bin', 'git'), `#!/bin/sh\necho "$@" >> "${path.join(base, 'git-calls.txt')}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${path.join(base, 'bin')}:${savedPath}`;
  fs.mkdirSync(path.join(base, 'ui'));
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  env = { ...process.env, ...GIT_ENV, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), SDLC_TRACE: '0' };
  writeRegistry([{ name: 'shop', path: repo, addedAt: '2026-11-12T10:00:00' }], env);
  server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs: 60_000, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
});
afterAll(async () => {
  process.env.PATH = savedPath;
  await server.close();
});

describe('the cached project context', () => {
  test('10 requests for a run build the context once', async () => {
    expect((await get('/api/projects/shop/runs/one')).status).toBe(200);
    const afterFirst = contextCalls();
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 9; i++) expect((await get('/api/projects/shop/runs/one')).status).toBe(200);
    expect((await get('/api/projects/shop/board')).status).toBe(200);
    expect(contextCalls()).toBe(afterFirst);
  });

  test('a change to the settings file shows on the next request', async () => {
    expect((await get('/api/projects/shop/runs/one')).json.branch).toBe('sdlc/one');
    const before = contextCalls();
    config({ git: { branchPrefix: 'work/' } });
    expect((await get('/api/projects/shop/runs/one')).json.branch).toBe('work/one');
    expect(contextCalls()).toBeGreaterThan(before);
  });

  test('a change to the registry shows on the next request', async () => {
    expect((await get('/api/projects/shop/board')).json.maxParallel).toBe(2);
    writeRegistry([{ name: 'shop', path: repo, addedAt: '2026-11-12T10:00:00', overrides: { maxParallel: 5 } }], env);
    expect((await get('/api/projects/shop/board')).json.maxParallel).toBe(5);
  });

  test('a request that changes the project drops its context, whatever the files say', async () => {
    await get('/api/projects/shop/board');
    const before = contextCalls();
    await new Promise<void>((res, rej) => {
      const r = http.request({ host: '127.0.0.1', port: server.port, path: '/api/projects/shop/no-such-action', method: 'POST', headers: { 'x-sdlc-token': server.token, 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port}` } }, x => { x.resume(); x.on('end', () => res()); });
      r.on('error', rej);
      r.end('{}');
    });
    await get('/api/projects/shop/board');
    expect(contextCalls()).toBeGreaterThan(before);
  });
});
