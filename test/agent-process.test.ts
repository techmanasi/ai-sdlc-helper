import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { spawnAgentProcess } from '../src/pipeline/agent-process.js';

describe('agent process lifecycle', () => {
  it('closes stdin and resolves a normal agent exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-agent-process-'));
    const out = path.join(dir, 'out');
    const err = path.join(dir, 'err');
    const code = await spawnAgentProcess({
      command: process.execPath,
      args: ['-e', "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('stdin-closed'));"],
      cwd: dir,
      env: process.env,
      stdout: out,
      stderr: err,
      timeoutMs: 5000,
    });
    expect(code).toBe(0);
    expect(fs.readFileSync(out, 'utf8')).toBe('stdin-closed');
  });

  it('terminates an agent that remains alive after its logical response', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-agent-process-'));
    const out = path.join(dir, 'out');
    const err = path.join(dir, 'err');
    const started = Date.now();
    const code = await spawnAgentProcess({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM',()=>process.exit(0)); console.log(JSON.stringify({type:'turn.completed'})); setInterval(()=>{},1000);"],
      cwd: dir,
      env: process.env,
      stdout: out,
      stderr: err,
      timeoutMs: 1000,
    });
    expect(code).not.toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // not killed before its 1 s timeout; a hang would hit the test timeout
    expect(fs.readFileSync(out, 'utf8')).toContain('turn.completed');
    expect(fs.readFileSync(err, 'utf8')).toContain('timed out');
  });

  it('honours an already-aborted signal and removes its listener after exit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-agent-process-'));
    const controller = new AbortController();
    controller.abort();
    const code = await spawnAgentProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: dir,
      env: process.env,
      stdout: path.join(dir, 'out'),
      stderr: path.join(dir, 'err'),
      signal: controller.signal,
      timeoutMs: 1000,
    });
    expect(code).not.toBe(0);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
