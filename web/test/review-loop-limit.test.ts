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
describe('review loop limit API', () => {
  const url = '/api/projects/shop/settings';
  const file = () => path.join(repo, 'sdlc.config.json');

  test('returns the default and distinguishes an explicitly configured limit', async () => {
    let view = (await get(url)).json;
    expect(view.fileReview).toEqual({});
    expect(view.defaults.reviewMaxLoops).toBe(2);
    const file = path.join(repo, 'sdlc.config.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...config, review: { maxLoops: 3 } }));
    view = (await get(url)).json;
    expect(view.fileReview.maxLoops).toBe(3);
    expect(view.defaults.reviewMaxLoops).toBe(2);
  });

  test.each(['-1', '1.5', 'abc', ' '])('rejects invalid run option %j before starting', async value => {
    const before = fs.readFileSync(file(), 'utf8');
    const result = await post('/api/projects/shop/runs/ask-one/start', { env: { SDLC_REVIEW_MAX_LOOPS: value } });
    expect(result.status).toBe(400);
    expect(result.body).toContain('must be a whole number, 0 or more');
    expect(fs.existsSync(path.join(base, 'ran.txt'))).toBe(false);
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  });
});test.each([['5', 5]])('run option %j reaches the pipeline and resolves to %i', async (option, expected) => {
  const file = path.join(repo, 'sdlc.config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...config, review: { maxLoops: 1 } }));
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(path.join(base, 'stub.sh'), '#!/bin/sh\nprintf "%s" "${SDLC_REVIEW_MAX_LOOPS:-}" > "$RAN_FILE.tmp"\nmv "$RAN_FILE.tmp" "$RAN_FILE"\n', { mode: 0o755 });
  const started = await post('/api/projects/shop/runs/ask-one/start', { env: { SDLC_REVIEW_MAX_LOOPS: option } });
  expect(started.status).toBe(200);
  const recorded = await until(async () => fs.existsSync(path.join(base, 'ran.txt')) ? fs.readFileSync(path.join(base, 'ran.txt'), 'utf8') : null, value => value !== null);
  const { resolve } = await import('../../src/config/settings.js');
  expect(resolve(repo, { env: { SDLC_REVIEW_MAX_LOOPS: recorded! } }).config?.review.maxLoops).toBe(expected);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});
