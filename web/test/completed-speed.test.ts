// The Completed list endpoint on a fixed repository with a fake gh: the same JSON whatever the speed-ups, no gh call
// while the cache is fresh (also after a restart), and a slow or failing gh that still answers, shows and logs why.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { startServer, type RunningServer } from '../server/index.js';
import { forgetPrStatuses, settleBriefCleanups } from 'ai-sdlc-helper';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// The PRs the fake gh knows: by link for `pr view <url>`, by branch for `pr view <branch>`, all of them for `pr list`.
const PRS = [
  { url: 'https://github.com/o/shop/pull/1', number: 1, state: 'MERGED', branch: 'sdlc/alpha' },
  { url: 'https://github.com/o/shop/pull/2', number: 2, state: 'MERGED', branch: 'sdlc/bravo' },
  { url: 'https://github.com/o/shop/pull/3', number: 3, state: 'MERGED', branch: 'sdlc/charlie' },
  { url: 'https://github.com/o/shop/pull/4', number: 4, state: 'OPEN', branch: 'sdlc/delta' },
  { url: 'https://github.com/o/shop/pull/6', number: 6, state: 'MERGED', branch: 'sdlc/foxtrot' },
  { url: 'https://github.com/o/shop/pull/7', number: 7, state: 'MERGED', branch: 'sdlc/golf' },
];

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const dir = process.env.FAKE_GH_DIR; const a = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'gh-calls.txt'), a.slice(0, 3).join(' ') + '\\n');
const prs = JSON.parse(fs.readFileSync(path.join(dir, 'prs.json'), 'utf8'));
const full = p => ({ url: p.url, state: p.state, number: p.number, isDraft: false, headRefOid: 'a'.repeat(40), mergeable: p.state === 'OPEN' ? 'MERGEABLE' : 'UNKNOWN', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], headRefName: p.branch });
const mode = fs.existsSync(path.join(dir, 'gh-mode')) ? fs.readFileSync(path.join(dir, 'gh-mode'), 'utf8').trim() : 'ok';
setTimeout(() => {
  if (mode === 'fail') { process.stderr.write('HTTP 502: Bad Gateway (https://api.github.com/graphql)\\nTry again later.\\n'); process.exit(1); }
  if (a[0] === 'pr' && a[1] === 'view') {
    const p = prs.find(x => x.url === a[2] || x.branch === a[2]);
    if (p) { process.stdout.write(JSON.stringify(full(p)) + '\\n'); process.exit(0); }
    process.stderr.write('no pull requests found for branch "' + a[2] + '"\\n'); process.exit(1);
  }
  if (a[0] === 'pr' && a[1] === 'list') { process.stdout.write(JSON.stringify(prs.map(full)) + '\\n'); process.exit(0); }
  process.stderr.write('fake gh: unknown command\\n'); process.exit(1);
}, mode === 'slow' ? 5000 : 20);
`;

let base: string;
let repo: string;
let server: RunningServer | null = null;

const get = (s: RunningServer, p: string): Promise<{ status: number; body: string }> => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: s.port, path: p, headers: { 'x-sdlc-token': s.token } }, r => {
    let body = '';
    r.on('data', c => { body += c; });
    r.on('end', () => res({ status: r.statusCode || 0, body }));
  }).on('error', rej);
});
const ghCalls = () => fs.readFileSync(path.join(base, 'gh-calls.txt'), 'utf8').split('\n').filter(Boolean);
const brief = (slug: string, text: string) => { fs.mkdirSync(path.join(repo, 'Docs/backlog', slug), { recursive: true }); fs.writeFileSync(path.join(repo, 'Docs/backlog', slug, 'brief.md'), text); };
const linked = (n: number, rest = '') => `---\npr: https://github.com/o/shop/pull/${n}\n---\n\n# Task\n${rest}`;

