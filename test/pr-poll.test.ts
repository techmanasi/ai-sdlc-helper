import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PR_POLL_MS, clearPrCache, getPrStatusAsync, getPrStatusCached, prPollOptions, syncPrStatus } from '../src/pipeline/finalise.js';

let dir: string;
let env: NodeJS.ProcessEnv;

/** A gh that logs a line per call and prints the JSON in out.json (or fails when `fail` exists). */
function ghShim(): void {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
echo + >> "${dir}/gh.log"
[ -f "${dir}/fail" ] && exit 1
cat "${dir}/out.json"
`, { mode: 0o755 });
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}
const answer = (state: string) => fs.writeFileSync(path.join(dir, 'out.json'), JSON.stringify({ url: 'https://github.com/o/r/pull/7', state, number: 7 }));
const calls = (): number => { try { return fs.readFileSync(path.join(dir, 'gh.log'), 'utf8').split('\n').filter(l => l === '+').length; } catch { return 0; } };
const until = async (f: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-poll-'))); clearPrCache(); answer('OPEN'); ghShim(); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('PR status checked once an hour', () => {
  test('the web server reads with an hourly time; SDLC_PR_POLL_MS changes it', () => {
    expect(prPollOptions({})).toEqual({ ttlMs: PR_POLL_MS, retryFailed: false });
    expect(PR_POLL_MS).toBe(3_600_000);
    expect(prPollOptions({ SDLC_PR_POLL_MS: '5000' }).ttlMs).toBe(5000);
    expect(prPollOptions({ SDLC_PR_POLL_MS: 'x' }).ttlMs).toBe(PR_POLL_MS);
  });

  test('a known status is not asked for again within the hour, and is asked for again after it', async () => {
    const o = prPollOptions({});
    await getPrStatusAsync(dir, 'b', env, o);
    expect(calls()).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 59 * 60_000);
    expect(getPrStatusCached(dir, 'b', env, o)).toMatchObject({ stale: false, status: { state: 'OPEN' } });
    expect(calls()).toBe(1);
    answer('MERGED');
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect(getPrStatusCached(dir, 'b', env, o).stale).toBe(true);
    vi.useRealTimers();
    await until(() => getPrStatusCached(dir, 'b', env, o).status?.state === 'MERGED');
    expect(calls()).toBe(2);
  });

  test('a failed check waits for the next hour instead of trying on every read', async () => {
    const o = prPollOptions({});
    await getPrStatusAsync(dir, 'f', env, o);
    fs.writeFileSync(path.join(dir, 'fail'), '');
    await syncPrStatus(dir, 'f', env);
    expect(calls()).toBe(2);
    for (let i = 0; i < 5; i++) getPrStatusCached(dir, 'f', env, o);
    await new Promise(r => setTimeout(r, 200));
    expect(calls()).toBe(2);
    expect(getPrStatusCached(dir, 'f', env, o)).toMatchObject({ failed: true, status: { state: 'OPEN' } });
  });

  test('"no pull requests found" is an answer, not a failed check', async () => {
    fs.writeFileSync(path.join(dir, 'bin', 'gh'), '#!/bin/sh\necho + >> "' + dir + '/gh.log"\necho \'no pull requests found for branch "x"\' >&2\nexit 1\n', { mode: 0o755 });
    const r = await syncPrStatus(dir, 'x', env);
    expect(r).toMatchObject({ status: null, pending: false });
    expect(r.failed).toBeUndefined();
    expect(getPrStatusCached(dir, 'x', env, prPollOptions({}))).toMatchObject({ status: null, stale: false, pending: false });
    expect(calls()).toBe(1);
  });

  test('a merged PR is never asked for again', async () => {
    answer('MERGED');
    const o = prPollOptions({});
    await getPrStatusAsync(dir, 'm', env, o);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 48 * 3_600_000);
    expect(getPrStatusCached(dir, 'm', env, o)).toMatchObject({ stale: false, status: { state: 'MERGED' } });
    expect(calls()).toBe(1);
  });

  test('syncing asks GitHub at once, whatever the age, and answers the new status', async () => {
    await getPrStatusAsync(dir, 's', env, prPollOptions({}));
    answer('MERGED');
    const r = await syncPrStatus(dir, 's', env);
    expect(calls()).toBe(2);
    expect(r.status).toMatchObject({ state: 'MERGED', number: 7 });
    expect(r.ageMs).toBeLessThan(5000);
  });
});
