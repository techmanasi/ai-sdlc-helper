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

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-flicker-')));
  repo = path.join(base, 'shop');
  fs.mkdirSync(path.join(repo, 'Docs/backlog/one'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), '# Backlog\n\n- [ ] `one` - Feature: One\n');
  fs.writeFileSync(path.join(repo, 'Docs/backlog/one/brief.md'), '# one\n');
  fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // A paused run with a worktree holding one uncommitted file: the card has change counts.
  const wt = path.join(base, 'wts', 'one');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'sdlc/one');
  fs.writeFileSync(path.join(wt, 'new.ts'), 'export {};\n');
  fs.mkdirSync(path.join(repo, '.git/sdlc-runs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git/sdlc-runs/one.json'), JSON.stringify({ slug: 'one', worktree: wt, pid: 0, started: '2026-10-19T10:00:00', state: 'exited', exit_code: '2', interrupted: false, finished: '2026-10-19T10:05:00', message: '', branch: 'sdlc/one', base: 'main' }));
  fs.mkdirSync(path.join(base, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
});
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

describe('the board stream', () => {
  test('an unchanged project gets one board event across many ticks, with the change counts in it', async () => {
    const env = { ...process.env, ...GIT_ENV, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), SDLC_TRACE: '0' };
    server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs: 100, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
    const events: any[] = [];
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port: server.port, path: '/api/events?project=shop', headers: { 'x-sdlc-token': server.token } }, res => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith('event: board')) events.push(JSON.parse(block.split('\ndata: ')[1]));
        }
      });
    });
    req.on('error', () => { /* closed */ });
    // The first board takes as long as its git calls (long on a loaded machine); then watch several more reads (100 ms apart, or as long as a build takes).
    const t0 = Date.now();
    while (!events.length && Date.now() - t0 < 40_000) await new Promise(r => setTimeout(r, 50));
    await new Promise(r => setTimeout(r, 2500));
    req.destroy();
    expect(events.length).toBe(1);
    expect(events[0].runs[0].changes).toMatchObject({ uncommitted: 1 });
  });
});
