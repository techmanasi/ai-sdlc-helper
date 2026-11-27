// Run behaviour settings: the mapping to environment variables, the validation, the environment precedence, and the
// registry round-trip (mirroring the personal agent settings tests).
import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { runBehaviourErrors, runEnv, runEnvSet } from '../src/config/run-behaviour.js';
import { editOverrides, setRunBehaviour } from '../src/config/edit.js';
import { readRegistry, writeRegistry } from '../src/registry/projects.js';
import { pipelineEnv, runContext } from '../src/runs/index.js';
import { envSetNote, secondsError, variableNameError } from '../web/ui/src/runBehaviour.js';
import { project, tmp } from './helpers.js';

const registry = () => {
  const env = { AI_SDLC_HELPER_CONFIG_DIR: tmp() };
  writeRegistry([{ name: 'shop', path: '/p/shop', addedAt: '2026-01-01T00:00:00.000Z', overrides: { maxParallel: 3 } }], env);
  return env;
};

describe('run behaviour mapping', () => {
  test('maps the saved settings to the control and pipeline environment variables', () => {
    expect(runEnv({ allowMerged: true, limitRetry: 5, limitMaxWait: 600, env: { FOO: 'bar' } }, {})).toEqual({
      SDLC_ALLOW_MERGED: '1', SDLC_LIMIT_RETRY: '5', SDLC_LIMIT_MAX_WAIT: '600', FOO: 'bar',
    });
    expect(runEnv(undefined, {})).toEqual({});
    expect(runEnv({ allowMerged: false }, {})).toEqual({});
    expect(runEnv({ limitRetry: 0 }, {})).toEqual({ SDLC_LIMIT_RETRY: '0' });
  });

  test('a variable the server environment already sets wins over the saved one', () => {
    const env = { SDLC_LIMIT_RETRY: '10', FOO: 'server' };
    const run = { limitRetry: 5, env: { FOO: 'saved', BAR: 'saved' } };
    expect(runEnv(run, env)).toEqual({ BAR: 'saved' });
    expect(runEnvSet(run, env)).toEqual({ SDLC_LIMIT_RETRY: '10', FOO: 'server' });
    expect(runEnvSet({ limitRetry: 5 }, {})).toEqual({});
  });
});

describe('run behaviour validation', () => {
  test('accepts a valid value and names each problem', () => {
    expect(runBehaviourErrors({ allowMerged: true, limitRetry: 0, limitMaxWait: 21600, env: { FOO_BAR: 'x' } })).toEqual([]);
    expect(runBehaviourErrors({ allowMerged: 'yes' })).toEqual(['allowMerged: must be true or false (got "yes")']);
    expect(runBehaviourErrors({ limitRetry: -1 })).toEqual(['limitRetry: must be a whole number of seconds, 0 or more (got -1)']);
    expect(runBehaviourErrors({ limitMaxWait: 0 })).toEqual(['limitMaxWait: must be a whole number of seconds, 1 or more (got 0)']);
    expect(runBehaviourErrors({ env: { 'bad name': 'x' } })).toEqual(['env.bad name: a name is an uppercase letter, then letters, digits and underscores']);
    expect(runBehaviourErrors({ env: { SDLC_BASE: 'x' } })).toEqual(['env.SDLC_BASE: SDLC_BASE is set by the tool itself']);
    expect(runBehaviourErrors({ env: { SDLC_PERSONAL_AGENT: 'x' } })).toEqual(['env.SDLC_PERSONAL_AGENT: SDLC_PERSONAL_AGENT is set by the tool itself']);
    expect(runBehaviourErrors({ env: { FOO: 1 } })).toEqual(['env.FOO: must be text']);
    expect(runBehaviourErrors({ nope: 1 })).toEqual(['nope: not a run behaviour setting']);
    expect(runBehaviourErrors('nope')).toEqual(['must be an object']);
  });

  test('the browser-side checks match the server rules', () => {
    expect(variableNameError('FOO_BAR')).toBeNull();
    expect(variableNameError('')).toBeNull();
    expect(variableNameError('foo')).toBeTruthy();
    expect(variableNameError('9X')).toBeTruthy();
    expect(variableNameError('SDLC_BASE')).toContain('tool itself');
    expect(variableNameError('SDLC_PERSONAL_AGENT')).toContain('tool itself');
    expect(envSetNote('SDLC_ALLOW_MERGED', { SDLC_ALLOW_MERGED: '1' })).toBe('set in the environment');
    expect(envSetNote('FOO', { SDLC_ALLOW_MERGED: '1' })).toBe('');
    expect(secondsError('', 1, 'Max wait')).toBeNull();
    expect(secondsError('12x', 1, 'Max wait')).toBeTruthy();
    expect(secondsError('0', 1, 'Max wait')).toBeTruthy();
    expect(secondsError('300', 1, 'Max wait')).toBeNull();
  });
});

