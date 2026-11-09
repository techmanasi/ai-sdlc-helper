import { describe, it, expect, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as search from '../../src/config/codeSearch.js';
import { fileErrors } from '../../src/config/settings.js';

describe('code search status and build commands', () => {
  it('reports PATH and project index independently and resolves the effective engine', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-status-'));
    try {
      const bin = path.join(root, 'bin');
      await fs.mkdir(bin);
      const env = { ...process.env, PATH: bin };
      const status = (search as any).codeSearchStatus;
      const first = status(root, {}, env);
      expect(first).toMatchObject({ setting: 'auto', effective: 'none', warning: expect.any(String) });
      expect(first.indexers).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'graft', installed: false, indexed: false, canBuild: true }),
        expect.objectContaining({ name: 'graphify', installed: false, indexed: false, canBuild: false }),
      ]));
      await fs.writeFile(path.join(bin, 'graft'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      expect(status(root, {}, env).indexers.find((x: any) => x.name === 'graft')).toMatchObject({ installed: true, indexed: false });
      await fs.mkdir(path.join(root, 'graft'));
      expect(status(root, {}, env)).toMatchObject({ effective: 'graft', warning: null, indexers: expect.arrayContaining([expect.objectContaining({ name: 'graft', installed: true, indexed: true })]) });
      expect(status(root, { agent: { codeSearch: 'none' } }, env)).toMatchObject({ setting: 'none', effective: 'none', warning: null });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it('supports a custom headless command and splits arguments without a shell', () => {
    const ix = { name: 'custom', command: 'tool', guide: 'search', tools: [], commands: [], buildCommand: 'tool build --fast' };
    expect((search as any).codeBuildArgv(ix)).toEqual({ file: 'tool', args: ['build', '--fast'] });
    expect((search as any).codeBuildArgv({ ...ix, buildCommand: '' })).toBeNull();
    expect(search.codeSearchErrors({ agent: { codeIndexers: { custom: ix } } })).toEqual([]);
    expect(fileErrors({ agent: { codeIndexers: { custom: ix } } })).toEqual([]);
    const result = (search as any).codeSearchStatus(process.cwd(), { agent: { codeIndexers: { custom: ix } } }, { PATH: '' });
    expect(result.indexers).toContainEqual(expect.objectContaining({ name: 'custom', canBuild: true }));
  });

  it.each(['tool build; rm', 'tool build && other', 'tool $(other)'])('rejects shell syntax in %s', command => {
    const errors = search.codeSearchErrors({ agent: { codeIndexers: { custom: { command: 'tool', guide: 'search', buildCommand: command } } } });
    expect(errors.join(' ')).toContain('agent.codeIndexers.custom.buildCommand');
  });
});
