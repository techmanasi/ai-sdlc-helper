import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

let base: string;
let repo: string;
let logs: string;
let server: RunningServer | null = null;
const opened: Array<{ close(): void }> = [];
const children: ChildProcess[] = [];

interface Ev { event: string; data: any; at: number }
/** An SSE client: every event with its arrival time. */
function sse(s: RunningServer, p = '/api/projects/shop/runs/one/events') {
  const events: Ev[] = [];
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port: s.port, path: p, headers: { 'x-sdlc-token': s.token } }, res => {
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data), at: Date.now() });
      }
    });
  });
  req.on('error', () => { /* closed */ });
  const c = {
    events,
    of: (name: string) => events.filter(e => e.event === name),
    close: () => req.destroy(),
    async until(f: () => boolean, ms = 4000): Promise<void> {
      const t0 = Date.now();
      while (!f()) { if (Date.now() - t0 > ms) throw new Error(`timed out; saw ${events.map(e => e.event).join(',')}`); await new Promise(r => setTimeout(r, 15)); }
    },
  };
  opened.push(c);
  return c;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const writeStatus = (o: object) => fs.writeFileSync(path.join(logs, 'status.json'), JSON.stringify({ stage: 'Spec', attempt: '1', ...o }));

async function start(stream: object = {}): Promise<RunningServer> {
  const env = { ...process.env, ...GIT_ENV, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), SDLC_TRACE: '0' };
  server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs: 100, cli: ['/bin/sh', '-c', 'exit 3', 'sh'], stream: { debounceMs: 30, tickMs: 600, pingMs: 200, tailMs: 300, ...stream } });
  return server;
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-stream-')));
  repo = path.join(base, 'shop');
  logs = path.join(repo, 'Docs/backlog/one/logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), '# Backlog\n\n- [ ] `one` - Feature: One\n');
  fs.writeFileSync(path.join(repo, 'Docs/backlog/one/brief.md'), '# one\n');
  fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'Docs/backlog/*/logs/\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(base, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  writeStatus({ state: 'paused' });
  fs.writeFileSync(path.join(logs, 'run.out'), 'first line\n');
});
afterEach(async () => {
  for (const c of opened.splice(0)) c.close();
  for (const c of children.splice(0)) c.kill('SIGKILL');
  if (server) await server.close();
  server = null;
});

describe('the per-run stream', () => {
  test('a snapshot at once, then a status.json write reaches the client as a run event within a second', async () => {
    const s = await start();
    const c = sse(s);
    await c.until(() => c.of('snapshot').length === 1);
    const snap = c.of('snapshot')[0].data;
    expect(snap.slug).toBe('one');
    expect(snap.stage).toBe('Spec');
    expect(snap.tail).toEqual(['first line']);
    const t0 = Date.now();
    writeStatus({ state: 'paused', stage: 'Plan' });
    await c.until(() => c.of('run').length >= 1);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(c.of('run')[0].data.stage).toBe('Plan');
    expect(c.of('run')[0].data.tail).toEqual([]); // a run event carries the live part; the page keeps its tail
  });

  test('a ping event arrives on a timer (a named event the page can listen for), and a quiet run sends nothing else', async () => {
    const s = await start({ tickMs: 5000 });
    const c = sse(s);
    await c.until(() => c.of('ping').length >= 3, 3000);
    await sleep(100);
    expect(c.events.filter(e => e.event !== 'ping' && e.event !== 'snapshot')).toEqual([]);
    expect(c.of('ping').map(e => e.data.n).slice(0, 3)).toEqual([1, 2, 3]);
  });

  test('a burst of run.out writes is throttled, and a quiet file sends no tail', async () => {
    const s = await start({ tickMs: 5000 });
    const c = sse(s);
    await c.until(() => c.of('snapshot').length === 1);
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) { fs.appendFileSync(path.join(logs, 'run.out'), `line ${i}\n`); await sleep(15); }
    const burstMs = Date.now() - t0;
    await c.until(() => c.of('tail').some(e => e.data.tail.includes('line 39')), 3000);
    // at most one push per throttle window (300 ms), plus the first
    expect(c.of('tail').length).toBeLessThanOrEqual(Math.ceil(burstMs / 300) + 2);
    expect(c.of('tail').length).toBeLessThan(40);
    const n = c.of('tail').length;
    await sleep(800);
    expect(c.of('tail').length).toBe(n);
  });

  test('the tick finds a change whose watch event never led to a rebuild', async () => {
    const s = await start({ debounceMs: 60_000, tickMs: 400 }); // the watch path is too slow to matter: only the tick can deliver
    const c = sse(s);
    await c.until(() => c.of('snapshot').length === 1);
    writeStatus({ state: 'paused', stage: 'Review' });
    await c.until(() => c.of('run').length >= 1, 3000);
    expect(c.of('run')[0].data.stage).toBe('Review');
  });

  test('a killed process shows as stopped within the tick', async () => {
    const child = spawn('sleep', ['60']);
    children.push(child);
    writeStatus({ state: 'running', pid: child.pid, stage: 'Implement' });
    const s = await start({ tickMs: 400 });
    const c = sse(s);
    await c.until(() => c.of('snapshot').length === 1);
    expect(c.of('snapshot')[0].data.state).toBe('running');
    child.kill('SIGKILL');
    await c.until(() => c.of('run').some(e => e.data.state === 'stopped'), 3000);
  });

  test('two pages share one stream and one set of watchers; the stream stops with the last page; a late page gets a snapshot at once', async () => {
    const s = await start({ tickMs: 5000 });
    const a = sse(s);
    await a.until(() => a.of('snapshot').length === 1);
    const one = s.streamStats();
    const b = sse(s);
    await b.until(() => b.of('snapshot').length === 1);
    const two = s.streamStats();
    expect(Object.keys(two)).toEqual(['shop/one']);
    expect(two['shop/one'].clients).toBe(2);
    expect(two['shop/one'].watched).toBe(one['shop/one'].watched);
    a.close();
    await sleep(100);
    expect(s.streamStats()['shop/one'].clients).toBe(1);
    b.close();
    await sleep(100);
    expect(s.streamStats()).toEqual({});
    const t0 = Date.now();
    const late = sse(s);
    await late.until(() => late.of('snapshot').length === 1);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  test('a bad slug is a 400 and an unknown project a 404', async () => {
    const s = await start();
    const code = (p: string) => new Promise<number>(res => { http.get({ host: '127.0.0.1', port: s.port, path: p, headers: { 'x-sdlc-token': s.token } }, r => { r.resume(); res(r.statusCode || 0); }); });
    expect(await code('/api/projects/shop/runs/Bad%20Slug/events')).toBe(400);
    expect(await code('/api/projects/nope/runs/one/events')).toBe(404);
  });
});
