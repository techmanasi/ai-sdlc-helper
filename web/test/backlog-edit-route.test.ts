import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';

const tick = setImmediate;
beforeEach(() => new Promise(r => tick(r)));

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const INDEX = '# Backlog\n\n- [ ] `ask-one` - Feature: Ask first\n- [!] `blk-one` - Bug: Stuck (blocked: waits)\n- [x] `fin-one` - Feature: Finished\n';

let base: string;
let repo: string;
let server: RunningServer;

const indexFile = () => path.join(repo, 'Docs/backlog/index.md');
const briefFile = (slug: string) => path.join(repo, 'Docs/backlog', slug, 'brief.md');
const read = (f: string) => fs.readFileSync(f, 'utf8');

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-edit-')));
  repo = path.join(base, 'shop');
  const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  w('sdlc.config.json', JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  w('Docs/backlog/index.md', INDEX);
  w('Docs/backlog/ask-one/brief.md', '# ask-one\n');
  w('Docs/backlog/blk-one/brief.md', '# blk-one\n');
  w('Docs/backlog/fin-one/brief.md', '# fin-one\n');
  w('Docs/backlog/stray/brief.md', '# stray\n');
  w('.gitignore', 'Docs/backlog/*/logs/\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(base, 'stub.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = {
    ...process.env, ...GIT_ENV,
    AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'),
    AI_SDLC_HELPER_PIPELINE_CMD: path.join(base, 'stub.sh'),
    SDLC_WT_BASE: path.join(base, 'wts'),
  };
  fs.mkdirSync(path.join(base, 'ui'));
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs: 100, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
});

afterEach(async () => { await server.close(); });

interface Reply { status: number; body: string; json: any }

function request(method: string, p: string, body?: unknown): Promise<Reply> {
  return new Promise((res, rej) => {
    const headers: Record<string, string> = { 'x-sdlc-token': server.token };
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: server.port, method, path: p, headers }, r => {
      let text = '';
      r.on('data', d => { text += d; });
      r.on('end', () => { let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ } res({ status: r.statusCode!, body: text, json }); });
    });
    req.on('error', rej);
    req.end(data);
  });
}
const get = (p: string) => request('GET', p);
const post = (p: string, body: unknown = {}) => request('POST', p, body);

