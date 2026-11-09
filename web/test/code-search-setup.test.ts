import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { writeRegistry } from '../../src/registry/projects.js';

async function fixture(run: (f: { root: string; bin: string; request: (method: string, route: string, body?: unknown) => Promise<{ status: number; json: any }>; config: string }) => Promise<void>) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'code-setup-'));
  const root = path.join(temp, 'shop');
  const bin = path.join(temp, 'bin');
  await fs.mkdir(root);
  await fs.mkdir(bin);
  const config = path.join(root, 'sdlc.config.json');
  await fs.writeFile(config, JSON.stringify({ agent: { codeSearch: 'none', harness: 'claude' }, ui: { timezone: 'UTC' } }));
  const env = { ...process.env, AI_SDLC_HELPER_CONFIG_DIR: path.join(temp, 'config'), PATH: bin };
  writeRegistry([{ name: 'shop', path: root, addedAt: '2025-01-01T00:00:00.000Z' }], env);
  const server = await startServer({ port: 0, env, commandTimeoutMs: 150 } as any);
  const request = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api/projects/${route}`, { method, headers: { 'x-sdlc-token': server.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: await res.json() as any };
  };
  try { await run({ root, bin, request, config }); }
  finally { await server.close(); await fs.rm(temp, { recursive: true, force: true }); }
}

async function binary(bin: string, name: string, body: string) {
  await fs.writeFile(path.join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
}

describe('code search setup routes', () => {
  it('inspects missing, installed and indexed engines and rejects unknown projects', async () => fixture(async ({ root, bin, request }) => {
    let r = await request('GET', 'shop/code-search');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ setting: 'none', effective: 'none', warning: null, indexers: expect.arrayContaining([
      expect.objectContaining({ name: 'graft', installed: false, indexed: false, canBuild: true }),
      expect.objectContaining({ name: 'graphify', canBuild: false }),
    ]) });
    await binary(bin, 'graft', 'process.exit(0)');
    r = await request('GET', 'shop/code-search');
    expect(r.json.indexers).toContainEqual(expect.objectContaining({ name: 'graft', installed: true, indexed: false }));
    await fs.mkdir(path.join(root, 'graft'));
    r = await request('GET', 'shop/code-search');
    expect(r.json.indexers).toContainEqual(expect.objectContaining({ name: 'graft', installed: true, indexed: true }));
    expect((await request('GET', 'absent/code-search')).status).toBe(404);
  }));

  it('saves auto and none without running a build and preserves other settings', async () => fixture(async ({ root, bin, request, config }) => {
    await binary(bin, 'graft', "require('fs').writeFileSync('build-marker', 'ran')");
    for (const indexer of ['auto', 'none']) {
      const r = await request('POST', 'shop/code-search/setup', { indexer });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ ok: true, codeSearch: indexer });
      expect(JSON.parse(await fs.readFile(config, 'utf8'))).toMatchObject({ agent: { codeSearch: indexer, harness: 'claude' }, ui: { timezone: 'UTC' } });
    }
    await expect(fs.access(path.join(root, 'build-marker'))).rejects.toThrow();
  }));

  it('builds in the project root, captures output and saves the indexer', async () => fixture(async ({ root, bin, request, config }) => {
    await binary(bin, 'graft', "require('fs').mkdirSync('graft'); console.log(process.argv.slice(2).join(' '))");
    const r = await request('POST', 'shop/code-search/setup', { indexer: 'graft', build: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, codeSearch: 'graft', buildOutput: { code: 0, timedOut: false, stdout: expect.stringContaining('build') } });
    expect((await fs.stat(path.join(root, 'graft'))).isDirectory()).toBe(true);
    expect(JSON.parse(await fs.readFile(config, 'utf8')).agent.codeSearch).toBe('graft');
    const status = await request('GET', 'shop/code-search');
    expect(status.json.effective).toBe('graft');
  }));

  it.each([
    ['failure', "console.error('build broke'); process.exit(7)", { code: 7, timedOut: false, stderr: expect.stringContaining('build broke') }],
    ['timeout', 'setInterval(() => {}, 1000)', { timedOut: true }],
  ])('keeps configuration unchanged on %s', async (_name, script, output) => fixture(async ({ bin, request, config }) => {
    await binary(bin, 'graft', script as string);
    const before = await fs.readFile(config, 'utf8');
    const r = await request('POST', 'shop/code-search/setup', { indexer: 'graft', build: true });
    expect([200, 400]).toContain(r.status);
    expect(r.json).toMatchObject({ ok: false, error: expect.any(String), buildOutput: output });
    expect(await fs.readFile(config, 'utf8')).toBe(before);
  }));

  it('validates requests and leaves malformed configuration untouched', async () => fixture(async ({ bin, request, config }) => {
    for (const body of [{}, { indexer: 4 }, { indexer: 'unknown' }, { indexer: 'none', build: true }, { indexer: 'auto', build: true }, { indexer: 'graft', build: 'yes' }, { indexer: 'graft', build: true }]) {
      expect((await request('POST', 'shop/code-search/setup', body)).status).toBe(400);
    }
    await binary(bin, 'graphify', 'process.exit(0)');
    expect((await request('POST', 'shop/code-search/setup', { indexer: 'graphify', build: true })).status).toBe(400);
    await fs.writeFile(config, '{ invalid');
    expect((await request('POST', 'shop/code-search/setup', { indexer: 'none' })).status).toBe(400);
    expect(await fs.readFile(config, 'utf8')).toBe('{ invalid');
  }));
});
