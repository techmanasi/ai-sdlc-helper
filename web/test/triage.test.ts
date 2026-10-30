import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// The stand-in claude. It learns the phase from the run.json the server wrote, appends its call to $TRIAGE_CALLS, prints
// stream-json, and writes the files a real agent would, as $TRIAGE_SCENARIO (re-read at every call) says.
const STUB = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const args = process.argv.slice(2);
const sc = JSON.parse(fs.readFileSync(process.env.TRIAGE_SCENARIO, 'utf8'));
const tdir = path.join(process.cwd(), 'Docs/backlog/.triage');
const runId = fs.readdirSync(tdir)[0]; const rdir = path.join(tdir, runId);
const run = JSON.parse(fs.readFileSync(path.join(rdir, 'run.json'), 'utf8'));
const phase = run.current.phase; const slug = run.current.slug || 'split';
const resumed = args.includes('--resume');
const backlog = path.join(process.cwd(), 'Docs/backlog');
fs.appendFileSync(process.env.TRIAGE_CALLS, JSON.stringify({ args, phase, slug, quick: run.quick,
  seen: { config: fs.existsSync(path.join(process.cwd(), 'sdlc.config.json')), fresh: fs.existsSync(path.join(backlog, 'fresh/brief.md')),
    index: fs.readFileSync(path.join(backlog, 'index.md'), 'utf8').includes('fresh'), other: fs.existsSync(path.join(process.cwd(), 'src/other.js')) } }) + '\\n');
