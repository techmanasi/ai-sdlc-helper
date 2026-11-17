import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { startServer } from '../server/index.js';

describe('invalid saved review loop limit', () => {
  it('exposes the stored key so a settings save can clear it', async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-limit-')));
    const file = path.join(repo, 'sdlc.config.json');
    fs.writeFileSync(file, JSON.stringify({ suites: [{ dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], review: { maxLoops: -1 } }));
    const git = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    expect(git.status).toBe(0);
    const env = { ...process.env, AI_SDLC_HELPER_CONFIG_DIR: path.join(repo, 'config') };
    const server = await startServer({ port: 0, cwd: repo, env });
    try {
      const url = `http://127.0.0.1:${server.port}/api/projects/${path.basename(repo).toLowerCase()}/settings`;
      const headers = { 'x-sdlc-token': server.token, 'content-type': 'application/json' };
      const response = await fetch(url, { headers });
      expect(response.status).toBe(200);
      const view = await response.json() as { fileReview: { maxLoops?: unknown }; hash: string };
      expect(view.fileReview).toHaveProperty('maxLoops');
      const saved = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ patch: { review: { maxLoops: null } }, hash: view.hash }) });
      expect((await saved.json() as { ok: boolean }).ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).review?.maxLoops).toBeUndefined();
    } finally {
      await server.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
