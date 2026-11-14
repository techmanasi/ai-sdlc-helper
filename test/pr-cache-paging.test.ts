import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  PR_STATUS_FILE, clearPrCache, findOrCreatePr, forgetPrStatuses, getPrStatusAsync, keepPrStatusIn, peekPrStatus, prefetchPrStatuses,
} from '../src/pipeline/finalise.js';

const REPO = 'https://github.com/o/r';
const link = (n: number) => `${REPO}/pull/${n}`;
/** The links of PRs hi down to lo. */
const span = (hi: number, lo: number) => Array.from({ length: hi - lo + 1 }, (_, i) => link(hi - i));
let dir: string;
let env: NodeJS.ProcessEnv;

/**
 * A fake gh. `api graphql`: the page of state/pages.json the cursor names (page N's cursor is "cN"), failing when
 * state/fail-<N> exists. `pr view <x>`: state/view.json[x], else "no pull requests found". `pr create`: prints
 * state/create.txt. `pr list`: nothing found. Every call is logged as one JSON line in state/calls.log.
 */
function fakeGh(): void {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const st = ${JSON.stringify(path.join(dir, 'state'))};
const a = process.argv.slice(2);
fs.appendFileSync(st + '/calls.log', JSON.stringify(a) + '\\n');
const read = f => JSON.parse(fs.readFileSync(st + '/' + f, 'utf8'));
if (a[0] === 'api' && a[1] === 'graphql') {
  const cur = a.find(x => x.startsWith('after='));
  const n = cur ? Number(cur.slice(7).replace('c', '')) : 1;
  if (fs.existsSync(st + '/fail-' + n)) { process.stderr.write('HTTP 502: bad gateway on page ' + n + '\\n'); process.exit(1); }
  const pages = read('pages.json');
  const nodes = pages[n - 1] || [];
  const hasNextPage = n < pages.length;
  process.stdout.write(JSON.stringify({ data: { repository: { url: ${JSON.stringify(REPO)}, pullRequests: { pageInfo: { hasNextPage, endCursor: hasNextPage ? 'c' + (n + 1) : null }, nodes } } } }));
} else if (a[0] === 'pr' && a[1] === 'view') {
  const views = fs.existsSync(st + '/view.json') ? read('view.json') : {};
  if (!views[a[2]]) { process.stderr.write('no pull requests found for branch "' + a[2] + '"\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify(views[a[2]]));
} else if (a[0] === 'pr' && a[1] === 'create') {
  process.stdout.write(fs.readFileSync(st + '/create.txt', 'utf8'));
} else process.exit(1);
`, { mode: 0o755 });
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
const state = (f: string) => path.join(dir, 'state', f);
const calls = (): string[][] => { try { return fs.readFileSync(state('calls.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]); } catch { return []; } };
const pageCalls = () => calls().filter(c => c[0] === 'api' && c[1] === 'graphql');

/** A PR as GitHub's GraphQL gives it: a finished check run, a running one (no conclusion, no end) and a commit status. */
const node = (n: number) => ({
  url: link(n), state: n % 3 ? 'MERGED' : 'OPEN', number: n, isDraft: n % 5 === 0, headRefOid: `sha${n}`, mergeable: 'MERGEABLE',
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:00:00Z', completedAt: '2026-11-01T10:01:00Z', detailsUrl: `${REPO}/actions/runs/${n}/job/1`, checkSuite: { workflowRun: { workflow: { name: 'Lint' } } } },
    { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-11-01T10:00:00Z', completedAt: null, detailsUrl: `${REPO}/actions/runs/${n}/job/2`, checkSuite: { workflowRun: null } },
    { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', targetUrl: 'https://ci.example/1', createdAt: '2026-11-01T09:59:00Z' },
  ] } } } }] },
});
/** The same PR as `gh pr list/view --json url,state,number,isDraft,statusCheckRollup,headRefOid,mergeable` prints it. */
const ghJson = (n: number) => ({
  headRefOid: `sha${n}`, isDraft: n % 5 === 0, mergeable: 'MERGEABLE', number: n, state: n % 3 ? 'MERGED' : 'OPEN',
  statusCheckRollup: [
    { __typename: 'CheckRun', completedAt: '2026-11-01T10:01:00Z', conclusion: 'SUCCESS', detailsUrl: `${REPO}/actions/runs/${n}/job/1`, name: 'lint', startedAt: '2026-11-01T10:00:00Z', status: 'COMPLETED', workflowName: 'Lint' },
    { __typename: 'CheckRun', completedAt: '0001-01-01T00:00:00Z', conclusion: '', detailsUrl: `${REPO}/actions/runs/${n}/job/2`, name: 'e2e', startedAt: '2026-11-01T10:00:00Z', status: 'IN_PROGRESS', workflowName: '' },
    { __typename: 'StatusContext', context: 'ci/legacy', startedAt: '2026-11-01T09:59:00Z', state: 'SUCCESS', targetUrl: 'https://ci.example/1' },
  ],
  url: link(n),
});
/** Pages of 100 PRs, newest first: 300..201, 200..101, 100..1, without the numbers in <gaps>. */
const pages = (gaps: number[] = []) => {
  const range = (hi: number) => Array.from({ length: 100 }, (_, i) => hi - i).filter(n => !gaps.includes(n)).map(node);
  fs.writeFileSync(state('pages.json'), JSON.stringify([range(300), range(200), range(100)]));
};

beforeEach(() => {
  forgetPrStatuses();
  clearPrCache();
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-paging-')));
  fs.mkdirSync(path.join(dir, 'state'));
  fakeGh();
  pages();
});

describe('the PR list read page by page', () => {
  test('stops after the page that holds the last wanted PR', async () => {
    expect(await prefetchPrStatuses(dir, [link(290), link(250), link(210)], env)).toBe(3);
    expect(pageCalls()).toHaveLength(1);
    expect(peekPrStatus(dir, link(210))?.status?.number).toBe(210);
  });

  test('walks further pages when enough wanted PRs are older than the first page', async () => {
    expect(await prefetchPrStatuses(dir, [link(290), ...span(150, 120)], env)).toBe(32);
    expect(pageCalls()).toHaveLength(2);
    expect(pageCalls()[1]).toContain('after=c2');
    expect(peekPrStatus(dir, link(120))?.status?.number).toBe(120);
  });

  test('a wanted number above the page\'s smallest that is not on it, or another repository\'s link, stops the list: they are left for gh pr view', async () => {
    pages([260]);
    const other = 'https://github.com/x/y/pull/5';
    expect(await prefetchPrStatuses(dir, [link(290), link(280), link(260), other], env)).toBe(2);
    expect(pageCalls()).toHaveLength(1);
    expect(peekPrStatus(dir, link(260))).toBeNull();
    expect(peekPrStatus(dir, other)).toBeNull();
    // The one left over is then asked for on its own, as before.
    fs.writeFileSync(state('view.json'), JSON.stringify({ [link(260)]: ghJson(260) }));
    expect((await getPrStatusAsync(dir, link(260), env)).status?.number).toBe(260);
  });

  test('stops when the pages still to read would take longer than one gh pr view per link they could find', async () => {
    // #5 is two pages past the first: one gh pr view is quicker than two more pages.
    expect(await prefetchPrStatuses(dir, [link(290), link(280), link(5)], env)).toBe(2);
    expect(pageCalls()).toHaveLength(1);
    expect(peekPrStatus(dir, link(5))).toBeNull();
    // Fifteen links one page further: four rounds of gh pr view at most, quicker than a page; sixteen are worth it.
    clearPrCache();
    expect(await prefetchPrStatuses(dir, [link(290), ...span(195, 181)], env)).toBe(1);
    expect(pageCalls()).toHaveLength(2);
    clearPrCache();
    expect(await prefetchPrStatuses(dir, [link(290), ...span(195, 180)], env)).toBe(17);
    expect(pageCalls()).toHaveLength(4);
  });

  test('reads to the last page when the links there are worth it, and stops when there is no next page', async () => {
    expect(await prefetchPrStatuses(dir, [link(290), ...span(40, 1)], env)).toBe(41);
    expect(pageCalls()).toHaveLength(3);
    pages([77]);
    clearPrCache();
    expect(await prefetchPrStatuses(dir, span(99, 60), env)).toBe(39);
    expect(pageCalls()).toHaveLength(6); // 3 more: the last page has no next one
  });

  test('a failed page marks the links not yet found failed, reports each to onError, and keeps what earlier pages found', async () => {
    fs.writeFileSync(state('fail-2'), '');
    const errors: Array<[string, string]> = [];
    expect(await prefetchPrStatuses(dir, [link(290), ...span(150, 131)], env, (k, m) => errors.push([k, m]))).toBe(1);
    expect(pageCalls()).toHaveLength(2);
    expect(errors.map(e => e[0]).sort()).toEqual(span(150, 131).sort());
    expect(errors[0][1]).toMatch(/gh api graphql \(pull requests, page 2\) exited with 1: HTTP 502: bad gateway on page 2/);
    expect(peekPrStatus(dir, link(150))).toMatchObject({ status: null, failed: true, error: errors[0][1] });
    expect(peekPrStatus(dir, link(290))).toMatchObject({ status: { number: 290 } });
    expect(peekPrStatus(dir, link(290))?.failed).toBeUndefined();
  });

  test('a PR read from a page has the very status gh pr view (the same JSON as gh pr list) gives', async () => {
    const wanted = [300, 299, 290, 250];
    await prefetchPrStatuses(dir, wanted.map(link), env);
    const fromList = wanted.map(n => peekPrStatus(dir, link(n))?.status);
    forgetPrStatuses();
    fs.writeFileSync(state('view.json'), JSON.stringify(Object.fromEntries(wanted.map(n => [link(n), ghJson(n)]))));
    const fromView = await Promise.all(wanted.map(async n => (await getPrStatusAsync(dir, link(n), env)).status));
    expect(fromView.every(Boolean)).toBe(true);
    expect(JSON.stringify(fromList)).toBe(JSON.stringify(fromView));
  });
});

describe('a new PR forgets only its own cached status', () => {
  test('creating a PR for one task keeps another task\'s status in memory and in pr-status.cache', async () => {
    const file = path.join(dir, 'runs', PR_STATUS_FILE);
    keepPrStatusIn(dir, file);
    fs.writeFileSync(state('view.json'), JSON.stringify({ [link(7)]: ghJson(7) }));
    await getPrStatusAsync(dir, link(7), env); // another task's PR
    await getPrStatusAsync(dir, 'sdlc/new', env); // the branch without a PR yet: GitHub says none
    const saved = () => Object.keys((JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Record<string, unknown> }).entries).sort();
    expect(saved()).toEqual([link(7), 'sdlc/new'].sort());

    fs.writeFileSync(state('create.txt'), `${link(8)}\n`);
    const path0 = process.env.PATH;
    process.env.PATH = env.PATH; // findOrCreatePr runs gh with the process's own environment
    try { expect(findOrCreatePr(dir, 'sdlc/new', 'T', 'B').url).toBe(link(8)); } finally { process.env.PATH = path0; }

    expect(peekPrStatus(dir, 'sdlc/new')).toBeNull();
    expect(peekPrStatus(dir, link(8))).toBeNull();
    expect(peekPrStatus(dir, link(7))?.status?.number).toBe(7);
    expect(saved()).toEqual([link(7)]);
    // A restart finds the other task's status, not the new PR's branch.
    forgetPrStatuses();
    keepPrStatusIn(dir, file);
    expect(peekPrStatus(dir, link(7))?.status?.number).toBe(7);
    expect(peekPrStatus(dir, 'sdlc/new')).toBeNull();
  });
});
