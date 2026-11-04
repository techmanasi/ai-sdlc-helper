import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

let base: string;
let repo: string;
let server: RunningServer | null = null;

const get = (s: RunningServer, p: string): Promise<{ status: number; ms: number; body: string }> => new Promise((res, rej) => {
  const t0 = Date.now();
  http.get({ host: '127.0.0.1', port: s.port, path: p, headers: { 'x-sdlc-token': s.token } }, r => {
    let body = '';
    r.on('data', c => { body += c; });
    r.on('end', () => res({ status: r.statusCode || 0, ms: Date.now() - t0, body }));
  }).on('error', rej);
});

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-gh-')));
  repo = path.join(base, 'shop');
  const items = ['a', 'b', 'c'];
  fs.mkdirSync(path.join(repo, 'Docs/backlog'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), `# Backlog\n\n${items.map(s => `- [x] \`${s}\` - Feature: ${s}`).join('\n')}\n`);
  for (const s of items) { fs.mkdirSync(path.join(repo, 'Docs/backlog', s)); fs.writeFileSync(path.join(repo, 'Docs/backlog', s, 'brief.md'), `# ${s}\n`); }
  fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(base, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  // A gh that takes 1.5 s and says every PR is merged.
  fs.mkdirSync(path.join(base, 'bin'));
  fs.writeFileSync(path.join(base, 'bin', 'gh'), `#!/bin/sh\necho x >> "${base}/gh-calls.txt"\nsleep 1.5\necho '{"url":"https://github.com/o/r/pull/9","state":"MERGED","number":9}'\n`, { mode: 0o755 });
});
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

describe('the Completed route with a slow gh', () => {
  test('another request is served while the PR statuses are fetched, and the second Completed request does not call gh again', async () => {
    const env = { ...process.env, ...GIT_ENV, PATH: `${path.join(base, 'bin')}:${process.env.PATH}`, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), SDLC_TRACE: '0' };
    server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs: 100, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
    const slow = get(server, '/api/projects/shop/completed');
    await new Promise(r => setTimeout(r, 300)); // the gh calls are running now
    const quick = await get(server, '/api/projects');
    expect(quick.status).toBe(200);
    expect(quick.ms).toBeLessThan(1200); // a blocked loop would make this wait for the 1.5 s gh calls
    const first = await slow;
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body).completed.map((t: { slug: string }) => t.slug).sort()).toEqual(['a', 'b', 'c']);
    const calls = fs.readFileSync(path.join(base, 'gh-calls.txt'), 'utf8').split('\n').filter(Boolean).length;
    expect(calls).toBe(3);
    vi.useFakeTimers({ toFake: ['Date'] }); // a loaded machine must not age the cache past its 60 s
    vi.setSystemTime(Date.now());
    const second = await get(server, '/api/projects/shop/completed');
    vi.useRealTimers();
    expect(second.status).toBe(200);
    expect(fs.readFileSync(path.join(base, 'gh-calls.txt'), 'utf8').split('\n').filter(Boolean).length).toBe(3);
  });
});
