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

// The stand-in pipeline. ask-*: writes two questions and pauses, then finishes once they are answered. perm-*: pauses on
// a refused command at Plan, then finishes when started again from Plan. Every run appends its arguments and MODEL_PLAN.
const STUB = `#!/bin/sh
slug="$1"; shift
echo "$slug $* model=\${MODEL_PLAN:-}" >> "$RAN_FILE"
d="Docs/backlog/$slug"; mkdir -p "$d/logs"
case "$slug" in
  ask-*)
    if [ -f "$d/questions.md" ] && [ "$(grep -c '^\\*\\*Answer:\\*\\* .' "$d/questions.md")" = 2 ]; then
      rm "$d/questions.md"; printf '{"state":"done","stage":"Commit"}' > "$d/logs/status.json"; exit 0
    fi
    printf '### Q1: One\\nFirst?\\n**Suggested:** yes\\n**Answer:**\\n\\n### Q2: Two\\nSecond?\\n**Suggested:** no\\n**Answer:**\\n' > "$d/questions.md"
    printf '{"state":"paused","stage":"Spec"}' > "$d/logs/status.json"; exit 2 ;;
  perm-*)
    if [ "$1" = "--from" ] && [ "$2" = "plan" ]; then exit 0; fi
    printf '{"pending":[{"stage":"plan","tool":"Bash","detail":"psql -c 1","rule":"Bash(psql:*)","protected":false}],"allow":[],"bypass":[],"denied":[]}' > "$d/logs/permissions.json"
    printf '{"state":"paused","stage":"Plan"}' > "$d/logs/status.json"; exit 2 ;;
esac
exit 0
`;

let base: string;
let repo: string;
let env: NodeJS.ProcessEnv;
let server: RunningServer;

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-')));
  repo = path.join(base, 'shop');
  const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  w('sdlc.config.json', JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  w('Docs/backlog/index.md', '# Backlog\n\n- [ ] `ask-one` - Feature: Ask first\n- [ ] `perm-one` - Feature: Needs a command\n');
  w('Docs/backlog/ask-one/brief.md', '# ask-one\n');
  w('Docs/backlog/perm-one/brief.md', '# perm-one\n');
  w('.gitignore', 'Docs/backlog/*/logs/\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(base, 'stub.sh'), STUB, { mode: 0o755 });
  env = {
    ...process.env, ...GIT_ENV,
    AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'),
    AI_SDLC_HELPER_PIPELINE_CMD: path.join(base, 'stub.sh'),
    SDLC_WT_BASE: path.join(base, 'wts'),
    RAN_FILE: path.join(base, 'ran.txt'),
  };
  fs.mkdirSync(path.join(base, 'ui'));
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs: 100, cli: ['/bin/sh', '-c', 'echo "$@"; exit 3', 'sh'] });
});

afterEach(async () => { await server.close(); });

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string; json: any }

/** One request to the server, with the token unless `token: false`. */
function request(method: string, p: string, o: { body?: unknown; headers?: Record<string, string>; token?: boolean } = {}): Promise<Reply> {
  return new Promise((res, rej) => {
    const headers: Record<string, string> = { ...(o.token === false ? {} : { 'x-sdlc-token': server.token }), ...o.headers };
    const data = o.body === undefined ? undefined : JSON.stringify(o.body);
    if (data && !headers['content-type']) headers['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port: server.port, method, path: p, headers }, r => {
      let body = '';
      r.on('data', d => { body += d; });
      r.on('end', () => { let json: any = null; try { json = JSON.parse(body); } catch { /* not JSON */ } res({ status: r.statusCode!, headers: r.headers, body, json }); });
    });
    req.on('error', rej);
    req.end(data);
  });
}
const get = (p: string) => request('GET', p);
const post = (p: string, body: unknown = {}) => request('POST', p, { body });

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v)}`);
    await new Promise(r => setTimeout(r, 100));
  }
}
const run = (slug: string) => get(`/api/projects/shop/runs/${slug}`).then(r => r.json);

describe('who may talk to the server', () => {
  test('without the token every request is refused, the API and the app alike', async () => {
    expect((await request('GET', '/api/session', { token: false })).status).toBe(401);
    expect((await request('GET', '/', { token: false })).status).toBe(401);
  });

  test('the opening URL turns the token into a cookie, which then signs requests in', async () => {
    const wrong = await request('GET', '/?t=nope', { token: false });
    expect(wrong.status).toBe(401);
    const open = await request('GET', `/?t=${server.token}`, { token: false });
    expect(open.status).toBe(302);
    const cookie = String(open.headers['set-cookie']).split(';')[0];
    expect(String(open.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    expect((await request('GET', '/api/session', { token: false, headers: { cookie } })).status).toBe(200);
  });

  test('a request naming another host is refused (DNS rebinding)', async () => {
    expect((await request('GET', '/api/session', { headers: { host: `evil.example:${server.port}` } })).status).toBe(421);
  });

  test('a change sent from another site, or not as JSON, is refused', async () => {
    expect((await request('POST', '/api/projects/shop/runs/ask-one/stop', { body: {}, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await request('POST', '/api/projects/shop/runs/ask-one/stop', { body: {}, headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await request('POST', '/api/projects/shop/runs/ask-one/stop', { body: {}, headers: { origin: `http://127.0.0.1:${server.port}` } })).status).toBe(200);
  });
});

