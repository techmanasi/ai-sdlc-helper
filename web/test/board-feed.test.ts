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
/** How often the board was built: the backlog asks git for the branches once per build. */
const builds = (): number => { try { return fs.readFileSync(path.join(base, 'git-calls.txt'), 'utf8').split('\n').filter(l => l.includes('for-each-ref')).length; } catch { return 0; } };

async function start(pollMs: number): Promise<RunningServer> {
  const env = { ...process.env, ...GIT_ENV, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), SDLC_TRACE: '0' };
  server = await startServer({ port: 0, env, cwd: repo, uiDir: path.join(base, 'ui'), pollMs, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
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
    expect(builds()).toBe(1);
    const second = await page(s);
    const third = await page(s);
    expect(second.board).toEqual(first.board);
    expect(third.board).toEqual(first.board);
    expect(builds()).toBe(1);
    for (const p of [first, second, third]) p.close();
  });

  test('a change reaches every page, from one build per tick', async () => {
    const s = await start(100);
    const pages = [await page(s), await page(s), await page(s)];
    const before = builds();
    fs.appendFileSync(path.join(repo, 'Docs/backlog/index.md'), '- [ ] `two` - Bug: Two\n');
    await eventually(() => pages.every(p => p.boards() >= 2));
    await eventually(() => builds() >= before + 3);
    const ticks = builds() - before;
    // Every page saw the change exactly once, and the builds did not multiply by the pages.
    expect(pages.map(p => p.boards())).toEqual([2, 2, 2]);
    await new Promise(r => setTimeout(r, 350));
    expect(builds() - before - ticks).toBeLessThanOrEqual(5);
    for (const p of pages) p.close();
  });

  test('the feed stops with its last page, and starts again for the next one', async () => {
    const s = await start(100);
    const one = await page(s);
    const two = await page(s);
    one.close();
    const withOne = builds();
    await eventually(() => builds() > withOne); // still ticking for the page that stayed
    two.close();
    await new Promise(r => setTimeout(r, 150));
    const stopped = builds();
    await new Promise(r => setTimeout(r, 400));
    expect(builds()).toBe(stopped);
    const again = await page(s);
    expect(again.board.items).toHaveLength(1);
    expect(builds()).toBeGreaterThan(stopped);
    again.close();
  });
});
