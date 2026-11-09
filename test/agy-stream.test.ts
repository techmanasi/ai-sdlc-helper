import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { AgyHarness, streamResult } from '../src/pipeline/harness/agy.js';
import { agentFacts } from '../src/pipeline/observe.js';
import { extract, loadState } from '../src/permissions/index.js';
import { tmp } from './helpers.js';

const OUT = '/work/outside/debug-error.log';
const event = (e: unknown) => JSON.stringify(e);
const stream = (extra: unknown[] = []) => [
  event({ event: 'init', init: { model: 'm' } }),
  event({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: { Path: OUT } } } }),
  event({ event: 'step_update', step_update: { step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'read_file', tool_info: { error: { message: `permission check failed for read_file "${OUT}": user denied permission for read_file(${OUT})` } } } }),
  ...extra,
  event({ event: 'result', result: { status: 'SUCCESS', response: '', duration_seconds: 1.5, num_turns: 1, usage: { total_tokens: 10 }, denied_actions: [{ action: 'read_file', display_name: 'ReadFile' }] } }),
].join('\n') + '\n';

const dirs: string[] = [];
afterEach(() => { delete process.env.SDLC_AGY_OUTPUT; for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const work = () => { const d = tmp('agy-stream-'); dirs.push(d); return d; };

describe('agy stream-json output', () => {
  test('the final result gets the path of each refused tool', () => {
    const r = streamResult(stream())!;
    expect(r.status).toBe('SUCCESS');
    expect(r.denied_actions).toEqual([{ action: 'read_file', display_name: 'ReadFile', detail: OUT }]);
  });

  test('a refusal the result does not list is added; text that is not a stream, or has no result, gives null', () => {
    const noList = stream().replace(',"denied_actions":[{"action":"read_file","display_name":"ReadFile"}]', '');
    expect(streamResult(noList)!.denied_actions).toEqual([{ action: 'read_file', detail: OUT }]);
    expect(streamResult('{"status":"SUCCESS","response":"x"}')).toBeNull();
    expect(streamResult(stream().split('\n').filter(l => !l.includes('"result"')).join('\n'))).toBeNull();
  });

  test('normalizeOutput leaves the result file as agy prints it with json, and keeps the stream beside it', () => {
    const d = work();
    const file = path.join(d, 'impl-1.json');
    fs.writeFileSync(file, stream());
    new AgyHarness().normalizeOutput(file);
    expect(fs.readFileSync(path.join(d, 'impl-1.stream'), 'utf8')).toBe(stream());
    const facts = agentFacts(file);
    expect(facts).toMatchObject({ durationSec: 1.5, turns: 1, tokens: 10, denied: [{ tool: 'read_file', detail: OUT }] });

    const plain = path.join(d, 'plain.json');
    fs.writeFileSync(plain, '{"status":"SUCCESS","response":"x"}');
    new AgyHarness().normalizeOutput(plain);
    expect(fs.readFileSync(plain, 'utf8')).toBe('{"status":"SUCCESS","response":"x"}');
    expect(fs.existsSync(path.join(d, 'plain.stream'))).toBe(false);
  });

  test('the refusal reaches the permission asks with its path, and stays pending though read_file is already allowed', () => {
    const d = work();
    fs.mkdirSync(path.join(d, 'logs'));
    const file = path.join(d, 'impl-1.json');
    fs.writeFileSync(file, stream());
    new AgyHarness().normalizeOutput(file);
    const pending = extract({ jsonFile: file, logFile: path.join(d, 'impl-1.log'), stateFile: path.join(d, 'logs', 'permissions.json'), stage: 'implement', cwd: d, allowed: ['read_file'] });
    expect(pending).toBe(1);
    expect(loadState(path.join(d, 'logs', 'permissions.json')).pending[0]).toMatchObject({ tool: 'read_file', detail: OUT, rule: 'read_file' });
  });

  test('SDLC_AGY_OUTPUT=json asks agy for json', () => {
    const args = (): string[] => new AgyHarness().compileStageArgs({ prompt: 'p', stage: 'implement', mode: 'acceptEdits', allowedCommands: [], cwd: '.' } as never).args;
    process.env.SDLC_AGY_OUTPUT = 'json';
    expect(args().slice(args().indexOf('--output-format'))[1]).toBe('json');
  });
});