/** A repository whose completed tasks cover every way the list derives a row (record, branch, remote-only branch, link from gh, open PR, archive). */
function seed() {
  repo = path.join(base, 'shop');
  fs.mkdirSync(path.join(repo, 'Docs/backlog'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), [
    '# Backlog', '',
    '- [x] `alpha` - Feature: Alpha with a record',
    '- [x] `bravo` - Bug: Bravo dated by its branch',
    '- [x] `charlie` - Feature: Charlie linked by gh',
    '- [x] `delta` - Feature: Delta with an open PR',
    '- [x] `echo` - Chore: Echo without a PR',
    '- [ ] `hotel` - Feature: Hotel not done',
    '', '## Archive', '',
    '- [x] `golf` - Feature: Golf archived', '',
  ].join('\n'));
  brief('alpha', linked(1));
  brief('bravo', linked(2));
  brief('charlie', '# Charlie\n\nType: feature\n');
  brief('delta', linked(4));
  brief('echo', '# Echo\n');
  brief('foxtrot', linked(6, '\nType: bug\nPriority: P1\n'));
  brief('golf', linked(7));
  brief('hotel', '# Hotel\n');
  fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'init'], { GIT_COMMITTER_DATE: '2026-09-01T08:00:00+02:00', GIT_AUTHOR_DATE: '2026-09-01T08:00:00+02:00' });
  // bravo: a local branch whose last commit gives the date; charlie: only a remote branch (git log of the bare name does not find it).
  git(repo, ['branch', 'sdlc/bravo']);
  git(repo, ['checkout', '-q', 'sdlc/bravo']);
  fs.writeFileSync(path.join(repo, 'bravo.txt'), 'b\n');
  git(repo, ['add', 'bravo.txt']);
  git(repo, ['commit', '-q', '-m', 'bravo'], { GIT_COMMITTER_DATE: '2026-10-05T12:30:00+05:30', GIT_AUTHOR_DATE: '2026-10-05T12:30:00+05:30' });
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['update-ref', 'refs/remotes/origin/sdlc/charlie', 'sdlc/bravo']);
  const reg = path.join(repo, '.git', 'sdlc-runs');
  fs.mkdirSync(reg, { recursive: true });
  const rec = (slug: string, finished: string, extra = {}) => fs.writeFileSync(path.join(reg, `${slug}.json`), JSON.stringify({ slug, worktree: '', pid: 0, started: finished, state: 'exited', exit_code: '0', interrupted: false, finished, message: '', branch: `sdlc/${slug}`, base: 'main', ...extra }));
  rec('alpha', '2026-10-20T09:00:00');
  rec('foxtrot', '2026-10-25T10:00:00', { base: 'develop' });
  rec('golf', '2026-10-01T10:00:00');
  fs.mkdirSync(path.join(base, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(base, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  fs.mkdirSync(path.join(base, 'bin'));
  fs.writeFileSync(path.join(base, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(base, 'prs.json'), JSON.stringify(PRS));
  fs.writeFileSync(path.join(base, 'gh-calls.txt'), '');
}

const envFor = (extra: Record<string, string> = {}) => ({ ...process.env, ...GIT_ENV, PATH: `${path.join(base, 'bin')}:${process.env.PATH}`, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'config'), SDLC_TRACE: '0', FAKE_GH_DIR: base, ...extra });
const start = (extra: Record<string, string> = {}) => startServer({ port: 0, env: envFor(extra), cwd: repo, uiDir: path.join(base, 'ui'), cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
const completed = async (s: RunningServer) => {
  const r = await get(s, '/api/projects/shop/completed');
  expect(r.status).toBe(200);
  return JSON.parse(r.body);
};

beforeEach(() => {
  forgetPrStatuses();
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-completed-')));
  seed();
});
afterEach(async () => {
  if (server) await server.close();
  server = null;
  forgetPrStatuses();
});

// The list as main (851a137) answered it before the speed-ups, for this repository and these gh answers.
const EXPECTED = {
  completed: [
    {slug: 'foxtrot', title: 'foxtrot', type: 'bug', priority: 'P1', branch: 'sdlc/foxtrot', base: 'develop', pr: 'https://github.com/o/shop/pull/6', prState: 'MERGED', archived: false, date: '2026-10-25T10:00:00'},
    {slug: 'alpha', title: 'Alpha with a record', type: 'feature', priority: null, branch: 'sdlc/alpha', base: 'main', pr: 'https://github.com/o/shop/pull/1', prState: 'MERGED', archived: false, date: '2026-10-20T09:00:00'},
    {slug: 'bravo', title: 'Bravo dated by its branch', type: 'bug', priority: null, branch: 'sdlc/bravo', base: 'main', pr: 'https://github.com/o/shop/pull/2', prState: 'MERGED', archived: false, date: '2026-10-05T12:30:00+05:30'},
    {slug: 'golf', title: 'Golf archived', type: 'feature', priority: null, branch: 'sdlc/golf', base: 'main', pr: 'https://github.com/o/shop/pull/7', prState: 'MERGED', archived: true, date: '2026-10-01T10:00:00'},
    {slug: 'charlie', title: 'Charlie linked by gh', type: 'feature', priority: null, branch: 'sdlc/charlie', base: 'main', pr: 'https://github.com/o/shop/pull/3', prState: 'MERGED', archived: false, date: null},
    {slug: 'echo', title: 'Chore: Echo without a PR', type: null, priority: null, branch: 'sdlc/echo', base: 'main', pr: null, prState: null, archived: false, date: null},
  ],
};

const traceLines = () => {
  const f = path.join(base, 'config', 'ui-trace.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { t: number; action: string; why?: string; phases?: Record<string, number> }) : [];
};

describe('the Completed list endpoint', () => {
  test('answers the same list as before for a fixed repository and fixed gh answers, and links the PR gh found in the brief', async () => {
    server = await start();
    expect(await completed(server)).toEqual(EXPECTED);
    expect(fs.readFileSync(path.join(repo, 'Docs/backlog/charlie/brief.md'), 'utf8')).toContain('pr: https://github.com/o/shop/pull/3');
    // The links are asked for in one list; only the branches without a link (charlie, echo) get their own call.
    expect(ghCalls().sort()).toEqual(['pr list --state', 'pr view sdlc/charlie', 'pr view sdlc/echo']);
  });

  test('makes no gh call while the statuses are fresh, also after a restart that finds pr-status.cache', async () => {
    server = await start();
    await completed(server);
    const first = ghCalls().length;
    expect(await completed(server)).toEqual(EXPECTED);
    expect(ghCalls().length).toBe(first);
    await server.close();
    forgetPrStatuses(); // what a restart does to the memory: the file stays
    server = await start();
    expect(await completed(server)).toEqual(EXPECTED);
    expect(ghCalls().length).toBe(first);
  });

  test('with gh failing it still answers, shows the failure on the rows and in prErrors, and keeps gh\'s whole message in errors.log', async () => {
    fs.writeFileSync(path.join(base, 'gh-mode'), 'fail');
    server = await start();
    const body = await completed(server);
    const alpha = body.completed.find((t: { slug: string }) => t.slug === 'alpha');
    expect(alpha).toMatchObject({ pr: 'https://github.com/o/shop/pull/1', prState: null });
    expect(alpha.prError).toMatch(/HTTP 502: Bad Gateway/);
    expect(body.prErrors.map((e: { slug: string }) => e.slug).sort()).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']);
    const log = fs.readFileSync(path.join(repo, 'Docs/backlog/alpha/logs/errors.log'), 'utf8');
    expect(log).toContain('HTTP 502: Bad Gateway (https://api.github.com/graphql)\nTry again later.');
    expect(log).toContain('completed tasks: pull request status of https://github.com/o/shop/pull/1');
    // The failure is not asked again at every load (it waits for the poll time), and the list still says it failed.
    const calls = ghCalls().length;
    const again = await completed(server);
    expect(ghCalls().length).toBe(calls);
    expect(again.prErrors).toHaveLength(7);
  });

  test('with gh slower than its timeout it answers once the calls are stopped, and says so', async () => {
    fs.writeFileSync(path.join(base, 'gh-mode'), 'slow');
    server = await start({ SDLC_PR_TIMEOUT_MS: '300' });
    const t0 = Date.now();
    const body = await completed(server);
    expect(Date.now() - t0).toBeLessThan(4500); // the fake gh takes 5 s; the list's own limit is 4 x 300 ms
    const echo = body.completed.find((t: { slug: string }) => t.slug === 'echo');
    expect(echo.prError).toMatch(/gh pr view sdlc\/echo .*stopped after 300 ms/s);
    expect(body.prErrors.find((e: { slug: string }) => e.slug === 'alpha').message).toMatch(/gh pr list .*stopped after 1200 ms/s);
    expect(fs.readFileSync(path.join(repo, 'Docs/backlog/echo/logs/errors.log'), 'utf8')).toMatch(/stopped after 300 ms/);
  });

  test('a load runs no blocking git or gh call, from the first request on, and traces its phases', async () => {
    server = await startServer({ port: 0, env: envFor({ SDLC_TRACE: '1', SDLC_PR_POLL_MS: '1000' }), cwd: repo, uiDir: path.join(base, 'ui'), traceFlushMs: 20, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
    await new Promise(r => setTimeout(r, 300)); // what the server does once at its start is not a load
    const blockingSince = async (from: number) => {
      await new Promise(r => setTimeout(r, 200));
      return traceLines().filter(e => e.t >= from && e.action.startsWith('spawn:') && !(e.why || '').startsWith('async'));
    };
    let from = Date.now() * 1000;
    expect(await completed(server)).toEqual(EXPECTED); // the first: the project's context is built now
    expect(await blockingSince(from)).toEqual([]);
    await new Promise(r => setTimeout(r, 1100)); // the open PR and the branch without one are due again
    from = Date.now() * 1000;
    expect(await completed(server)).toEqual(EXPECTED);
    expect(await blockingSince(from)).toEqual([]);
    expect(traceLines().filter(e => e.t >= from).find(e => e.action === 'completed')?.phases).toMatchObject({ keys: expect.any(Number), prs: expect.any(Number), git: expect.any(Number), build: expect.any(Number) });
  });

  test('merged runs with their own worktrees: the load runs no blocking call, and their briefs are cleaned after it answers', async () => {
    // alpha and bravo ran in worktrees, and linked their PR in the main checkout's brief too (uncommitted there).
    for (const slug of ['alpha', 'bravo']) {
      const wt = path.join(base, `wt-${slug}`);
      git(repo, ['worktree', 'add', '-q', '--detach', wt]);
      const recFile = path.join(repo, '.git', 'sdlc-runs', `${slug}.json`);
      const rec = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, 'utf8')) : { slug, pid: 0, state: 'exited', exit_code: '0', interrupted: false, message: '', branch: `sdlc/${slug}`, base: 'main', started: '', finished: '' };
      fs.writeFileSync(recFile, JSON.stringify({ ...rec, worktree: wt, root: repo }));
      brief(slug, '# Task\n');
    }
    git(repo, ['commit', '-q', '-am', 'briefs without their links']);
    brief('alpha', linked(1));
    brief('bravo', linked(2));
    server = await startServer({ port: 0, env: envFor({ SDLC_TRACE: '1' }), cwd: repo, uiDir: path.join(base, 'ui'), traceFlushMs: 20, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
    await new Promise(r => setTimeout(r, 300));
    const from = Date.now() * 1000;
    const body = await completed(server);
    expect(body.completed.filter((t: { prState: string }) => t.prState === 'MERGED').map((t: { slug: string }) => t.slug)).toEqual(expect.arrayContaining(['alpha', 'bravo']));
    await settleBriefCleanups();
    await new Promise(r => setTimeout(r, 200));
    expect(traceLines().filter(e => e.t >= from && e.action.startsWith('spawn:') && !(e.why || '').startsWith('async'))).toEqual([]);
    // Cleaned after the answer, one after the other: each brief is back to its committed text (charlie's link, from gh, stays).
    expect(fs.readFileSync(path.join(repo, 'Docs/backlog/alpha/brief.md'), 'utf8')).toBe('# Task\n');
    expect(fs.readFileSync(path.join(repo, 'Docs/backlog/bravo/brief.md'), 'utf8')).toBe('# Task\n');
    expect(git(repo, ['status', '--porcelain', '--', 'Docs/backlog/alpha', 'Docs/backlog/bravo'])).toBe('');
  });
});
