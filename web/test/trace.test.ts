import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';
import type { TraceLine } from 'ai-sdlc-helper';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

let base: string;
let repo: string;
let server: RunningServer | null = null;
let savedPath: string | undefined;

/** A git that logs one line per call and then runs the real one: the independent count of spawns. */
function countingGit(): string {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho x >> "${path.join(base, 'git-calls.txt')}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return bin;
}
const calls = (): number => { try { return fs.readFileSync(path.join(base, 'git-calls.txt'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

async function start(extraEnv: NodeJS.ProcessEnv = {}, config: object = {}): Promise<RunningServer> {
  fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' }, ...config }));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'config');
  fs.mkdirSync(path.join(base, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  const env = { ...process.env, ...GIT_ENV, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), ...extraEnv };
  server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs: 100, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
  return server;
}

const get = (s: RunningServer, p: string): Promise<number> => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: s.port, path: p, headers: { 'x-sdlc-token': s.token } }, r => { r.resume(); r.on('end', () => res(r.statusCode || 0)); }).on('error', rej);
});

const traceFile = () => path.join(base, 'config', 'ui-trace.jsonl');
const lines = (): TraceLine[] => (fs.existsSync(traceFile()) ? fs.readFileSync(traceFile(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-trace-')));
  repo = path.join(base, 'shop');
  fs.mkdirSync(path.join(repo, 'Docs/backlog/one'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), '# Backlog\n\n- [ ] `one` - Feature: One\n');
  fs.writeFileSync(path.join(repo, 'Docs/backlog/one/brief.md'), '# one\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'Docs/backlog/*/logs/\n');
  git(repo, 'init', '-q', '-b', 'main');
  savedPath = process.env.PATH;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  if (server) await server.close();
  server = null;
});

describe('the trace of the UI server', () => {
  test('one request for a run writes as many spawn:git lines as the counting git sees, and a request line', async () => {
    const bin = countingGit();
    process.env.PATH = `${bin}:${savedPath}`;
    const s = await start();
    const settle = () => new Promise(r => setTimeout(r, 1300)); // the trace is written once a second
    await settle();
    const callsBefore = calls();
    const spawnsBefore = lines().filter(l => l.action === 'spawn:git').length;
    expect(await get(s, '/api/projects/shop/runs/one')).toBe(200);
    await settle();
    const seen = calls() - callsBefore;
    const got = lines();
    expect(seen).toBeGreaterThan(0);
    expect(got.filter(l => l.action === 'spawn:git').length - spawnsBefore).toBe(seen);
    const req = got.filter(l => l.action === 'request');
    expect(req).toHaveLength(1);
    expect(req[0].why).toBe('GET /api/projects/:project/runs/:slug');
    expect(req[0].run).toBe('one');
    expect(req[0].code).toBe(200);
  });

  test('the board stream traces its rebuilds with whether they changed anything', async () => {
    const s = await start();
    await new Promise<void>((res, rej) => {
      const req = http.get({ host: '127.0.0.1', port: s.port, path: '/api/events?project=shop', headers: { 'x-sdlc-token': s.token } }, r => {
        let n = 0;
        r.on('data', () => { if (++n >= 1) setTimeout(() => { req.destroy(); res(); }, 500); });
      });
      req.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') rej(e); });
    });
    await s.close();
    server = null;
    const rebuilds = lines().filter(l => l.action === 'timer:board-rebuild');
    expect(rebuilds.length).toBeGreaterThanOrEqual(2);
    expect(rebuilds[0].changed).toBe(true);
    expect(rebuilds.slice(1).every(l => l.changed === false)).toBe(true);
  });

  test('SDLC_TRACE=0 writes no file', async () => {
    const s = await start({ SDLC_TRACE: '0' });
    await get(s, '/api/projects/shop/runs/one');
    await s.close();
    server = null;
    expect(fs.existsSync(traceFile())).toBe(false);
  });

  test('trace.enabled false in sdlc.config.json writes no file', async () => {
    const s = await start({}, { trace: { enabled: false } });
    await get(s, '/api/projects/shop/runs/one');
    await s.close();
    server = null;
    expect(fs.existsSync(traceFile())).toBe(false);
  });
});
