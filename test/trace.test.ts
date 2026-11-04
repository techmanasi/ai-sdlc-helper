import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TRACE_DEFAULTS, createTracer, microNow, rotateIfNeeded, dropOld, spawnSync, startTrace, stopTrace, traceFiles, traceSettings,
  type TraceLine,
} from '../src/trace.js';
import { tmp } from './helpers.js';

const lines = (file: string): TraceLine[] =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const root = path.resolve(__dirname, '..');

afterEach(() => stopTrace());

describe('the trace writer', () => {
  it('writes one JSON line per event with an integer microsecond time that never goes backwards', () => {
    const file = path.join(tmp(), 'ui-trace.jsonl');
    const t = createTracer({ file, settings: TRACE_DEFAULTS });
    for (let i = 0; i < 50; i++) t.add({ action: 'tick', why: 'test', n: i });
    t.flush();
    const got = lines(file);
    expect(got).toHaveLength(50);
    for (const l of got) expect(Number.isInteger(l.t)).toBe(true);
    for (let i = 1; i < got.length; i++) expect(got[i].t).toBeGreaterThan(got[i - 1].t);
    // epoch microseconds: about 1e15 now
    expect(got[0].t).toBeGreaterThan(1.5e15);
    expect(microNow()).toBeGreaterThan(got[49].t);
  });

  it('holds events in memory until the flush', () => {
    const file = path.join(tmp(), 'ui-trace.jsonl');
    const t = createTracer({ file, settings: TRACE_DEFAULTS, flushMs: 60_000 });
    t.add({ action: 'a' });
    expect(fs.existsSync(file)).toBe(false);
    t.close();
    expect(lines(file)).toHaveLength(1);
  });

  it('writes no file when the trace is off', () => {
    const file = path.join(tmp(), 'ui-trace.jsonl');
    const t = createTracer({ file, settings: { ...TRACE_DEFAULTS, enabled: false } });
    t.add({ action: 'a' });
    t.close();
    expect(fs.existsSync(file)).toBe(false);
    const off = traceSettings({}, { SDLC_TRACE: '0' });
    expect(off.settings.enabled).toBe(false);
  });

  it('keeps only the program, its first argument and the exit code of a command', () => {
    const dir = tmp();
    const file = path.join(dir, 'ui-trace.jsonl');
    startTrace({ file, settings: TRACE_DEFAULTS });
    spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel', 'secret-branch-name'], { encoding: 'utf8' });
    spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    stopTrace();
    const got = lines(file);
    expect(got.map(l => [l.action, l.why])).toEqual([['spawn:git', 'rev-parse'], ['spawn:ps', undefined]]);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(dir);
    expect(text).not.toContain('secret-branch-name');
    expect(got[0].code).toBeTypeOf('number');
    expect(got[0].ms).toBeGreaterThan(0);
  });

  it('the traced spawnSync returns what child_process returns', () => {
    const a = spawnSync('node', ['-e', 'process.stdout.write("x")'], { encoding: 'utf8' });
    const b = nodeSpawnSync('node', ['-e', 'process.stdout.write("x")'], { encoding: 'utf8' });
    expect([a.status, a.stdout]).toEqual([b.status, b.stdout]);
  });
});

describe('trace settings', () => {
  it('has the defaults of the plan', () => {
    expect(traceSettings(undefined, {}).settings).toEqual({ enabled: true, maxSizeKb: 5120, keepFiles: 4, maxAgeHours: 24 });
  });

  it('takes the file, and the environment on top', () => {
    const { settings, errors } = traceSettings({ maxSizeKb: 100, keepFiles: 2 }, { SDLC_TRACE_MAX_KB: '200', SDLC_TRACE_MAX_AGE_HOURS: '3' });
    expect(errors).toEqual([]);
    expect(settings).toEqual({ enabled: true, maxSizeKb: 200, keepFiles: 2, maxAgeHours: 3 });
  });

  it('falls back to the default for a bad value and says which', () => {
    const { settings, errors } = traceSettings({ maxSizeKb: -5, keepFiles: 1.5, enabled: 'yes' }, { SDLC_TRACE_KEEP: 'many' });
    expect(settings).toEqual(TRACE_DEFAULTS);
    expect(errors.join('\n')).toMatch(/maxSizeKb/);
    expect(errors.join('\n')).toMatch(/keepFiles/);
    expect(errors.join('\n')).toMatch(/enabled/);
    expect(errors.join('\n')).toMatch(/SDLC_TRACE_KEEP/);
  });
});

describe('rotation', () => {
  const settings = { ...TRACE_DEFAULTS, maxSizeKb: 1, keepFiles: 2 };

  it('rotates at the size limit and keeps keepFiles old files', () => {
    const dir = tmp();
    const file = path.join(dir, 'ui-trace.jsonl');
    const t = createTracer({ file, settings, rotate: true });
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 20; i++) t.add({ action: 'fill', why: `round-${round}`, n: i });
      t.flush();
    }
    const names = fs.readdirSync(dir).sort();
    expect(names).toEqual(['ui-trace.1.jsonl', 'ui-trace.2.jsonl', 'ui-trace.jsonl']);
    // time order across the files: oldest first, no line lost between the kept files, times never go back
    const all = traceFiles(file).flatMap(lines);
    for (let i = 1; i < all.length; i++) expect(all[i].t).toBeGreaterThan(all[i - 1].t);
  });

  it('does not rotate a small young file', () => {
    const file = path.join(tmp(), 'ui-trace.jsonl');
    fs.writeFileSync(file, 'x\n');
    expect(rotateIfNeeded(file, TRACE_DEFAULTS)).toBe(false);
  });

  it('rotates a file older than maxAgeHours, and drops rotated files older than twice that', () => {
    const dir = tmp();
    const file = path.join(dir, 'ui-trace.jsonl');
    const s = { ...TRACE_DEFAULTS, maxAgeHours: 1, keepFiles: 4 };
    fs.writeFileSync(file, '{"t":1,"action":"a"}\n');
    const now = Date.now();
    const old = new Date(now - 90 * 60_000);
    fs.utimesSync(file, old, old);
    expect(rotateIfNeeded(file, s, now)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'ui-trace.1.jsonl'))).toBe(true);
    // 90 minutes is under twice the limit: kept; 3 hours later it is dropped
    dropOld(file, s, now);
    expect(fs.existsSync(path.join(dir, 'ui-trace.1.jsonl'))).toBe(true);
    dropOld(file, s, now + 3 * 3600_000);
    expect(fs.existsSync(path.join(dir, 'ui-trace.1.jsonl'))).toBe(false);
  });
});

