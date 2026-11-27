// The usage-limit wait is a record, not a guess from the status note: a status field writes it, a signal file ends it,
// and the real wait loop checks that signal. No text about a wait is shown without the record.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { AgentRequest } from '../src/pipeline/agent.js';
import { Status, clearStopWait, resetUntil, stopWaitPath, stopWaitPresent, waitRecord, waitTick } from '../src/pipeline/status.js';
import { tmp } from './helpers.js';
import { LOG, fixture, pipeline, statusOf } from './pipeline-fixture.js';

const now = new Date(2026, 0, 1, 0, 0, 0);
const LIMIT = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, api_error: 'usage_limit_reached', result: "You've hit your session limit · resets 1:10am (Asia/Dubai)", permission_denials: [] });
const result = () => JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', permission_denials: [] });

describe('the usage-limit wait record', () => {
  test('is written to status.json and cleared again; until is present only for a parsed reset clock', () => {
    const dir = tmp('sdlc-wait-');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'status.json');
    const s = new Status(file, 'a-run', 1);

    const withClock = waitRecord('resets 1:10am (Asia/Dubai)', now);
    expect(withClock).toEqual({ reason: 'usage-limit', since: now.toISOString(), until: new Date(2026, 0, 1, 1, 10).toISOString() });
    s.wait = withClock;
    s.write();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).wait).toEqual(withClock);

    s.wait = undefined;
    s.write();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).wait).toBeUndefined();

    expect(resetUntil('quota exceeded', now)).toBeUndefined();
    expect(waitRecord('usage limit reached', now)).toEqual({ reason: 'usage-limit', since: now.toISOString() });
    // A clock that has passed names the next occurrence; a 12-hour clock is read as such.
    expect(resetUntil('resets 1:10am', new Date(2026, 0, 1, 2, 0))).toBe(new Date(2026, 0, 2, 1, 10).toISOString());
    expect(resetUntil('resets 1:10pm', now)).toBe(new Date(2026, 0, 1, 13, 10).toISOString());
  });

  test('the tick loop stops on a stop-wait signal and otherwise waits the whole interval', async () => {
    let clock = 0;
    let checks = 0;
    const sleep = async (ms: number) => { clock += ms; };
    const elapsed = await waitTick({ seconds: 0.05, sleep, stopRequested: () => { checks++; return false; }, now: () => clock });
    expect(elapsed).toBe('elapsed');
    expect(clock).toBeGreaterThanOrEqual(50);
    expect(checks).toBeGreaterThan(1);

    checks = 0;
    const stopped = await waitTick({ seconds: 10, sleep, stopRequested: () => ++checks === 3, now: () => clock });
    expect(stopped).toBe('stop');
    expect(checks).toBe(3);

    const dir = tmp('sdlc-stop-wait-');
    fs.mkdirSync(dir, { recursive: true });
    const file = stopWaitPath(dir);
    expect(stopWaitPresent(dir)).toBe(false);
    fs.writeFileSync(file, '');
    expect(stopWaitPresent(dir)).toBe(true);
    clearStopWait(dir);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('a stop-wait signal in a running pipeline', () => {
  test('ends the wait, deletes the signal and pauses the run with a line in the output and errors.log', async () => {
    const f = fixture();
    const signal = path.join(f.dir, LOG, 'stop-wait');
    let calls = 0;
    const spawnAgent = async (req: AgentRequest) => {
      calls++;
      fs.writeFileSync(req.stdout, calls === 1 ? LIMIT : result());
      fs.writeFileSync(req.stderr, '');
      if (calls === 1) {
        fs.mkdirSync(path.dirname(signal), { recursive: true });
        fs.writeFileSync(signal, '');
      }
      return calls === 1 ? 1 : 0;
    };
    const r = await pipeline(f, { SDLC_LIMIT_RETRY: '0.05' }, { spawnAgent });
    expect(calls).toBe(1);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('stopped waiting for the usage limit at your request');
    expect(fs.existsSync(signal)).toBe(false);
    expect(statusOf(f.dir).wait).toBeUndefined();
    expect(fs.readFileSync(path.join(f.dir, LOG, 'errors.log'), 'utf8')).toContain('stop waiting');
  });

  test('a normal retry clears the wait record after the limit is over', async () => {
    const f = fixture();
    let calls = 0;
    let waitDuringRetry;
    const spawnAgent = async (req: AgentRequest) => {
      calls++;
      if (calls === 2) waitDuringRetry = statusOf(f.dir).wait;
      fs.writeFileSync(req.stdout, calls === 1 ? LIMIT : result());
      fs.writeFileSync(req.stderr, '');
      return calls === 1 ? 1 : 0;
    };
    const r = await pipeline(f, { SDLC_LIMIT_RETRY: '0.05' }, { spawnAgent });
    expect(calls).toBe(2);
    expect(waitDuringRetry).toMatchObject({ reason: 'usage-limit', until: expect.any(String) });
    expect(statusOf(f.dir).wait).toBeUndefined();
    expect(r.stdout).toContain("   .. usage limit over, 'spec-1' ran");
  });
});
