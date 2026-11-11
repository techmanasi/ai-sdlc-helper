import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolve } from '../../src/config/settings.js';
import { editOverrides, editSettings } from '../../src/config/edit.js';
import { writeRegistry, readRegistry } from '../../src/registry/projects.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(project: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-config-'));
  roots.push(root);
  const env = { AI_SDLC_HELPER_CONFIG_DIR: path.join(root, 'personal') };
  await fs.writeFile(path.join(root, 'sdlc.config.json'), JSON.stringify({
    suites: [{ name: 'unit', dir: '.', runner: 'vitest', testCmd: 'vitest run', testGlobs: ['test/**/*.test.ts'] }],
    ...project,
  }));
  writeRegistry([{ name: 'fixture', path: root, addedAt: '2026-01-01', overrides }], env);
  return { root, env };
}

describe('CI configuration (spec 2)', () => {
  it('C01 resolves local, 60 minutes and an empty allow list by default', async () => {
    const { root, env } = await fixture();
    const result = resolve(root, { env });
    expect(result.errors).toEqual([]);
    expect(result.config).toMatchObject({ tests: { fullSuite: 'local', allowFailures: [] }, ci: { waitMinutes: 60 } });
  });

  it.each([
    [{ tests: { fullSuite: 'ci' }, ci: { waitMinutes: 9 } }, {}, {}, 'ci', 9],
    [{ tests: { fullSuite: 'local' }, ci: { waitMinutes: 9 } }, { fullSuite: 'ci', ciWaitMinutes: 7 }, {}, 'ci', 7],
    [{ tests: { fullSuite: 'ci' }, ci: { waitMinutes: 9 } }, { fullSuite: 'local', ciWaitMinutes: 7 }, { SDLC_FULL_SUITE: 'ci', SDLC_CI_WAIT_MINUTES: '3' }, 'ci', 3],
    [{ tests: { fullSuite: 'local' } }, { fullSuite: 'ci', ciWaitMinutes: 7 }, { SDLC_FULL_SUITE: '', SDLC_CI_WAIT_MINUTES: '' }, 'ci', 7],
    [{ tests: { fullSuite: 'ci' } }, {}, { SDLC_FULL_SUITE: 'local' }, 'local', 60],
  ] as const)('C02 resolves project/personal/environment precedence %#', async (project, personal, extra, fullSuite, waitMinutes) => {
    const { root, env } = await fixture(project, personal);
    const result = resolve(root, { env: { ...env, ...extra } });
    expect(result.errors).toEqual([]);
    expect(result.config).toMatchObject({ tests: { fullSuite }, ci: { waitMinutes } });
  });

  it.each(['remote', 'CI', ' ', '0'])('C03 rejects invalid environment mode %j', async value => {
    const { root, env } = await fixture();
    const result = resolve(root, { env: { ...env, SDLC_FULL_SUITE: value } });
    expect(result.config).toBeNull();
    expect(result.errors.join('\n')).toEqual(expect.stringContaining('SDLC_FULL_SUITE'));
    for (const token of [value, 'local', 'ci']) expect(result.errors.join('\n')).toContain(token);
  });

  it.each(['0', '-1', '1.5', 'abc', 'Infinity'])('C04 rejects invalid environment wait %j', async value => {
    const { root, env } = await fixture();
    const result = resolve(root, { env: { ...env, SDLC_CI_WAIT_MINUTES: value } });
    expect(result.config).toBeNull();
    expect(result.errors.join('\n')).toContain('SDLC_CI_WAIT_MINUTES');
    expect(result.errors.join('\n')).toContain(value);
  });

  it.each([
    [{ tests: { fullSuite: 'remote' } }, 'tests.fullSuite', 'remote'],
    [{ ci: { waitMinutes: 0 } }, 'ci.waitMinutes', '0'],
    [{ ci: { waitMinutes: 1.5 } }, 'ci.waitMinutes', '1.5'],
    [{ ci: { waitMinutes: '3' } }, 'ci.waitMinutes', '3'],
    [{ tests: { allowFailures: 'test/*.test.ts' } }, 'tests.allowFailures', ''],
    [{ tests: { allowFailures: [''] } }, 'tests.allowFailures', ''],
    [{ tests: { allowFailures: [42] } }, 'tests.allowFailures', '42'],
    [{ tests: { allowFailures: null } }, 'tests.allowFailures', ''],
  ] as const)('C05 rejects invalid project setting %# even with valid env', async (project, key, bad) => {
    const { root, env } = await fixture(project);
    const result = resolve(root, { env: { ...env, SDLC_FULL_SUITE: 'local', SDLC_CI_WAIT_MINUTES: '5' } });
    expect(result.config).toBeNull();
    expect(result.errors.join('\n')).toContain('sdlc.config.json');
    expect(result.errors.join('\n')).toContain(key);
    if (bad) expect(result.errors.join('\n')).toContain(bad);
  });

  it.each([{ fullSuite: 'remote' }, { ciWaitMinutes: 0 }, { ciWaitMinutes: 1.5 }, { ciWaitMinutes: '4' }])(
    'C06 validates personal settings before higher priority overrides %j', async overrides => {
      const { root, env } = await fixture({}, overrides);
      const result = resolve(root, { env: { ...env, SDLC_FULL_SUITE: 'ci', SDLC_CI_WAIT_MINUTES: '5' } });
      expect(result.config).toBeNull();
      expect(result.errors.join('\n')).toMatch(/personal/i);
      expect(result.errors.join('\n')).toContain(Object.keys(overrides)[0]);
    });

  it('C07 keeps allowFailures project-only and accepts the minimum wait', async () => {
    const entries = ['test/e2e/*.test.ts', 'test/unit.test.ts > suite rejects input'];
    const { root, env } = await fixture({ tests: { allowFailures: entries }, ci: { waitMinutes: 1 } });
    const result = resolve(root, { env: { ...env, SDLC_ALLOW_FAILURES: '*' } });
    expect(result.errors).toEqual([]);
    expect(result.config).toMatchObject({ tests: { allowFailures: entries }, ci: { waitMinutes: 1 } });
  });

  it('C08 saves valid project and personal settings through the editors', async () => {
    const { root, env } = await fixture();
    expect(editSettings(root, { tests: { fullSuite: 'ci', allowFailures: ['test/legacy.test.ts'] }, ci: { waitMinutes: 2 } }).ok).toBe(true);
    expect(editOverrides('fixture', { fullSuite: 'local', ciWaitMinutes: 1 }, env).ok).toBe(true);
    expect(readRegistry(env)[0].overrides).toMatchObject({ fullSuite: 'local', ciWaitMinutes: 1 });
    expect(resolve(root, { env }).config).toMatchObject({ tests: { fullSuite: 'local' }, ci: { waitMinutes: 1 } });
  });

  it('C09 refuses invalid editor patches without changing saved values', async () => {
    const { root, env } = await fixture();
    const before = await fs.readFile(path.join(root, 'sdlc.config.json'), 'utf8');
    expect(editSettings(root, { ci: { waitMinutes: -2 } }).ok).toBe(false);
    expect(await fs.readFile(path.join(root, 'sdlc.config.json'), 'utf8')).toBe(before);
    expect(editOverrides('fixture', { ciWaitMinutes: 0 }, env).ok).toBe(false);
    expect(readRegistry(env)[0].overrides).toEqual({});
  });
});
