import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

let base: string;
let repo: string;
let server: RunningServer | null = null;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-nogh-')));
  repo = path.join(base, 'shop');
  fs.mkdirSync(path.join(repo, 'Docs/backlog/a'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), '# Backlog\n\n- [x] `a` - Feature: a\n');
  fs.writeFileSync(path.join(repo, 'Docs/backlog/a/brief.md'), '# a\n');
  fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(base, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  // A PATH with git and no gh.
  fs.mkdirSync(path.join(base, 'bin'));
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.symlinkSync(real, path.join(base, 'bin', 'git'));
});
afterEach(async () => {
  if (server) await server.close();
  server = null;
  vi.restoreAllMocks();
});

describe('server start-up with gh not installed', () => {
  test('warns on stderr and keeps the warning in errors.log', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const env = { ...process.env, ...GIT_ENV, PATH: path.join(base, 'bin'), AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), SDLC_TRACE: '0' };
    delete (env as Record<string, string | undefined>).SDLC_WARM_PR_CACHE;
    server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs: 100, warmPrDelayMs: 0, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
    await server.prWarmup();
    const log = path.join(repo, '.git', 'sdlc-runs', 'errors.log');
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.readFileSync(log, 'utf8')).toContain('gh is not installed');
    expect(err.mock.calls.map(c => String(c[0])).join('')).toMatch(/WARNING: gh is not installed/);
  });
});
