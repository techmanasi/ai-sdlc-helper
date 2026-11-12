import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { alive, isRunning, readRecord, runState, writeRecord, type RunRecord } from '../src/runs/records.js';
import { identity, procStart, sameProcess } from '../src/runs/proc.js';
import { Status } from '../src/pipeline/status.js';
import { tmp } from './helpers.js';

const root = path.resolve(__dirname, '..');
const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  slug: 'tok', worktree: '/w', pid: 0, started: '2026-11-12T10:00:00', state: 'running', exit_code: '', interrupted: false, finished: '', message: '', ...over,
});
const unix = process.platform !== 'win32';

describe('writing a run record', () => {
  it('two processes writing the same record never fail and never leave a record that cannot be read', async () => {
    const dir = tmp('records-');
    const bundle = path.join(dir, 'records.mjs');
    buildSync({ entryPoints: [path.join(root, 'src/runs/records.ts')], bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent' });
    const child = path.join(dir, 'child.mjs');
    fs.writeFileSync(child, `import { writeRecord } from './records.mjs';
const [reg, who] = process.argv.slice(2);
for (let i = 0; i < 400; i++) writeRecord(reg, { slug: 'tok', worktree: '/w', pid: 0, started: 's', state: 'running', exit_code: '', interrupted: false, finished: '', message: who + ':' + i + ':' + 'x'.repeat(2000) });
`);
    const reg = path.join(dir, 'reg');
    writeRecord(reg, record());
    const done: number[] = [];
    const run = (who: string) => new Promise<void>(res => spawn('node', [child, reg, who], { stdio: 'ignore' }).on('close', c => { done.push(c ?? -1); res(); }));
    const writers = Promise.all([run('a'), run('b')]);
    let reads = 0;
    while (done.length < 2) {
      const rec = readRecord(reg, 'tok');
      expect(rec && rec.slug).toBe('tok');
      reads++;
      await new Promise(r => setImmediate(r));
    }
    await writers;
    expect(done).toEqual([0, 0]);
    expect(reads).toBeGreaterThan(0);
    expect(readRecord(reg, 'tok')!.message).toMatch(/^[ab]:399:/);
    expect(fs.readdirSync(reg).filter(n => n.endsWith('.tmp'))).toEqual([]);
  }, 30_000);
});

describe.runIf(unix)('process identity', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; });

  it('a process is itself by pid and start time, and another start time is another process', () => {
    const me = identity(process.pid);
    expect(me.start).toMatch(/\d{4}$/);
    expect(procStart(process.pid)).toBe(me.start);
    expect(sameProcess(me)).toBe(true);
    expect(alive(process.pid, me.start)).toBe(true);
    expect(alive(process.pid, 'Thu Jan 1 00:00:00 1970')).toBe(false);
    expect(sameProcess({ pid: process.pid, start: 'Thu Jan 1 00:00:00 1970' })).toBe(false);
    expect(procStart(0)).toBe('');
  });

  it('a record whose pid now belongs to another process is not running; one without a start time goes by the pid as before', () => {
    const start = procStart(process.pid);
    expect(isRunning(record({ pid: process.pid, supervisor: { pid: process.pid, start } }))).toBe(true);
    expect(runState(record({ pid: process.pid, supervisor: { pid: process.pid, start } }))).toBe('running');
    const reused = record({ pid: process.pid, supervisor: { pid: process.pid, start: 'Thu Jan 1 00:00:00 1970' } });
    expect(isRunning(reused)).toBe(false);
    expect(runState(reused)).toBe('stopped');
    expect(isRunning(record({ pid: process.pid }))).toBe(true);
    expect(isRunning(record({ pid: process.pid, supervisor: { pid: process.pid, start: '' } }))).toBe(true);
    // An identity that names another pid says nothing about this one.
    expect(isRunning(record({ pid: process.pid, supervisor: { pid: 1, start: 'Thu Jan 1 00:00:00 1970' } }))).toBe(true);
  });

  it('the start time rides on the ps call that was already made: one ps per check, with or without it', () => {
    const real = spawnSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).stdout.trim();
    const bin = tmp('records-bin-');
    const log = path.join(bin, 'ps-calls.txt');
    const start = procStart(process.pid);
    fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath}`;
    expect(isRunning(record({ pid: process.pid }))).toBe(true);
    expect(isRunning(record({ pid: process.pid, supervisor: { pid: process.pid, start } }))).toBe(true);
    expect(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('the status file carries the pipeline\'s start time next to its pid', () => {
    const file = path.join(tmp('records-status-'), 'status.json');
    const s = new Status(file, 'tok');
    s.write();
    const line = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(line.pid).toBe(process.pid);
    expect(line.pid_start).toBe(procStart(process.pid));
    const other = new Status(file, 'tok', 424242);
    expect(other.line().pid_start).toBeUndefined();
  });
});
