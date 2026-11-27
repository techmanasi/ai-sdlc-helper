// The run behaviour endpoints next to the personal-settings overrides route: GET reads the saved settings and the
// server's own environment; PUT validates and writes the registry entry.
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { readRegistry, writeRegistry } from 'ai-sdlc-helper';
import { project, tmp } from '../../test/helpers.js';
import { startServer } from '../server/index.js';

describe('run behaviour over HTTP', () => {
  test('GET reports the saved settings and environment precedence; PUT validates before saving', async () => {
    const dir = project({ 'sdlc.config.json': { suites: [{ dir: '.', runner: 'vitest', testCmd: 'vitest run' }], agent: { codeSearch: 'none' } } });
    const env = { AI_SDLC_HELPER_CONFIG_DIR: tmp(), SDLC_LIMIT_RETRY: '9' };
    writeRegistry([{ name: 'shop', path: fs.realpathSync(dir), addedAt: '2026-01-01T00:00:00.000Z' }], env);
    const server = await startServer({ port: 0, env });
    const request = (method: string, body?: unknown) => fetch(`http://127.0.0.1:${server.port}/api/projects/shop/run-behaviour`, {
      method, headers: { 'x-sdlc-token': server.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      const initial = await request('GET');
      expect(initial.status).toBe(200);
      expect(await initial.json() as unknown).toEqual({ saved: null, envSet: { SDLC_LIMIT_RETRY: '9' }, registered: true });

      const bad = await request('PUT', { limitRetry: -1, env: { SDLC_BASE: 'x' } });
      expect(bad.status).toBe(400);
      expect((await bad.json() as { errors: string[] }).errors).toEqual([
        'run.limitRetry: must be a whole number of seconds, 0 or more (got -1)',
        'run.env.SDLC_BASE: SDLC_BASE is set by the tool itself',
      ]);
      expect(readRegistry(env)[0].overrides).toBeUndefined();

      const saved = await request('PUT', { allowMerged: true, env: { FOO: 'bar' } });
      expect(saved.status).toBe(200);
      expect(readRegistry(env)[0].overrides?.run).toEqual({ allowMerged: true, env: { FOO: 'bar' } });
      const after = await request('GET');
      expect((await after.json() as { saved: unknown }).saved).toEqual({ allowMerged: true, env: { FOO: 'bar' } });
    } finally { await server.close(); }
  });
});
