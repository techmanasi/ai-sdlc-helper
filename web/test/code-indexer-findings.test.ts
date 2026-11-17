import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { createCodeSetup } from 'ai-sdlc-helper';

let base: string;
let root: string;
let bin: string;
let env: NodeJS.ProcessEnv;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const config = () => path.join(root, 'sdlc.config.json');

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'index-findings-'));
  root = path.join(base, 'project');
  bin = path.join(base, 'bin');
  fs.mkdirSync(root);
  fs.mkdirSync(bin);
  env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, AI_SDLC_HELPER_CONFIG_DIR: path.join(base, 'personal') };
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function fixture(body: string) {
  fs.writeFileSync(path.join(bin, 'graft'), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
}

async function until(check: () => boolean, limit = 4000) {
  const end = Date.now() + limit;
  while (!check()) {
    if (Date.now() > end) throw new Error('fixture did not reach expected state');
    await pause(20);
  }
}

describe('code indexer review findings', () => {
  it.each([false, true])('bounds a multi-megabyte line (newline: %s)', async newline => {
    fixture(`process.stdout.write('x'.repeat(2 * 1024 * 1024) + ${newline ? "'\\n'" : "''"}, () => process.exit(1));`);
    const setup = createCodeSetup({ env });
    setup.start(root, 'graft');
    await until(() => setup.operation(root).status !== 'running');
    const op = setup.operation(root);
    expect(op.status).toBe('failed');
    expect(Buffer.byteLength(op.output.join('\n'))).toBeLessThanOrEqual(32 * 1024);
  });

  it.each(['edited', 'created', 'malformed'])('re-reads %s configuration after the build', async mode => {
    fixture(`const fs = require('node:fs');
fs.writeFileSync('started', '');
const timer = setInterval(() => { if (fs.existsSync('release')) { clearInterval(timer); fs.mkdirSync('graft'); } }, 10);`);
    if (mode !== 'created') fs.writeFileSync(config(), JSON.stringify({ agent: { codeSearch: 'none', model: 'old' }, extra: 'old' }));
    const setup = createCodeSetup({ env });
    setup.start(root, 'graft');
    await until(() => fs.existsSync(path.join(root, 'started')));
    const updated = { agent: { codeSearch: 'none', model: 'new' }, extra: 'new' };
    fs.writeFileSync(config(), mode === 'malformed' ? '{invalid' : JSON.stringify(updated));
    fs.writeFileSync(path.join(root, 'release'), '');
    await until(() => setup.operation(root).status !== 'running');
    const op = setup.operation(root);
    if (mode === 'malformed') {
      expect(op.status).toBe('failed');
      expect(op.error).toMatch(/saving configuration/i);
      expect(fs.readFileSync(config(), 'utf8')).toBe('{invalid');
    } else {
      expect(op.status).toBe('succeeded');
      expect(JSON.parse(fs.readFileSync(config(), 'utf8'))).toEqual({ ...updated, agent: { ...updated.agent, codeSearch: 'graft' } });
    }
  });

  it('holds the guard until a SIGTERM-ignoring build is killed', async () => {
    fixture(`const fs = require('node:fs');
process.on('SIGTERM', () => fs.writeFileSync('term', ''));
fs.writeFileSync('pid', String(process.pid));
setInterval(() => fs.writeFileSync('heartbeat', String(Date.now())), 25);`);
    const setup = createCodeSetup({ env, timeoutMs: 100, killGraceMs: 700 });
    setup.start(root, 'graft');
    await until(() => fs.existsSync(path.join(root, 'term')));
    const pid = Number(fs.readFileSync(path.join(root, 'pid'), 'utf8'));
    let conflict = false;
    try { setup.start(root, 'graft'); } catch (e) { conflict = (e as { status?: number }).status === 409; }
    await pause(1000);
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(conflict).toBe(true);
    expect(alive).toBe(false);
  });

  it('requests a refresh for a successful operation found on reopening', async () => {
    const modulePath = '../ui/src/codeIndexerState.js';
    const { setupChanged } = await import(modulePath) as { setupChanged: (openedWith: string | null, now: string) => boolean };
    expect(setupChanged('running', 'succeeded')).toBe(true);
    expect(setupChanged(null, 'succeeded')).toBe(true);
    expect(setupChanged(null, 'running')).toBe(false);
    expect(setupChanged(null, 'failed')).toBe(false);
  });
});
