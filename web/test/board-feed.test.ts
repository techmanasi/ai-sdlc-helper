import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eventually } from '../../test/wait.js';
import { startServer, type RunningServer } from '../server/index.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
let base: string;
let repo: string;
let server: RunningServer | null = null;
const savedPath = process.env.PATH;

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
/** How often the board was built, from the server's trace (written within the flush time set below). */
const FLUSH_MS = 40;
const builds = (): number => { try { return fs.readFileSync(path.join(base, 'config', 'ui-trace.jsonl'), 'utf8').split('\n').filter(l => l.includes('"timer:board-rebuild"')).length; } catch { return 0; } };
const settle = () => new Promise(r => setTimeout(r, FLUSH_MS * 4));
/** The git calls of the server (the stand-in on PATH logs them). */
const gitCalls = (): number => { try { return fs.readFileSync(path.join(base, 'git-calls.txt'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

async function start(pollMs: number, extra: { env?: NodeJS.ProcessEnv; boardWatch?: { silenceMs: number } } = {}): Promise<RunningServer> {
  const env = { ...process.env, ...GIT_ENV, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), ...extra.env };
  server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs, traceFlushMs: FLUSH_MS, boardWatch: extra.boardWatch, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
  return server;
}

/** A page on the board stream: resolves with the first board it is sent. */
function page(s: RunningServer): Promise<{ board: any; boards: () => number; close: () => void }> {
  return new Promise((res, rej) => {
    let n = 0;
    let text = '';
    const req = http.get({ host: '127.0.0.1', port: s.port, path: '/api/events?project=shop', headers: { 'x-sdlc-token': s.token } }, r => {
      r.on('data', d => {
        text += d;
        for (let at = text.indexOf('\n\n'); at >= 0; at = text.indexOf('\n\n')) {
          const block = text.slice(0, at);
          text = text.slice(at + 2);
          if (!block.startsWith('event: board')) continue;
          n++;
          if (n === 1) res({ board: JSON.parse(block.slice(block.indexOf('data: ') + 6)), boards: () => n, close: () => req.destroy() });
        }
      });
    });
    req.on('error', e => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') rej(e); });
  });
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-feed-')));
  repo = path.join(base, 'shop');
  fs.mkdirSync(path.join(repo, 'Docs/backlog/one'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), '# Backlog\n\n- [ ] `one` - Feature: One\n');
  fs.writeFileSync(path.join(repo, 'Docs/backlog/one/brief.md'), '# one\n');
  fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(base, 'ui'));
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.mkdirSync(path.join(base, 'bin'));
  fs.writeFileSync(path.join(base, 'bin', 'git'), `#!/bin/sh\necho "$@" >> "${path.join(base, 'git-calls.txt')}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${path.join(base, 'bin')}:${savedPath}`;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  if (server) await server.close();
  server = null;
});

describe('the board feed', () => {
  test('three pages cost one board build, and a page that joins later is served the last board at once', async () => {
    const s = await start(60_000); // no tick during the test: every build is a page joining
    const first = await page(s);
    expect(first.board.items.map((i: { slug: string }) => i.slug)).toEqual(['one']);
    await settle();
    expect(builds()).toBe(1);
    const afterFirst = gitCalls();
    const second = await page(s);
    const third = await page(s);
    expect(second.board).toEqual(first.board);
    expect(third.board).toEqual(first.board);
    await settle();
    expect(builds()).toBe(1);
    expect(gitCalls()).toBe(afterFirst);
    for (const p of [first, second, third]) p.close();
  });

  test('a change reaches every page once, from the builds of one feed', async () => {
    const s = await start(60_000);
    const pages = [await page(s), await page(s), await page(s)];
    await settle();
    const before = builds();
    fs.appendFileSync(path.join(repo, 'Docs/backlog/index.md'), '- [ ] `two` - Bug: Two\n');
    await eventually(() => pages.every(p => p.boards() >= 2));
    await new Promise(r => setTimeout(r, 400));
    await settle();
    // Every page saw the change exactly once, and the builds did not multiply by the pages (a write may fire twice).
    expect(pages.map(p => p.boards())).toEqual([2, 2, 2]);
    expect(builds() - before).toBeGreaterThanOrEqual(1);
    expect(builds() - before).toBeLessThanOrEqual(2);
    for (const p of pages) p.close();
  });

  test('a board nobody changes is not built again: no clock rebuilds it', async () => {
    const s = await start(50); // the liveness tick is fast, but no run is going, so it builds nothing
    const one = await page(s);
    await settle();
    const before = builds();
    await new Promise(r => setTimeout(r, 600));
    await settle();
    expect(builds()).toBe(before);
    expect(gitCalls()).toBeGreaterThan(0);
    one.close();
  });

  test('the feed stops with its last page, and starts again for the next one', async () => {
    const s = await start(60_000);
    const one = await page(s);
    const two = await page(s);
    one.close();
    await new Promise(r => setTimeout(r, 100));
    fs.appendFileSync(path.join(repo, 'Docs/backlog/index.md'), '- [ ] `two` - Bug: Two\n');
    await eventually(() => two.boards() >= 2); // still fed, for the page that stayed
    two.close();
    await new Promise(r => setTimeout(r, 300));
    await settle();
    const stopped = builds();
    fs.appendFileSync(path.join(repo, 'Docs/backlog/index.md'), '- [ ] `three` - Bug: Three\n');
    await new Promise(r => setTimeout(r, 600));
    await settle();
    expect(builds()).toBe(stopped);
    const again = await page(s);
    expect(again.board.items).toHaveLength(3);
    await eventually(() => builds() > stopped);
    again.close();
  });

  test('a board that nothing changes still asks about its pull requests again when their status is old', async () => {
    // A finished run, and a gh that counts how often it is asked.
    fs.mkdirSync(path.join(repo, '.git/sdlc-runs'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git/sdlc-runs/one.json'), JSON.stringify({ slug: 'one', worktree: '', pid: 0, started: '2026-11-13T10:00:00', state: 'exited', exit_code: '0', interrupted: false, finished: '2026-11-13T10:05:00', message: '', branch: 'sdlc/one', base: 'main', root: repo }));
    const ghLog = path.join(base, 'gh-calls.txt');
    fs.writeFileSync(path.join(base, 'bin', 'gh'), `#!/bin/sh\necho x >> "${ghLog}"\necho '{"url":"https://github.com/o/r/pull/7","state":"OPEN","number":7}'\n`, { mode: 0o755 });
    const asked = (): number => { try { return fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
    const s = await start(60_000, { env: { SDLC_PR_POLL_MS: '300' }, boardWatch: { silenceMs: 100 } });
    const one = await page(s);
    await eventually(() => asked() >= 1);
    const first = asked();
    // No file changes from here on: only the quiet moments after each silence can ask again.
    await eventually(() => asked() >= first + 2, 15_000);
    one.close();
  });
});