async function until<T>(readIt: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await readIt();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

describe('editing a backlog item over HTTP', () => {
  it('reads an item for editing, saves a change, and leaves the old brief route as it was', async () => {
    const view = await get('/api/projects/shop/backlog/ask-one/edit');
    expect(view.status).toBe(200);
    expect(view.json).toEqual(expect.objectContaining({
      slug: 'ask-one', title: 'Ask first', type: 'feature', brief: '# ask-one\n', editable: true, archived: false,
    }));
    expect(view.json.hash).toMatch(/^[0-9a-f]{64}$/);

    const saved = await post('/api/projects/shop/backlog/ask-one', { title: 'Ask better', type: 'bug', brief: '# ask-one\n\nmore', hash: view.json.hash });
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual(expect.objectContaining({ ok: true, index: indexFile(), brief: briefFile('ask-one') }));
    expect(saved.json.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(read(indexFile())).toBe(INDEX.replace('Feature: Ask first', 'Bug: Ask better'));
    expect(read(briefFile('ask-one'))).toBe('# ask-one\n\nmore\n');
    expect(git(repo, 'rev-list', '--count', 'HEAD')).toBe('1');

    const old = await get('/api/projects/shop/backlog/ask-one');
    expect(old.status).toBe(200);
    expect(old.json).toEqual({ slug: 'ask-one', brief: '# ask-one\n\nmore\n' });
  });

  it('keeps a blocked item blocked; a save carrying a slug field does not rename it', async () => {
    const view = (await get('/api/projects/shop/backlog/blk-one/edit')).json;
    expect(view).toEqual(expect.objectContaining({ title: 'Stuck', type: 'bug', status: 'blocked', marker: '!' }));
    const saved = await post('/api/projects/shop/backlog/blk-one', { slug: 'renamed', title: 'Still stuck', type: 'bug', brief: '# blk-one\n', hash: view.hash });
    expect(saved.status).toBe(200);
    expect(read(indexFile())).toContain('- [!] `blk-one` - Bug: Still stuck (blocked: waits)');
    expect(fs.existsSync(path.join(repo, 'Docs/backlog/renamed'))).toBe(false);
  });

  it('a save with an old version is a 409 that carries the current hash, and writes nothing', async () => {
    const first = (await get('/api/projects/shop/backlog/ask-one/edit')).json;
    expect((await post('/api/projects/shop/backlog/ask-one', { title: 'One', type: 'feature', brief: '# ask-one\n', hash: first.hash })).status).toBe(200);
    const index = read(indexFile());
    const brief = read(briefFile('ask-one'));
    const stale = await post('/api/projects/shop/backlog/ask-one', { title: 'Two', type: 'feature', brief: '# changed\n', hash: first.hash });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatch(/changed since you opened it; reload/);
    expect(stale.json.hash).toBe((await get('/api/projects/shop/backlog/ask-one/edit')).json.hash);
    expect(read(indexFile())).toBe(index);
    expect(read(briefFile('ask-one'))).toBe(brief);
  });

  it('an unknown slug is a 404 for read and write, even with a brief.md; nothing is written', async () => {
    for (const slug of ['nope', 'stray']) {
      const r = await get(`/api/projects/shop/backlog/${slug}/edit`);
      expect(r.status).toBe(404);
      expect(r.json.error).toContain(`${slug} is not in Docs/backlog/index.md`);
      const w = await post(`/api/projects/shop/backlog/${slug}`, { title: 'x', type: 'feature', brief: 'x', hash: 'h' });
      expect(w.status).toBe(404);
    }
    expect(read(indexFile())).toBe(INDEX);
    expect(read(briefFile('stray'))).toBe('# stray\n');
  });

  it('a bad slug is a 400, as for the existing brief route', async () => {
    expect((await get('/api/projects/shop/backlog/BAD/edit')).status).toBe(400);
    expect((await post('/api/projects/shop/backlog/BAD', { title: 'x', type: 'feature', brief: 'x', hash: 'h' })).status).toBe(400);
  });

  it('invalid fields are a 400 and nothing is written', async () => {
    const { hash } = (await get('/api/projects/shop/backlog/ask-one/edit')).json;
    const bad = await post('/api/projects/shop/backlog/ask-one', { title: 'x', type: 'chore', brief: 'x', hash });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/type must be feature or bug/);
    expect((await post('/api/projects/shop/backlog/ask-one', { title: 'a\nb', type: 'feature', brief: 'x', hash })).status).toBe(400);
    expect((await post('/api/projects/shop/backlog/ask-one', { title: 'x', type: 'feature', brief: '  ', hash })).status).toBe(400);
    expect((await post('/api/projects/shop/backlog/ask-one', { title: 'x', type: 'feature', priority: 'P9', brief: 'x', hash })).status).toBe(400);
    expect((await post('/api/projects/shop/backlog/ask-one', { title: 'x', type: 'feature', brief: 'x' })).status).toBe(400);
    expect((await post('/api/projects/shop/backlog/ask-one', { title: 'x', type: 'feature', brief: 'x', hash: 42 })).status).toBe(400);
    expect(read(indexFile())).toBe(INDEX);
    expect(read(briefFile('ask-one'))).toBe('# ask-one\n');
  });

  it('a completed item reads as not editable and its save is a 400', async () => {
    const view = await get('/api/projects/shop/backlog/fin-one/edit');
    expect(view.status).toBe(200);
    expect(view.json.editable).toBe(false);
    expect(view.json.reason).toMatch(/completed or archived/);
    const w = await post('/api/projects/shop/backlog/fin-one', { title: 'x', type: 'feature', brief: 'x', hash: view.json.hash });
    expect(w.status).toBe(400);
    expect(read(indexFile())).toBe(INDEX);
  });

  it('once the run has started the item is read-only and a save is a 409; discarding makes it editable again', async () => {
    const before = (await get('/api/projects/shop/backlog/ask-one/edit')).json;
    expect((await post('/api/projects/shop/runs/ask-one/start')).json.ok).toBe(true);
    const started = await until(() => get('/api/projects/shop/backlog/ask-one/edit').then(r => r.json), v => v.editable === false);
    expect(started.reason).toMatch(/stop the run and discard it/);
    const w = await post('/api/projects/shop/backlog/ask-one', { title: 'x', type: 'feature', brief: 'x', hash: before.hash });
    expect(w.status).toBe(409);
    expect(w.json.error).toMatch(/has started/);
    expect(read(indexFile())).toBe(INDEX);
    expect(read(briefFile('ask-one'))).toBe('# ask-one\n');

    // stop whatever is left, then discard: the item is editable again
    await post('/api/projects/shop/runs/ask-one/stop');
    expect((await post('/api/projects/shop/runs/ask-one/discard')).json.ok).toBe(true);
    const again = (await get('/api/projects/shop/backlog/ask-one/edit')).json;
    expect(again.editable).toBe(true);
    expect((await post('/api/projects/shop/backlog/ask-one', { title: 'After discard', type: 'feature', brief: '# ask-one\n', hash: again.hash })).status).toBe(200);
  });
});