describe('projects and the backlog', () => {
  test('the folder ui started in is offered unregistered, and adding it registers it', async () => {
    expect((await get('/api/projects')).json.projects).toEqual([{ name: 'shop', path: repo, registered: false }]);
    const added = await post('/api/projects', { path: repo });
    expect(added.json.ok).toBe(true);
    expect(added.json.projects).toEqual([{ name: 'shop', path: repo, registered: true }]);
    expect((await get('/api/projects/nope/board')).status).toBe(404);
  });

  test('doctor and settings report on the project', async () => {
    const checks = (await get('/api/projects/shop/doctor')).json.checks;
    expect(checks.map((c: any) => c.name)).toContain('git');
    const settings = (await get('/api/projects/shop/settings')).json;
    expect(settings.config.suites[0].name).toBe('app');
    expect(settings.raw).toContain('"suites"');
  });

  test('a new item lands in the backlog and on the board; a bad one is refused', async () => {
    const ok = await post('/api/projects/shop/backlog', { slug: 'add-csv', type: 'feature', title: 'Export CSV', brief: '# add-csv\n' });
    expect(ok.json.ok).toBe(true);
    const board = (await get('/api/projects/shop/board')).json;
    expect(board.items.map((i: any) => i.slug)).toEqual(['ask-one', 'perm-one', 'add-csv']);
    expect((await get('/api/projects/shop/backlog/add-csv')).json.brief).toBe('# add-csv\n');
    const bad = await post('/api/projects/shop/backlog', { slug: 'Add CSV', type: 'feature', title: 'x', brief: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/slug/);
  });
});

describe('running a pipeline from the browser', () => {
  test('a run paused on questions is answered and resumed until done', async () => {
    const started = await post('/api/projects/shop/runs/ask-one/start');
    expect(started.json).toEqual(expect.objectContaining({ ok: true, code: 0 }));
    const paused = await until(() => run('ask-one'), v => v.state === 'paused');
    expect(paused.questions.map((q: any) => q.title)).toEqual(['One', 'Two']);
    expect((await get('/api/projects/shop/runs/ask-one/file?path=questions.md')).json.text).toContain('### Q1: One');
    expect((await get('/api/projects/shop/runs/ask-one/file?path=../../../sdlc.config.json')).status).toBe(400);

    const half = await post('/api/projects/shop/runs/ask-one/answers', { answers: { 1: 'yes' } });
    expect(half.json).toEqual(expect.objectContaining({ total: 2, answered: 1, resumed: null }));
    const all = await post('/api/projects/shop/runs/ask-one/answers', { answers: { 2: 'accept' } });
    expect(all.json.resumed).toEqual(expect.objectContaining({ ok: true }));
    expect((await until(() => run('ask-one'), v => v.state === 'done')).questions).toEqual([]);
  });

  test('refused actions are decided and the run resumes at the refused stage', async () => {
    await post('/api/projects/shop/runs/perm-one/start', { env: { MODEL_PLAN: 'haiku' } });
    const paused = await until(() => run('perm-one'), v => v.state === 'paused');
    expect(paused.permissions).toEqual([expect.objectContaining({ tool: 'Bash', rule: 'Bash(psql:*)' })]);
    const decided = await post('/api/projects/shop/runs/perm-one/permissions', { which: 'all', choice: 'always' });
    expect(decided.json).toEqual(expect.objectContaining({ pending: 0, resumed: expect.objectContaining({ ok: true }) }));
    await until(() => run('perm-one'), v => v.state === 'done');
    expect(fs.readFileSync(path.join(base, 'ran.txt'), 'utf8').trim().split('\n')).toEqual(['perm-one  model=haiku', 'perm-one --from plan model=']);
    expect(JSON.parse(fs.readFileSync(path.join(repo, '.claude/sdlc-permissions.json'), 'utf8')).allow).toEqual(['Bash(psql:*)']);
    expect((await post('/api/projects/shop/runs/perm-one/permissions', { which: 'all', choice: 'allow' })).status).toBe(404);
  });

  test('bad input is refused before anything runs', async () => {
    expect((await post('/api/projects/shop/runs/BAD/start')).status).toBe(400);
    expect((await post('/api/projects/shop/runs/ask-one/start', { env: { 'NOT A NAME': 'x' } })).status).toBe(400);
    expect((await post('/api/projects/shop/runs/ask-one/start', { from: '../x' })).status).toBe(400);
    expect(fs.existsSync(path.join(base, 'ran.txt'))).toBe(false);
  });

  test('discard removes the run and its worktree', async () => {
    await post('/api/projects/shop/runs/ask-one/start');
    await until(() => run('ask-one'), v => v.state === 'paused');
    const d = await post('/api/projects/shop/runs/ask-one/discard');
    expect(d.json.ok).toBe(true);
    expect((await run('ask-one')).state).toBe('not started');
    expect(fs.existsSync(path.join(base, 'wts', 'ask-one'))).toBe(false);
  });

  test('runs options endpoint saves PR creation setting and refuses if Finalise already started', async () => {
    await post('/api/projects/shop/runs/ask-one/start');
    await until(() => run('ask-one'), v => v.state === 'paused');
    const optRes = await post('/api/projects/shop/runs/ask-one/options', { createPr: true });
    expect(optRes.status).toBe(200);
    expect(optRes.json.createPr).toBe(true);

    const v = await run('ask-one');
    expect(v.createPr).toBe(true);
  });

  test('completed tasks and archiving endpoints', async () => {
    // Mark ask-one completed in index.md
    const indexPath = path.join(repo, 'Docs/backlog/index.md');
    fs.writeFileSync(indexPath, '# Backlog\n\n- [x] `ask-one` - Feature: Completed ask\n- [ ] `perm-one` - Feature: Other\n');

    const completed = await get('/api/projects/shop/completed');
    expect(completed.status).toBe(200);
    expect(completed.json.completed.some((c: any) => c.slug === 'ask-one')).toBe(true);

    const detail = await get('/api/projects/shop/completed/ask-one');
    expect(detail.status).toBe(200);
    expect(detail.json.slug).toBe('ask-one');
    expect(detail.json.archived).toBe(false);

    // Archive ask-one
    const arc = await post('/api/projects/shop/archive/ask-one');
    expect(arc.status).toBe(200);
    expect(arc.json.ok).toBe(true);

    const afterArc = await get('/api/projects/shop/completed/ask-one');
    expect(afterArc.json.archived).toBe(true);
  });
});

test('the board streams as Server-Sent Events', async () => {
  const first = await new Promise<string>((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port: server.port, path: '/api/events?project=shop', headers: { 'x-sdlc-token': server.token } }, r => {
      let text = '';
      r.on('data', d => { text += d; if (text.includes('\n\n')) { req.destroy(); res(text); } });
    });
    req.on('error', rej);
  });
  expect(first).toMatch(/^event: board\ndata: \{/);
  expect(JSON.parse(first.split('data: ')[1]).items.map((i: any) => i.slug)).toEqual(['ask-one', 'perm-one']);
});

