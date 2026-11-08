import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearPrCache, getPrStatusAsync, getPrStatusCached, onPrStatusChange } from '../src/pipeline/finalise.js';
import { listCompletedTasksAsync } from '../src/runs/completed.js';
import { runContext } from '../src/runs/index.js';

let dir: string;
let env: NodeJS.ProcessEnv;

/** A gh that logs "+" at its start and "-" at its end, sleeps <sleep> seconds, then prints the JSON in out.json (or fails when fail exists). */
function ghShim(sleep: number): void {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo + >> "${dir}/gh.log"
sleep ${sleep}
echo - >> "${dir}/gh.log"
[ -f "${dir}/fail" ] && exit 1
cat "${dir}/out.json"
`, { mode: 0o755 });
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
const answer = (state: string) => fs.writeFileSync(path.join(dir, 'out.json'), JSON.stringify({ url: 'https://github.com/o/r/pull/7', state, number: 7 }));
const starts = (): number => { try { return fs.readFileSync(path.join(dir, 'gh.log'), 'utf8').split('\n').filter(l => l === '+').length; } catch { return 0; } };
const ends = (): number => { try { return fs.readFileSync(path.join(dir, 'gh.log'), 'utf8').split('\n').filter(l => l === '-').length; } catch { return 0; } };
const maxAtOnce = (): number => {
  let n = 0; let max = 0;
  for (const l of fs.readFileSync(path.join(dir, 'gh.log'), 'utf8').split('\n')) { if (l === '+') max = Math.max(max, ++n); else if (l === '-') n--; }
  return max;
};
const until = async (f: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

/** Counts how often the event loop runs while <work> runs: a blocked loop counts almost none. */
async function ticksDuring<T>(work: () => Promise<T>): Promise<{ result: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  try { return { result: await work(), ticks }; } finally { clearInterval(timer); }
}

beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-status-'))); clearPrCache(); answer('OPEN'); });
afterEach(() => { vi.useRealTimers(); });

describe('PR status without blocking', () => {
  test('a cold read answers pending at once, the refresh runs in the background, and the next read has the value and its age', async () => {
    ghShim(2);
    const first = getPrStatusCached(dir, 'branch-a', env);
    expect(ends()).toBe(0); // answered while gh was still running
    expect(first).toMatchObject({ status: null, pending: true, ageMs: null });
    await until(() => getPrStatusCached(dir, 'branch-a', env).status !== null);
    const second = getPrStatusCached(dir, 'branch-a', env);
    expect(second.status).toMatchObject({ state: 'OPEN', number: 7 });
    expect(second.pending).toBe(false);
    expect(second.stale).toBe(false);
    expect(second.ageMs).toBeGreaterThanOrEqual(0);
    expect(starts()).toBe(1);
  });

  test('asking while a refresh runs shares it, and the event loop keeps running', async () => {
    ghShim(0.8);
    const { result, ticks } = await ticksDuring(() => Promise.all([getPrStatusAsync(dir, 'b', env), getPrStatusAsync(dir, 'b', env)]));
    expect(result[0].status?.url).toContain('/pull/7');
    expect(result[1].status?.url).toContain('/pull/7');
    expect(starts()).toBe(1);
    expect(ticks).toBeGreaterThan(15);
  });

  test('an old value is returned at once and refreshed behind it; the refreshed value shows on the next call', async () => {
    ghShim(0.3);
    await getPrStatusAsync(dir, 'c', env);
    answer('MERGED');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120_000);
    const old = getPrStatusCached(dir, 'c', env);
    expect(old.status?.state).toBe('OPEN');
    expect(old.stale).toBe(true);
    vi.useRealTimers();
    await until(() => getPrStatusCached(dir, 'c', env).status?.state === 'MERGED');
    expect(starts()).toBe(2);
  });

  test('a gh failure keeps the old value and marks it stale', async () => {
    ghShim(0.1);
    await getPrStatusAsync(dir, 'd', env);
    fs.writeFileSync(path.join(dir, 'fail'), '');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120_000);
    getPrStatusCached(dir, 'd', env);
    vi.useRealTimers();
    await until(() => getPrStatusCached(dir, 'd', env).stale);
    const after = getPrStatusCached(dir, 'd', env);
    expect(after.status?.state).toBe('OPEN');
    expect(after.stale).toBe(true);
  });

  test('a refresh that changes the result tells the listeners; one that does not, does not', async () => {
    ghShim(0.1);
    const seen: string[] = [];
    const off = onPrStatusChange(e => seen.push(`${e.branchOrUrl}:${e.status?.state}`));
    await getPrStatusAsync(dir, 'e', env);
    expect(seen).toEqual(['e:OPEN']);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120_000);
    getPrStatusCached(dir, 'e', env); // refresh finds the same value
    vi.useRealTimers();
    await until(() => starts() === 2);
    await until(() => ends() === 2);
    await new Promise(r => setTimeout(r, 200)); // gh has exited; let its result reach the listeners
    expect(seen).toEqual(['e:OPEN']);
    answer('MERGED');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 240_000);
    getPrStatusCached(dir, 'e', env);
    vi.useRealTimers();
    await until(() => seen.length === 2);
    expect(seen[1]).toBe('e:MERGED');
    off();
  });
});

describe('the Completed list', () => {
  function project(n: number) {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const run = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    const items = Array.from({ length: n }, (_, i) => `t${i}`);
    fs.mkdirSync(path.join(repo, 'Docs/backlog'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), `# Backlog\n\n${items.map(s => `- [x] \`${s}\` - Feature: ${s}`).join('\n')}\n`);
    for (const s of items) { fs.mkdirSync(path.join(repo, 'Docs/backlog', s)); fs.writeFileSync(path.join(repo, 'Docs/backlog', s, 'brief.md'), `# ${s}\n`); }
    fs.writeFileSync(path.join(repo, 'README.md'), 'x');
    run('add', '-A');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    return { repo, ctx: runContext(repo, env) };
  }

  test('5 tasks with a slow gh: at most 4 gh calls at once, the event loop keeps running, and the second call answers from the cache', async () => {
    ghShim(0.7);
    answer('MERGED');
    const { ctx } = project(5);
    const { result, ticks } = await ticksDuring(() => listCompletedTasksAsync(ctx));
    expect(result.map(t => t.slug).sort()).toEqual(['t0', 't1', 't2', 't3', 't4']);
    expect(starts()).toBe(5);
    expect(maxAtOnce()).toBe(4);
    expect(ticks).toBeGreaterThan(30);
    const again = await listCompletedTasksAsync(ctx); // every status is cached: no gh call starts, none is waited for
    expect(again).toHaveLength(5);
    expect(starts()).toBe(5);
  }, { retry: 2 }); // under a full-suite load a gh can wait more than its 3 s timeout just to start; the count then falls short
});
