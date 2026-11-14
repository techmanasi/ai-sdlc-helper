// A run whose supervisor was killed from outside: its record is closed, and its orphaned pipeline stops itself.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';
import { closeGoneRuns, closeIfGone, type RunContext } from '../src/runs/index.js';
import { alive, readRecord, writeRecord, type RunRecord } from '../src/runs/records.js';
import { stageRecoveryHint } from '../src/pipeline/hints.js';
import { pipeline as cliPipeline } from '../src/cli/pipeline.js';
import { tmp } from './helpers.js';
import { SLUG, cleanEnv, fixture, read, LOG } from './pipeline-fixture.js';

vi.setConfig({ testTimeout: 120_000 });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 30_000) => { const t = Date.now(); while (!f() && Date.now() - t < ms) await sleep(50); return f(); };

/** A pid that is not alive: a process that has run and exited. */
async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(r => c.on('exit', r));
  return c.pid!;
}

describe('closeIfGone', () => {
  const setup = () => {
    const root = tmp('gone-');
    const reg = path.join(root, 'reg');
    const ctx = { root, reg, backlogDir: 'Docs/backlog' } as RunContext;
    const logs = path.join(root, 'Docs/backlog/s1/logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'status.json'), JSON.stringify({ stage: 'Implement', state: 'running' }));
    const rec = (pid: number): RunRecord => ({ slug: 's1', worktree: root, pid, started: '2026-01-01T00:00:00', state: 'running', exit_code: '', interrupted: false, finished: '', message: '' });
    return { ctx, reg, logs, rec };
  };

  test('closes a running record whose supervisor is dead, once, and keeps the reason', async () => {
    const { ctx, reg, logs, rec } = setup();
    const pid = await deadPid();
    writeRecord(reg, rec(pid));
    expect(closeIfGone(ctx, 's1')).toBe(true);
    const after = readRecord(reg, 's1')!;
    expect(after).toMatchObject({ state: 'exited', interrupted: true, message: `supervisor ${pid} is gone (killed or crashed) during Implement` });
    expect(after.finished).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(fs.readFileSync(path.join(logs, 'errors.log'), 'utf8')).toContain(after.message!);
    expect(fs.readFileSync(path.join(logs, 'run.out'), 'utf8')).toContain(after.message!);
    const written = fs.readFileSync(path.join(reg, 's1.json'), 'utf8');
    expect(closeIfGone(ctx, 's1')).toBe(false);
    expect(fs.readFileSync(path.join(reg, 's1.json'), 'utf8')).toBe(written);
    expect(fs.readFileSync(path.join(logs, 'errors.log'), 'utf8').split(after.message!).length).toBe(2);
  });

  test('never touches a record whose supervisor is alive, nor a closed one', () => {
    const { ctx, reg, rec } = setup();
    writeRecord(reg, rec(process.pid));
    expect(closeGoneRuns(ctx)).toEqual([]);
    expect(readRecord(reg, 's1')).toMatchObject({ state: 'running', interrupted: false });
    writeRecord(reg, { ...rec(process.pid), pid: 0x7ffffff0, state: 'exited', exit_code: '0', finished: 'x' });
    expect(closeIfGone(ctx, 's1')).toBe(false);
  });
});

describe('the new diagnosis', () => {
  test('says the supervisor was killed and offers Resume at the stage', () => {
    const hint = stageRecoveryHint({
      slug: SLUG, stage: 'Implement', state: 'failed', exitCode: 1,
      runOut: ['supervisor 4242 is gone: stopping the run (it was killed from outside) during Implement'],
    });
    expect(hint.diagnosis).toContain('supervisor (process 4242) was killed from outside');
    expect(hint.autoAction?.label).toBe('Resume at Implement');
  });
});

describe('an orphaned pipeline', () => {
  test('stops itself, and kills its agent, when its supervisor is gone', async () => {
    const f = fixture({ spec: 'echo $$ > "$FAKE_DIR/agent.pid"; exec sleep 120' });
    const supervisor = spawn('sleep', ['120'], { stdio: 'ignore' });
    const out: string[] = [];
    const env = cleanEnv({ PATH: `${f.bin}:${process.env.PATH}`, FAKE_DIR: f.fake, AI_SDLC_HELPER_MODELS_FILE: path.join(f.fake, 'none.json'), SDLC_SUPERVISOR_PID: String(supervisor.pid), SDLC_SUPERVISOR_CHECK_MS: '200' });
    const running = cliPipeline(['pipeline', SLUG], ['--from', '--cwd', '--agent', '--model', '--effort'], { cwd: f.dir, env, out: (l: string) => { out.push(l); }, err: () => {} } as any);
    const pidFile = path.join(f.fake, 'agent.pid');
    expect(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '')).toBe(true);
    const agent = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(alive(agent)).toBe(true);
    process.kill(supervisor.pid!, 'SIGKILL');
    const t0 = Date.now();
    const code = await running;
    expect(code).toBe(1);
    expect(Date.now() - t0).toBeLessThan(15_000);
    const line = `supervisor ${supervisor.pid} is gone: stopping the run (it was killed from outside) during Spec`;
    expect(out.join('\n')).toContain(line);
    expect(read(f.dir, `${LOG}/errors.log`)).toContain(line);
    expect(await until(() => !alive(agent), 10_000)).toBe(true);
  });

  test('a pipeline without SDLC_SUPERVISOR_PID is not watched', async () => {
    const f = fixture({ spec: 'sleep 1' });
    const out: string[] = [];
    const env = cleanEnv({ PATH: `${f.bin}:${process.env.PATH}`, FAKE_DIR: f.fake, AI_SDLC_HELPER_MODELS_FILE: path.join(f.fake, 'none.json'), SDLC_SUPERVISOR_CHECK_MS: '50' });
    await cliPipeline(['pipeline', SLUG], ['--from', '--cwd', '--agent', '--model', '--effort'], { cwd: f.dir, env, out: (l: string) => { out.push(l); }, err: () => {} } as any);
    expect(out.join('\n')).not.toContain('is gone');
  });
});
