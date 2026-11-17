import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { writeRegistry } from 'ai-sdlc-helper';
import { startServer, type RunningServer } from '../server/index.js';

let base: string;
let root: string;
let server: RunningServer;
const config = () => path.join(root, 'sdlc.config.json');
const marker = () => path.join(root, 'build-ran');
const route = '/api/projects/shop/code-search';

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'code-setup-'));
  root = path.join(base, 'shop');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'graft'), `#!/bin/sh
printf '%s' "$*" > build-ran
case "$BUILD_MODE" in
  fail) echo 'fixture build failure' >&2; exit 1 ;;
  missing) exit 0 ;;
  hang) exec /bin/sleep 30 ;;
esac
/bin/mkdir -p graft
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'personal'), BUILD_MODE: '' };
  writeRegistry([{ name: 'shop', path: root, addedAt: '2026-01-01' }], env);
  const opts = { port: 0, env, codeSetupTimeoutMs: 300, codeSetupKillGraceMs: 50 };
  server = await startServer(opts);
});

afterEach(async () => {
  if (server) await server.close();
  fs.rmSync(base, { recursive: true, force: true });
});

type Inspection = {
  configured: string;
  indexers: unknown[];
  operation: { status: string; exitCode: number | null; error: string | null; output: string[] };
};

async function request<T = unknown>(url: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-sdlc-token': server.token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() as T };
}

async function finished() {
  for (let i = 0; i < 100; i++) {
    const result = await request<Inspection>(route);
    if (result.data.operation && result.data.operation.status !== 'running') return result.data.operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('build did not finish');
}

function override(build: string) {
  fs.writeFileSync(config(), JSON.stringify({ agent: { codeSearch: 'none', codeIndexers: { graft: { build } } }, extra: { keep: true } }));
}

describe('code indexer setup routes', () => {
  it('inspects supported indexers and rejects unknown projects', async () => {
    const result = await request<Inspection>(route);
    expect(result.status).toBe(200);
    expect(result.data.configured).toBe('auto');
    expect(result.data.operation.status).toBe('idle');
    expect(result.data.indexers).toHaveLength(2);
    expect(result.data.indexers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'graft', installed: true, indexed: false, runnable: true }),
      expect.objectContaining({ name: 'graphify', installed: false, indexed: false, runnable: false, setup: expect.any(String) }),
    ]));
    expect((await request('/api/projects/unknown/code-search')).status).toBe(404);
  });

  it('builds and preserves existing settings, then doctor sees a healthy indexer', async () => {
    fs.writeFileSync(config(), JSON.stringify({ agent: { codeSearch: 'none', model: 'example' }, extra: true }));
    expect((await request(`${route}/setup`, { indexer: 'graft' })).status).toBe(202);
    expect((await finished()).status).toBe('succeeded');
    const raw = fs.readFileSync(config(), 'utf8');
    expect(JSON.parse(raw)).toEqual({ agent: { codeSearch: 'graft', model: 'example' }, extra: true });
    expect(raw).toBe(JSON.stringify(JSON.parse(raw), null, 2) + '\n');
    expect(fs.readFileSync(marker(), 'utf8')).toBe('build');
    const doctor = await request<{ checks: unknown[] }>('/api/projects/shop/doctor');
    expect(doctor.data.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'code indexer', ok: true })]));
  });

  it('creates missing configuration after a verified build', async () => {
    expect((await request(`${route}/setup`, { indexer: 'graft' })).status).toBe(202);
    expect((await finished()).status).toBe('succeeded');
    expect(JSON.parse(fs.readFileSync(config(), 'utf8'))).toEqual({ agent: { codeSearch: 'graft' } });
  });

  it('rejects malformed configuration without launching a build', async () => {
    fs.writeFileSync(config(), '{broken');
    const result = await request(`${route}/setup`, { indexer: 'graft' });
    expect(result.status).toBe(400);
    expect(fs.readFileSync(config(), 'utf8')).toBe('{broken');
    expect(fs.existsSync(marker())).toBe(false);
  });

  it.each([{}, { indexer: 'custom' }, { indexer: 'graphify' }])('rejects unsupported or unavailable selection %j', async body => {
    const result = await request(`${route}/setup`, body);
    expect(result.status).toBe(400);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('rejects unsafe or blank build overrides', async () => {
    override('graft build; touch injected');
    expect((await request(`${route}/setup`, { indexer: 'graft' })).status).toBe(400);
    expect(fs.existsSync(marker())).toBe(false);
  });

  it('reports nonzero exit and preserves configuration and output', async () => {
    override('graft build');
    fs.writeFileSync(path.join(base, 'bin', 'graft'), '#!/bin/sh\necho failure-detail >&2\nexit 1\n', { mode: 0o755 });
    const before = fs.readFileSync(config(), 'utf8');
    expect((await request(`${route}/setup`, { indexer: 'graft' })).status).toBe(202);
    const op = await finished();
    expect(op).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(op.output.join('\n')).toContain('failure-detail');
    expect(fs.readFileSync(config(), 'utf8')).toBe(before);
  });

  it('fails verification when a successful command creates no index', async () => {
    override('graft build');
    fs.writeFileSync(path.join(base, 'bin', 'graft'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const before = fs.readFileSync(config(), 'utf8');
    expect((await request(`${route}/setup`, { indexer: 'graft' })).status).toBe(202);
    expect(await finished()).toMatchObject({ status: 'failed', error: 'Build exited successfully, but index files were not found' });
    expect(fs.readFileSync(config(), 'utf8')).toBe(before);
  });

  it('guards concurrent builds and reports timeout without changing configuration', async () => {
    override('graft build');
    fs.writeFileSync(path.join(base, 'bin', 'graft'), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });
    const before = fs.readFileSync(config(), 'utf8');
    expect((await request(`${route}/setup`, { indexer: 'graft' })).status).toBe(202);
    expect((await request<Inspection>(route)).data.operation.status).toBe('running');
    expect((await request(`${route}/setup`, { indexer: 'graft' })).status).toBe(409);
    expect(await finished()).toMatchObject({ status: 'timeout', error: 'Build timed out after 10 minutes' });
    expect(fs.readFileSync(config(), 'utf8')).toBe(before);
  });
});
