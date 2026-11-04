import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-parts-')));
  repo = path.join(base, 'shop');
  fs.mkdirSync(path.join(repo, 'Docs/backlog/one'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), '# Backlog\n\n- [ ] `one` - Feature: One\n');
  fs.writeFileSync(path.join(repo, 'Docs/backlog/one/brief.md'), '# one\n');
  fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(base, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
});
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

describe('the run route and its parts', () => {
  test('?parts takes live, tail and git; an unknown part is a 400; ?refresh=1 is accepted', async () => {
    const env = { ...process.env, ...GIT_ENV, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), SDLC_TRACE: '0' };
    server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs: 100, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
    const full = await get(server, '/api/projects/shop/runs/one');
    expect(full.status).toBe(200);
    expect(JSON.parse(full.body)).toHaveProperty('gitAgeMs');
    for (const q of ['parts=live', 'parts=live,tail', 'parts=git', 'refresh=1', 'parts=live&refresh=1']) {
      expect((await get(server, `/api/projects/shop/runs/one?${q}`)).status, q).toBe(200);
    }
    const bad = await get(server, '/api/projects/shop/runs/one?parts=live,everything');
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toContain('parts must be some of');
  });
});