describe('several processes appending', () => {
  it('loses no line', async () => {
    const dir = tmp();
    const file = path.join(dir, 'ui-trace.jsonl');
    const bundle = path.join(dir, 'trace.mjs');
    buildSync({ entryPoints: [path.join(root, 'src/trace.ts')], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent' });
    const child = path.join(dir, 'child.mjs');
    fs.writeFileSync(child, `import { createTracer, TRACE_DEFAULTS } from './trace.mjs';
const t = createTracer({ file: process.argv[2], settings: TRACE_DEFAULTS, flushMs: 5 });
for (let i = 0; i < 300; i++) t.add({ action: 'from', why: process.argv[3], n: i });
t.close();
`);
    const run = (who: string) => new Promise<number>(res => spawn('node', [child, file, who], { stdio: 'ignore' }).on('close', c => res(c ?? -1)));
    expect(await Promise.all([run('a'), run('b'), run('c')])).toEqual([0, 0, 0]);
    const got = lines(file);
    expect(got).toHaveLength(900);
    for (const who of ['a', 'b', 'c']) expect(got.filter(l => l.why === who).map(l => l.n)).toEqual([...Array(300).keys()]);
  }, 30_000);
});

describe('the report script', () => {
  const script = path.join(root, 'scripts', 'trace-report.mjs');
  const fixture = (): string => {
    const dir = tmp();
    const file = path.join(dir, 'ui-trace.jsonl');
    const base = 1_700_000_000_000_000;
    const out: object[] = [];
    // one minute: 6 board rebuilds (5 unchanged, 1 changed, 10 ms each), 60 git spawns (2 ms each), 4 pings
    for (let i = 0; i < 6; i++) out.push({ t: base + i * 10e6, side: 'server', action: 'timer:board-rebuild', why: 'pollMs', ms: 10, changed: i === 3 });
    for (let i = 0; i < 60; i++) out.push({ t: base + i * 1e6, side: 'server', action: 'spawn:git', why: 'status', ms: 2, code: 0 });
    for (let i = 0; i < 4; i++) out.push({ t: base + i * 15e6, side: 'server', action: 'sse:ping' });
    out.push({ t: base + 60e6, side: 'server', action: 'sse:ping' });
    out.sort((a: any, b: any) => a.t - b.t);
    // the older half is in a rotated file
    const half = Math.floor(out.length / 2);
    fs.writeFileSync(path.join(dir, 'ui-trace.1.jsonl'), out.slice(0, half).map(o => JSON.stringify(o)).join('\n') + '\n');
    fs.writeFileSync(file, out.slice(half).map(o => JSON.stringify(o)).join('\n') + '\ntorn line {\n');
    return file;
  };

  it('prints one row per action with rates, the unchanged share and times, sorted by total time', () => {
    const r = nodeSpawnSync('node', [script, fixture(), '--json'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const { rows } = JSON.parse(r.stdout);
    expect(rows.map((x: { action: string }) => x.action)).toEqual(['spawn:git status', 'timer:board-rebuild pollMs', 'sse:ping']);
    const git = rows[0];
    expect(git.count).toBe(60);
    expect(git.perMin).toBeCloseTo(60, 0);
    expect(git.totalMsPerMin).toBeCloseTo(120, 0);
    expect(git.medianMs).toBe(2);
    const board = rows[1];
    expect(board.unchangedPct).toBe(83);
    expect(board.count).toBe(6);
    expect(rows[2].count).toBe(5);
    expect(rows[2].unchangedPct).toBeNull();
  });

  it('prints a table for people', () => {
    const r = nodeSpawnSync('node', [script, fixture()], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/spawn:git status\s+60/);
    expect(r.stdout).toMatch(/83%/);
  });

  it('says so when there is no trace', () => {
    const r = nodeSpawnSync('node', [script, path.join(tmp(), 'none.jsonl')], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no trace file/);
  });
});

describe('the page trace', () => {
  it('sums events into rows by action, sorted by total time, with the unchanged share', async () => {
    const { summarise } = await import('../web/ui/src/pageTrace.js');
    const base = 1_700_000_000_000_000;
    const rows = summarise([
      { t: base, side: 'client', action: 'request', why: 'GET /api/x', ms: 50, code: 200 },
      { t: base + 30e6, side: 'client', action: 'request', why: 'GET /api/x', ms: 70, code: 200 },
      { t: base + 45e6, side: 'client', action: 'stream', why: 'board', changed: true },
      { t: base + 60e6, side: 'client', action: 'stream', why: 'board', changed: false },
    ]);
    expect(rows.map(r => r.action)).toEqual(['request GET /api/x', 'stream board']);
    expect(rows[0]).toMatchObject({ count: 2, perMin: 2, totalMsPerMin: 120, unchangedPct: null });
    expect(rows[1]).toMatchObject({ count: 2, unchangedPct: 50 });
  });
});