const sid = 'sess-' + phase + '-' + slug;
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the backlog' }, { type: 'tool_use', name: 'Read', input: { file_path: 'Docs/backlog/index.md' } }] } }));
const wait = (sc.sleepMs || {})[slug] || 0;
setTimeout(() => {
  if (phase === 'split') {
    if (sc.badItems === 'notjson') fs.writeFileSync(path.join(rdir, 'items.json'), '{nope');
    else if (sc.badItems !== 'missing') fs.writeFileSync(path.join(rdir, 'items.json'), JSON.stringify(sc.items));
  } else {
    const item = sc.items.find(i => i.slug === slug);
    const asks = (sc.ask || []).includes(slug) && !resumed;
    if (asks && (!run.quick || sc.extraQuestionsInQuick)) {
      fs.writeFileSync(path.join(rdir, slug + '-questions.md'), '### Q1: One\\nFirst?\\n**Suggested:** yes\\n**Answer:**\\n\\n### Q2: Two\\nSecond?\\n**Suggested:** no\\n**Answer:**\\n');
    }
    if (!(asks && !run.quick) && !(sc.noBrief || []).includes(slug)) {
      fs.mkdirSync(path.join(backlog, slug), { recursive: true });
      fs.writeFileSync(path.join(backlog, slug, 'brief.md'), '# ' + slug + '\\n\\nType: ' + item.type + '\\nPriority: ' + item.priority + '\\n');
      fs.appendFileSync(path.join(backlog, 'index.md'), '- [ ] \`' + slug + '\` - ' + (item.type === 'bug' ? 'Bug' : 'Feature') + ': ' + item.title + '\\n');
    }
  }
  console.log(JSON.stringify({ type: 'result', subtype: 'success', session_id: sid }));
  process.exit((sc.exit || {})[slug] || 0);
}, wait);
`;

const ITEMS = [
  { slug: 'fix-login', type: 'bug', priority: 'P1 (high)', title: 'Login fails', summary: 'Login breaks' },
  { slug: 'add-csv', type: 'feature', priority: 'P2 (normal)', title: 'Export CSV', summary: 'CSV export' },
  { slug: 'skip-me', type: 'feature', priority: 'P3 (low)', title: 'Skip me', summary: 'not wanted' },
];

let base: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let stub: string;
let servers: RunningServer[] = [];
let server: RunningServer;
const scenarioFile = () => path.join(base, 'scenario.json');
const scenario = (s: Record<string, unknown>) => fs.writeFileSync(scenarioFile(), JSON.stringify({ items: ITEMS, ...s }));
const calls = (): any[] => (fs.existsSync(path.join(base, 'calls.log')) ? fs.readFileSync(path.join(base, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const wtBase = () => path.join(base, 'wts');

async function boot(opts: { claude?: string; cwd?: string } = {}): Promise<RunningServer> {
  const s = await startServer({ port: 0, env, cwd: opts.cwd || repo, uiDir: path.join(base, 'ui'), pollMs: 100, claude: opts.claude || stub } as any);
  servers.push(s);
  return s;
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-triage-')));
  repo = path.join(base, 'shop');
  const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  w('Docs/backlog/index.md', '# Backlog\n\n- [x] `old-item` - Feature: done before\n');
  w('Docs/backlog/old-item/brief.md', '# old-item\n');
  w('package.json', '{}');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  // uncommitted in the main working tree: the settings, an index line and its brief
  w('sdlc.config.json', JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  w('Docs/backlog/index.md', '# Backlog\n\n- [x] `old-item` - Feature: done before\n- [ ] `fresh` - Feature: not committed\n');
  w('Docs/backlog/fresh/brief.md', '# fresh\n');
  w('src/other.js', 'x\n');
  stub = path.join(base, 'claude');
  fs.writeFileSync(stub, STUB, { mode: 0o755 });
  fs.mkdirSync(path.join(base, 'ui'));
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  env = {
    ...process.env, ...GIT_ENV,
    AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), SDLC_WT_BASE: wtBase(),
    TRIAGE_SCENARIO: scenarioFile(), TRIAGE_CALLS: path.join(base, 'calls.log'),
  };
  scenario({});
  servers = [];
  server = await boot();
});

afterEach(async () => { for (const s of servers) { try { await s.close(); } catch { /* already closed */ } } });

interface Reply { status: number; json: any }
function request(method: string, p: string, o: { body?: unknown; token?: boolean; srv?: RunningServer } = {}): Promise<Reply> {
  const srv = o.srv || server;
  return new Promise((res, rej) => {
    const headers: Record<string, string> = o.token === false ? {} : { 'x-sdlc-token': srv.token };
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (data) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers }, r => {
      let body = '';
      r.on('data', d => { body += d; });
      r.on('end', () => { let json: any = null; try { json = JSON.parse(body); } catch { /* not JSON */ } res({ status: r.statusCode!, json }); });
    });
    req.on('error', rej);
    req.end(data);
  });
}
const T = '/api/projects/shop/triage';
const get = (p: string, srv?: RunningServer) => request('GET', p, { srv });
const post = (p: string, body: unknown = {}, srv?: RunningServer) => request('POST', p, { body, srv });

interface Ev { event: string; data: any }
interface Stream { events: Ev[]; closed: Promise<void>; status: Promise<number>; abort(): void }
function sse(method: string, p: string, body?: unknown, srv: RunningServer = server): Stream {
  const events: Ev[] = [];
  let buf = '';
  let closeIt!: () => void;
  const closed = new Promise<void>(r => { closeIt = r; });
  let gotStatus!: (n: number) => void;
  const status = new Promise<number>(r => { gotStatus = r; });
  const data = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { 'x-sdlc-token': srv.token, ...(data ? { 'content-type': 'application/json' } : {}) };
  const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers }, r => {
    gotStatus(r.statusCode!);
    r.setEncoding('utf8');
    r.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = block.match(/^event: (.*)$/m); const dt = block.match(/^data: (.*)$/m);
        if (ev && dt) events.push({ event: ev[1], data: JSON.parse(dt[1]) });
      }
    });
    r.on('end', closeIt); r.on('close', closeIt);
  });
  req.on('error', () => { gotStatus(0); closeIt(); });
  req.end(data);
  return { events, closed, status, abort: () => req.destroy() };
}
const names = (s: Stream) => s.events.map(e => e.event);
const of = (s: Stream, name: string) => s.events.filter(e => e.event === name);

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
    await new Promise(r => setTimeout(r, 50));
  }
}
const stateOf = async (srv?: RunningServer) => (await get(T, srv)).json.run?.state ?? null;
const waitState = (s: string, srv?: RunningServer) => until(() => stateOf(srv), v => v === s);
const waitEv = (st: Stream, name: string, n = 1) => until(() => of(st, name).length, v => v >= n);
const runId = async () => (await get(T)).json.run.runId as string;
const pointers = () => JSON.parse(fs.readFileSync(path.join(repo, '.git/sdlc-runs/triage.json'), 'utf8'));
const branches = () => git(repo, 'branch', '--list');

/** Starts an interactive run and waits for the item choice. */
async function toChoosing(body: Record<string, unknown> = {}) {
  const st = sse('POST', T, { report: 'Login fails and I want CSV export', ...body });
  await waitEv(st, 'items');
  await waitState('choosing');
  return { st, id: await runId() };
}

describe('POST /triage: bad input and conflicts', () => {
  it('an empty or whitespace-only report is 400; an unknown project 404; nothing is created', async () => {
    for (const report of ['', '   \n']) {
      const r = await post(T, { report });
      expect(r.status).toBe(400);
      expect(r.json.ok).toBe(false);
    }
    expect((await post(T, {})).status).toBe(400);
    expect((await post('/api/projects/nope/triage', { report: 'x' })).status).toBe(404);
    expect(fs.existsSync(wtBase())).toBe(false);
    expect(branches()).not.toContain('triage');
    expect(fs.existsSync(path.join(repo, '.git/sdlc-runs/triage.json'))).toBe(false);
  });

  it('a second run while one is active is 409', async () => {
    await toChoosing();
    const r = await post(T, { report: 'another' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('a triage run is already active for shop');
  });

  it('a repository with no commit is 400 with start\'s text, leaves nothing, and does not block a later run', async () => {
    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'main');
    const srv = await boot({ cwd: empty });
    const r = await request('POST', '/api/projects/empty/triage', { body: { report: 'x' }, srv });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('the repository has no commit to start the branch from');
    expect(fs.existsSync(path.join(wtBase(), 'triage-x'))).toBe(false);
    expect(fs.existsSync(wtBase()) ? fs.readdirSync(wtBase()).filter(f => f.startsWith('triage-')) : []).toEqual([]);
    expect(git(empty, 'branch', '--list')).toBe('');
    const again = await request('POST', '/api/projects/empty/triage', { body: { report: 'x' }, srv });
    expect(again.status).toBe(400);
  });
});

describe('interactive run', () => {
  it('streams started, progress and items, waits for the choice, runs the kept items in file order, then ready', async () => {
    const { st, id } = await toChoosing();
    expect(names(st).slice(0, 2)).toEqual(['started', 'text']);
    expect(of(st, 'started')[0].data).toEqual({ runId: id });
    expect(of(st, 'tool')[0].data).toEqual({ name: 'Read', summary: 'Read Docs/backlog/index.md' });
    expect(of(st, 'items')[0].data.items.map((i: any) => i.slug)).toEqual(['fix-login', 'add-csv', 'skip-me']);
    expect(names(st)).not.toContain('done');
    expect(calls().map(c => c.slug)).toEqual(['split']);

    const sel = await post(`${T}/items`, { runId: id, slugs: ['add-csv', 'fix-login'] });
    expect(sel.json).toMatchObject({ ok: true, run: { runId: id, slugs: ['fix-login', 'add-csv'] } });
    await st.closed;
    expect(of(st, 'draft').map(e => e.data.drafts.map((d: any) => d.slug))).toEqual([['fix-login'], ['add-csv']]);
    expect(of(st, 'draft')[0].data.drafts[0]).toMatchObject({ slug: 'fix-login', type: 'bug', priority: 'P1 (high)', title: 'Login fails' });
    expect(of(st, 'draft')[0].data.drafts[0].brief).toContain('Type: bug');
    expect(st.events.at(-1)).toEqual({ event: 'done', data: { code: 0 } });
    expect(calls().map(c => c.slug)).toEqual(['split', 'fix-login', 'add-csv']);
    expect((await get(T)).json.run).toMatchObject({ state: 'ready', slugs: ['fix-login', 'add-csv'], drafts: [{ slug: 'fix-login', status: 'pending' }, { slug: 'add-csv', status: 'pending' }] });
  });

  it('items: a slug that was not proposed is 400, an unknown runId 404, a run not choosing 409; nothing changes', async () => {
    const { id } = await toChoosing();
    expect((await post(`${T}/items`, { runId: id, slugs: 'fix-login' })).status).toBe(400);
    expect((await post(`${T}/items`, { runId: id, slugs: ['nope'] })).status).toBe(400);
    expect((await post(`${T}/items`, { runId: 'zzz', slugs: [] })).status).toBe(404);
    expect(await stateOf()).toBe('choosing');
    await post(`${T}/items`, { runId: id, slugs: ['fix-login'] });
    await waitState('ready');
    expect((await post(`${T}/items`, { runId: id, slugs: ['fix-login'] })).status).toBe(409);
  });

  it('the worktree, branch, run folder and registry pointer are as specified; nothing is committed', async () => {
    const { st, id } = await toChoosing();
    const wt = path.join(wtBase(), `triage-${id}`);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(fs.existsSync(path.join(wt, '.git'))).toBe(true);
    expect(branches()).toContain(`sdlc/triage-${id}`);
    const dir = path.join(wt, 'Docs/backlog/.triage', id);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').trim()).toBe('*');
    expect(fs.readFileSync(path.join(dir, 'report.md'), 'utf8')).toBe('Login fails and I want CSV export');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))).toMatchObject({ runId: id, state: 'choosing', quick: false });
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).event)).toEqual(expect.arrayContaining(['started', 'items']));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8'))).toHaveLength(3);
    expect(git(repo, 'rev-list', '--count', `sdlc/triage-${id}`)).toBe(git(repo, 'rev-list', '--count', 'main'));
    expect(git(wt, 'status', '--porcelain')).not.toContain('.triage');
    expect(pointers()[repo]).toEqual({ runId: id, worktree: wt });
    st.abort();
  });

  it('before the split runs, the worktree has the uncommitted config, index and briefs and nothing else', async () => {
    const { st } = await toChoosing();
    expect(calls()[0].seen).toEqual({ config: true, fresh: true, index: true, other: false });
    st.abort();
  });

  it('the sessions run with the stream-json flags, accept-edits and the allowed tools', async () => {
    const { st } = await toChoosing();
    const a = calls()[0].args as string[];
    expect(a[0]).toBe('-p');
    expect(a).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']));
    expect(a.slice(a.indexOf('--allowedTools') + 1)).toEqual(expect.arrayContaining(['Read', 'Write']));
    expect(a).not.toContain('--resume');
    st.abort();
  });

  it('a model in the request is passed through', async () => {
    const st = sse('POST', T, { report: 'x', model: 'haiku' });
    await waitEv(st, 'items');
    const a = calls()[0].args as string[];
    expect(a[a.indexOf('--model') + 1]).toBe('haiku');
    st.abort();
  });
});

describe('questions', () => {
  it('an item that asks pauses in waiting; answers resume the same session and the draft follows on the same stream', async () => {
    scenario({ ask: ['fix-login'] });
    const { st, id } = await toChoosing();
    await post(`${T}/items`, { runId: id, slugs: ['fix-login'] });
    await waitEv(st, 'question');
    await waitState('waiting');
    const q = of(st, 'question')[0].data;
    expect(q.slug).toBe('fix-login');
    expect(q.questions).toEqual([{ id: 'Q1', text: expect.stringContaining('First?'), suggested: 'yes' }, { id: 'Q2', text: expect.stringContaining('Second?'), suggested: 'no' }]);
    expect(names(st)).not.toContain('draft');
    expect(names(st)).not.toContain('done');

    const half = await post(`${T}/answer`, { runId: id, slug: 'fix-login', answers: { Q1: 'yes' } });
    expect(half.status).toBe(400);
    expect(await stateOf()).toBe('waiting');
    expect((await post(`${T}/answer`, { runId: id, slug: 'nope', answers: { Q1: 'a', Q2: 'b' } })).status).toBe(404);

    const ok = await post(`${T}/answer`, { runId: id, slug: 'fix-login', answers: { Q1: 'accept', Q2: 'no thanks' } });
    expect(ok.json.ok).toBe(true);
    const file = path.join(wtBase(), `triage-${id}`, 'Docs/backlog/.triage', id, 'fix-login-questions.md');
    expect(fs.readFileSync(file, 'utf8')).toMatch(/\*\*Answer:\*\* accept[\s\S]*\*\*Answer:\*\* no thanks/);
    await st.closed;
    expect(of(st, 'draft')).toHaveLength(1);
    const resumed = calls().at(-1).args as string[];
    expect(resumed.slice(resumed.indexOf('--resume'), resumed.indexOf('--resume') + 2)).toEqual(['--resume', 'sess-item-fix-login']);
    expect(await stateOf()).toBe('ready');
    expect((await post(`${T}/answer`, { runId: id, slug: 'fix-login', answers: { Q1: 'a', Q2: 'b' } })).status).toBe(409);
  });

  it('a quick run skips the choice, never sends a question and drafts every proposed item', async () => {
    scenario({ ask: ['fix-login'], extraQuestionsInQuick: true });
    const st = sse('POST', T, { report: 'x', quick: true });
    await st.closed;
    expect(names(st)).toContain('items');
    expect(names(st)).not.toContain('question');
    expect(of(st, 'draft').map(e => e.data.drafts[0].slug)).toEqual(['fix-login', 'add-csv', 'skip-me']);
    expect(st.events.at(-1)).toEqual({ event: 'done', data: { code: 0 } });
    expect(await stateOf()).toBe('ready');
    expect(calls().filter(c => c.slug !== 'split').every(c => c.quick === true)).toBe(true);
  });
});

describe('finishing without drafts', () => {
  async function gone() {
    await until(() => stateOf(), v => v === null);
    expect(fs.existsSync(wtBase()) ? fs.readdirSync(wtBase()).filter(f => f.startsWith('triage-')) : []).toEqual([]);
    expect(branches()).not.toContain('triage-');
    expect(fs.existsSync(path.join(repo, '.git/sdlc-runs/triage.json')) ? pointers()[repo] : undefined).toBeUndefined();
  }
  it('no items proposed: done 0 and everything removed', async () => {
    scenario({ items: [] });
    const st = sse('POST', T, { report: 'a duplicate' });
    await st.closed;
    expect(st.events.at(-1)).toEqual({ event: 'done', data: { code: 0 } });
    await gone();
  });
  it('no items kept: done 0 and everything removed', async () => {
    const { st, id } = await toChoosing();
    expect((await post(`${T}/items`, { runId: id, slugs: [] })).json.ok).toBe(true);
    await st.closed;
    expect(st.events.at(-1)).toEqual({ event: 'done', data: { code: 0 } });
    expect(calls().map(c => c.slug)).toEqual(['split']);
    await gone();
    expect((await post(`${T}/items`, { runId: id, slugs: [] })).status).toBe(404);
  });
});

describe('saved and skipped drafts', () => {
  it('marks work while later items run; a second mark 409; unknown slug 404; marking all ends the run and cleans up', async () => {
    scenario({ sleepMs: { 'add-csv': 1500 } });
    const { st, id } = await toChoosing();
    await post(`${T}/items`, { runId: id, slugs: ['fix-login', 'add-csv'] });
    await waitEv(st, 'draft');
    const saved = await post(`${T}/saved`, { runId: id, slug: 'fix-login' });
    expect(saved.json).toMatchObject({ ok: true, run: { drafts: [{ slug: 'fix-login', status: 'saved' }] } });
    expect(of(st, 'marked')[0].data).toEqual({ slug: 'fix-login', status: 'saved' });
    expect(await stateOf()).toBe('running');
    expect((await post(`${T}/saved`, { runId: id, slug: 'fix-login' })).status).toBe(409);
    expect((await post(`${T}/skip`, { runId: id, slug: 'fix-login' })).status).toBe(409);
    expect((await post(`${T}/saved`, { runId: id, slug: 'nope' })).status).toBe(404);
    expect((await post(`${T}/saved`, { runId: 'zzz', slug: 'fix-login' })).status).toBe(404);
    await st.closed;
    expect(await stateOf()).toBe('ready');
    const skipped = await post(`${T}/skip`, { runId: id, slug: 'add-csv' });
    expect(skipped.json.ok).toBe(true);
    await until(() => stateOf(), v => v === null);
    expect(fs.existsSync(path.join(wtBase(), `triage-${id}`))).toBe(false);
    expect((await post(`${T}/saved`, { runId: id, slug: 'add-csv' })).status).toBe(404);
  });
});

describe('reconnecting', () => {
  it('replays every stored event including an earlier done, then streams new ones; unknown runId is 404', async () => {
    const { id } = await toChoosing();
    await post(`${T}/items`, { runId: id, slugs: ['fix-login'] });
    await waitState('ready');
    const late = sse('GET', `${T}/events?runId=${id}`);
    await waitEv(late, 'done');
    expect(names(late)).toEqual(expect.arrayContaining(['started', 'items', 'draft', 'done']));
    const stored = fs.readFileSync(path.join(wtBase(), `triage-${id}`, 'Docs/backlog/.triage', id, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(late.events.map(e => e.event)).toEqual(stored.map(e => e.event));
    await post(`${T}/skip`, { runId: id, slug: 'fix-login' });
    await waitEv(late, 'marked');
    late.abort();
    expect(await sse('GET', `${T}/events?runId=zzz`).status).toBe(404);
    expect(await sse('GET', '/api/projects/nope/triage/events?runId=x').status).toBe(404);
  });

  it('two viewers both receive every new event', async () => {
    scenario({ sleepMs: { split: 400, 'fix-login': 400 } });
    const first = sse('POST', T, { report: 'x' });
    await waitEv(first, 'started');
    const id = of(first, 'started')[0].data.runId;
    const a = sse('GET', `${T}/events?runId=${id}`);
    const b = sse('GET', `${T}/events?runId=${id}`);
    await waitEv(a, 'items'); await waitEv(b, 'items');
    await post(`${T}/items`, { runId: id, slugs: ['fix-login'] });
    await waitEv(a, 'done'); await waitEv(b, 'done');
    await a.closed; await b.closed;
    expect(of(a, 'draft')).toHaveLength(1);
    expect(of(b, 'draft')).toHaveLength(1);
  });

  it('GET /triage is null when there is no run', async () => {
    expect((await get(T)).json).toEqual({ run: null });
    expect((await get('/api/projects/nope/triage')).status).toBe(404);
  });

  it('closing the client stream does not stop the agent', async () => {
    scenario({ sleepMs: { split: 500 } });
    const st = sse('POST', T, { report: 'x' });
    await waitEv(st, 'started');
    const id = of(st, 'started')[0].data.runId;
    st.abort();
    await waitState('choosing');
    const stored = fs.readFileSync(path.join(wtBase(), `triage-${id}`, 'Docs/backlog/.triage', id, 'events.jsonl'), 'utf8');
    expect(stored).toContain('"event":"items"');
  });
});

describe('stop, resume and discard', () => {
  it('stop kills the agent, sends done 130, keeps the worktree; stop in any other state is 409', async () => {
    scenario({ sleepMs: { split: 30000 } });
    const st = sse('POST', T, { report: 'x' });
    await waitEv(st, 'started');
    const id = of(st, 'started')[0].data.runId;
    const dir = path.join(wtBase(), `triage-${id}`);
    const pid = (await until(() => JSON.parse(fs.readFileSync(path.join(dir, 'Docs/backlog/.triage', id, 'run.json'), 'utf8')), r => r.pid > 0)).pid;
    const r = await post(`${T}/stop`, { runId: id });
    expect(r.json).toMatchObject({ ok: true, run: { state: 'stopped' } });
    expect(st.events.at(-1)).toEqual({ event: 'done', data: { code: 130 } });
    await until(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, alive => !alive);
    expect(fs.existsSync(dir)).toBe(true);
    const again = await post(`${T}/stop`, { runId: id });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe(`run ${id} is stopped, not running`);
    expect((await post(`${T}/stop`, { runId: 'zzz' })).status).toBe(404);
  });

  it('resume from stopped continues the session with --resume; from any other state it is 409', async () => {
    scenario({ sleepMs: { split: 30000 } });
    const st = sse('POST', T, { report: 'x' });
    await waitEv(st, 'started');
    const id = of(st, 'started')[0].data.runId;
    await until(() => calls().length, n => n === 1);
    await until(async () => (await get(T)).json.run.state, v => v === 'running');
    expect((await post(`${T}/resume`, { runId: id })).status).toBe(409);
    await until(() => fs.readFileSync(path.join(wtBase(), `triage-${id}`, 'Docs/backlog/.triage', id, 'run.json'), 'utf8'), t => t.includes('sess-split-split'));
    await post(`${T}/stop`, { runId: id });
    scenario({});
    const r = await post(`${T}/resume`, { runId: id });
    expect(r.json).toMatchObject({ ok: true, run: { runId: id } });
    const a = calls().at(-1).args as string[];
    expect(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2)).toEqual(['--resume', 'sess-split-split']);
    await waitState('choosing');
    expect((await post(`${T}/resume`, { runId: id })).status).toBe(409);
    expect((await post(`${T}/resume`, { runId: 'zzz' })).status).toBe(404);
  });

  it('discard removes worktree, branch and pointer from any state, and a new run is then allowed', async () => {
    const { st, id } = await toChoosing();
    const r = await post(`${T}/discard`, { runId: id });
    expect(r.json).toEqual({ ok: true });
    await st.closed;
    expect(fs.existsSync(path.join(wtBase(), `triage-${id}`))).toBe(false);
    expect(branches()).not.toContain(`triage-${id}`);
    expect(pointers()[repo]).toBeUndefined();
    expect((await post(`${T}/discard`, { runId: id })).status).toBe(404);
    expect((await get(T)).json).toEqual({ run: null });
    const next = sse('POST', T, { report: 'again' });
    expect(await next.status).toBe(200);
    next.abort();
  });

  it('discard kills a running agent', async () => {
    scenario({ sleepMs: { split: 30000 } });
    const st = sse('POST', T, { report: 'x' });
    await waitEv(st, 'started');
    const id = of(st, 'started')[0].data.runId;
    const rj = path.join(wtBase(), `triage-${id}`, 'Docs/backlog/.triage', id, 'run.json');
    const pid = (await until(() => JSON.parse(fs.readFileSync(rj, 'utf8')), r => r.pid > 0)).pid;
    expect((await post(`${T}/discard`, { runId: id })).json.ok).toBe(true);
    await until(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, alive => !alive);
  });
});

describe('session failures', () => {
  it('a missing claude: error, done 127, failed', async () => {
    const srv = await boot({ claude: path.join(base, 'no-such-claude') });
    const st = sse('POST', T, { report: 'x' }, srv);
    await st.closed;
    expect(of(st, 'error')[0].data.message).toBe('claude was not found on PATH');
    expect(st.events.at(-1)).toEqual({ event: 'done', data: { code: 127 } });
    expect(await stateOf(srv)).toBe('failed');
  });

  it('a non-zero exit: error and done with that code; resume continues and can finish', async () => {
    scenario({ exit: { split: 3 } });
    const st = sse('POST', T, { report: 'x' });
    await st.closed;
    expect(names(st)).toContain('error');
    expect(st.events.at(-1)).toEqual({ event: 'done', data: { code: 3 } });
    expect(await stateOf()).toBe('failed');
    scenario({});
    const id = await runId();
    expect((await post(`${T}/resume`, { runId: id })).json.ok).toBe(true);
    await waitState('choosing');
    const a = calls().at(-1).args as string[];
    expect(a).toContain('--resume');
  });

  it('bad items.json (not JSON, or missing): error names the file, done 1', async () => {
    for (const badItems of ['notjson', 'missing']) {
      scenario({ badItems });
      const st = sse('POST', T, { report: 'x' });
      await st.closed;
      expect(of(st, 'error')[0].data.message).toContain('items.json');
      expect(st.events.at(-1)).toEqual({ event: 'done', data: { code: 1 } });
      expect(await stateOf()).toBe('failed');
      await post(`${T}/discard`, { runId: await runId() });
    }
  });

  it('a missing brief fails that item, starts no later item, and keeps earlier drafts markable', async () => {
    scenario({ noBrief: ['add-csv'] });
    const st = sse('POST', T, { report: 'x', quick: true });
    await st.closed;
    expect(of(st, 'draft').map(e => e.data.drafts[0].slug)).toEqual(['fix-login']);
    expect(of(st, 'error')[0].data.message).toMatch(/add-csv.*brief\.md/);
    expect(st.events.at(-1)).toEqual({ event: 'done', data: { code: 1 } });
    expect(calls().map(c => c.slug)).toEqual(['split', 'fix-login', 'add-csv']);
    expect(await stateOf()).toBe('failed');
    expect((await post(`${T}/saved`, { runId: await runId(), slug: 'fix-login' })).json.ok).toBe(true);
  });
});

describe('server restart', () => {
  function plant(root: string, id: string, state: string, pid: number) {
    const wt = path.join(wtBase(), `triage-${id}`);
    const dir = path.join(wt, 'Docs/backlog/.triage', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: id, state, quick: false, worktree: wt, branch: `sdlc/triage-${id}`, backlogDir: 'Docs/backlog', pid, current: { phase: 'split' }, sessions: {}, items: [], kept: [], drafts: {}, created: '', updated: '' }));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    const file = path.join(root, '.git/sdlc-runs/triage.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ [root]: { runId: id, worktree: wt } }));
  }
  it('a running run with a dead pid becomes interrupted; a waiting run stays waiting', async () => {
    await server.close();
    plant(repo, 'old-1', 'running', 999999);
    const a = await boot();
    expect((await get(T, a)).json.run).toMatchObject({ runId: 'old-1', state: 'interrupted' });
    await a.close();
    plant(repo, 'old-2', 'waiting', 999999);
    const b = await boot();
    expect((await get(T, b)).json.run).toMatchObject({ runId: 'old-2', state: 'waiting' });
  });
  it('a pointer whose worktree is gone is dropped', async () => {
    await server.close();
    plant(repo, 'old-3', 'choosing', 0);
    fs.rmSync(path.join(wtBase(), 'triage-old-3'), { recursive: true });
    const a = await boot();
    expect((await get(T, a)).json).toEqual({ run: null });
    expect(pointers()[repo]).toBeUndefined();
  });
});

describe('authentication', () => {
  it('every triage route is 401 without the token', async () => {
    for (const p of ['', '/events?runId=x']) expect((await request('GET', T + p, { token: false })).status).toBe(401);
    for (const a of ['', '/items', '/answer', '/saved', '/skip', '/stop', '/resume', '/discard']) {
      expect((await request('POST', T + a, { body: { report: 'x', runId: 'x' }, token: false })).status).toBe(401);
    }
  });
});