test('the command palette runs a command line of the tool in the project', async () => {
  const r = await post('/api/projects/shop/command', { args: ['status', '--json'] });
  expect(r.json).toEqual(expect.objectContaining({ code: 3, stdout: 'status --json\n', timedOut: false }));
  expect((await post('/api/projects/shop/command', { args: 'status' })).status).toBe(400);
});

test('the built app is served, with index.html for the app routes and nothing outside its folder', async () => {
  expect((await get('/')).body).toContain('<title>app</title>');
  expect((await get('/run/ask-one')).body).toContain('<title>app</title>');
  expect((await get('/..%2f..%2fshop%2fsdlc.config.json')).status).toBe(404);
});

describe('editing a project\'s setup', () => {
  const settingsUrl = '/api/projects/shop/settings';

  test('the settings reply carries what the form needs: hash, harnesses, stages, overrides and the active runs', async () => {
    await post('/api/projects', { path: repo });
    const s = (await get(settingsUrl)).json;
    expect(s).toMatchObject({ harnesses: ['claude', 'agy', 'codex'], overrides: {}, registered: true, activeRuns: [] });
    expect(s.stages).toEqual(['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'test-audit', 'review']);
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(s.stageDefaults.review).toEqual({ model: 'opus', effort: 'medium' });
    expect(Object.keys(s.models)).toEqual(['claude', 'agy', 'codex']);
    expect(s.models.claude.map((m: any) => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(s.models.claude.find((m: any) => m.id === 'haiku').supportsEffort).toBe(false);
    expect(s.models.codex.find((m: any) => m.id === 'o3-mini').supportsEffort).toBe(true);
  });

  test('switching the default agent and giving a stage another one changes only those keys, and the next read shows them', async () => {
    const before = JSON.parse(fs.readFileSync(path.join(repo, 'sdlc.config.json'), 'utf8'));
    const hash = (await get(settingsUrl)).json.hash;
    const r = await post(settingsUrl, { patch: { agent: { harness: 'codex', model: 'o3-mini', effort: 'high', stages: { review: { harness: 'agy', model: 'gemini-3.8-pro' } } } }, hash });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const after = JSON.parse(fs.readFileSync(path.join(repo, 'sdlc.config.json'), 'utf8'));
    expect(after).toEqual({ ...before, agent: { ...before.agent, harness: 'codex', model: 'o3-mini', effort: 'high', stages: { review: { harness: 'agy', model: 'gemini-3.8-pro' } } } });
    const s = (await get(settingsUrl)).json;
    expect(s.config.agent).toMatchObject({ harness: 'codex', model: 'o3-mini', effort: 'high', stages: { review: { harness: 'agy', model: 'gemini-3.8-pro' } } });
    expect(s.hash).toBe(r.json.hash);
  });

  test('a bad value is a 400 with the CLI\'s wording; a stale hash is a 400 and neither touches the file', async () => {
    const file = path.join(repo, 'sdlc.config.json');
    const before = fs.readFileSync(file, 'utf8');
    const bad = await post(settingsUrl, { patch: { agent: { harness: 'gpt' } } });
    expect(bad.status).toBe(400);
    expect(bad.json.errors).toEqual(['sdlc.config.json: agent.harness: must be one of claude, agy, codex (got "gpt")']);
    const stale = await post(settingsUrl, { patch: { agent: { harness: 'agy' } }, hash: 'f'.repeat(64) });
    expect(stale.status).toBe(400);
    expect(stale.json.errors[0]).toContain('changed since you opened it');
    expect((await post(settingsUrl, { patch: 'x' })).status).toBe(400);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('the personal overrides are saved in the registry, shown back, and cleared with null; an unregistered project is a 404', async () => {
    expect((await post('/api/projects/shop/overrides', { patch: { maxParallel: 2 } })).status).toBe(404);
    await post('/api/projects', { path: repo });
    const r = await post('/api/projects/shop/overrides', { patch: { maxParallel: 2, worktreeBase: '/tmp/wts' } });
    expect(r.json.ok).toBe(true);
    expect((await get(settingsUrl)).json.overrides).toEqual({ maxParallel: 2, worktreeBase: '/tmp/wts' });
    expect((await post('/api/projects/shop/overrides', { patch: { maxParallel: 0 } })).json.errors).toEqual(['maxParallel: must be a whole number above 0']);
    await post('/api/projects/shop/overrides', { patch: { maxParallel: null, worktreeBase: null } });
    expect((await get(settingsUrl)).json.overrides).toEqual({});
  });

  test('personal agent settings sit above the file, are saved in the registry, and each setting says which one it comes from', async () => {
    await post(settingsUrl, { patch: { agent: { harness: 'claude', model: 'sonnet' } } });
    await post('/api/projects', { path: repo });
    const saved = await post('/api/projects/shop/overrides', { patch: { agent: { model: 'haiku', stages: { review: { harness: 'codex' } } } } });
    expect(saved.json.ok).toBe(true);
    const s = (await get(settingsUrl)).json;
    expect(s.config.agent).toMatchObject({ harness: 'claude', model: 'haiku', stages: { review: { harness: 'codex' } } });
    expect(s.fileAgent).toEqual({ harness: 'claude', model: 'sonnet' });
    expect(s.personalAgent).toEqual({ model: 'haiku', stages: { review: { harness: 'codex' } } });
    expect(s.sources).toEqual({ harness: 'project', model: 'personal', stages: { review: { harness: 'personal' } } });
    expect(s.files).toEqual({ project: path.join(repo, 'sdlc.config.json'), personal: path.join(base, 'config', 'projects.json') });
    expect(JSON.parse(fs.readFileSync(path.join(repo, 'sdlc.config.json'), 'utf8')).agent.model).toBe('sonnet');
    const bad = await post('/api/projects/shop/overrides', { patch: { agent: { harness: 'gpt' } } });
    expect(bad.status).toBe(400);
    expect(bad.json.errors).toEqual(['agent.harness: must be one of claude, agy, codex (got "gpt")']);
  });

  test('a run that is paused is named as keeping the old setup', async () => {
    await post('/api/projects', { path: repo });
    await post('/api/projects/shop/runs/ask-one/start', {});
    await until(() => run('ask-one'), v => v.state === 'paused');
    const r = await post(settingsUrl, { patch: { agent: { harness: 'agy' } } });
    expect(r.json.activeRuns).toEqual(['ask-one']);
  });
});