describe('run behaviour in the registry', () => {
  test('round-trips through the registry like the personal agent settings', () => {
    const env = registry();
    const run = { allowMerged: true, limitRetry: 5, env: { FOO: 'bar' } };
    expect(setRunBehaviour('shop', run, env).ok).toBe(true);
    expect(readRegistry(env)[0].overrides).toEqual({ maxParallel: 3, run });
    // editOverrides merges into it (the general overrides path); null clears the whole run behaviour.
    expect(editOverrides('shop', { run: { limitMaxWait: 600 } }, env).ok).toBe(true);
    expect(readRegistry(env)[0].overrides).toMatchObject({ run: { allowMerged: true, limitRetry: 5, limitMaxWait: 600, env: { FOO: 'bar' } } });
    expect(setRunBehaviour('shop', null, env).ok).toBe(true);
    expect(readRegistry(env)[0].overrides).toEqual({ maxParallel: 3 });
  });

  test('an invalid run is refused with the field named, and the registry is untouched', () => {
    const env = registry();
    expect(setRunBehaviour('shop', { limitRetry: -1 }, env).errors).toEqual(['run.limitRetry: must be a whole number of seconds, 0 or more (got -1)']);
    expect(readRegistry(env)[0].overrides).toEqual({ maxParallel: 3 });
    expect(editOverrides('shop', { run: { env: { SDLC_BASE: 'x' } } }, env).errors).toEqual(['run.env.SDLC_BASE: SDLC_BASE is set by the tool itself']);
  });
});

describe('run behaviour in a run', () => {
  const setup = (run: Record<string, unknown>, extraEnv: Record<string, string> = {}) => {
    const dir = project({ 'sdlc.config.json': { suites: [{ dir: '.', runner: 'vitest', testCmd: 'vitest run' }], agent: { codeSearch: 'none' } } });
    const env = { AI_SDLC_HELPER_CONFIG_DIR: tmp(), ...extraEnv };
    writeRegistry([{ name: 'shop', path: fs.realpathSync(dir), addedAt: '2026-01-01T00:00:00.000Z', overrides: { run } }], env);
    return { dir, env };
  };

  test('the controls read the saved allowMerged; the pipeline gets the limits and extras, but no controls', () => {
    const { dir, env } = setup({ allowMerged: true, limitRetry: 5, limitMaxWait: 600, env: { FOO: 'bar' } });
    const ctx = runContext(dir, env);
    expect(ctx.env.SDLC_ALLOW_MERGED).toBe('1');
    const p = pipelineEnv(ctx, 'x');
    expect(p).toMatchObject({ SDLC_SLUG: 'x', SDLC_LIMIT_RETRY: '5', SDLC_LIMIT_MAX_WAIT: '600', FOO: 'bar' });
    expect(p.SDLC_ALLOW_MERGED).toBeUndefined();
  });

  test('the server environment wins over the saved value in both places', () => {
    const { dir, env } = setup({ allowMerged: true, limitRetry: 5, env: { FOO: 'saved' } }, { SDLC_ALLOW_MERGED: '0', SDLC_LIMIT_RETRY: '9', FOO: 'server' });
    const ctx = runContext(dir, env);
    expect(ctx.env.SDLC_ALLOW_MERGED).toBe('0');
    const p = pipelineEnv(ctx, 'x');
    expect(p.SDLC_LIMIT_RETRY).toBe('9');
    expect(p.FOO).toBe('server');
  });
});
