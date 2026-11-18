import { describe, expect, test } from 'vitest';
import { addEnvKey, envVars, quickKeys, setEnvValue, type EnvRow } from '../web/ui/src/env.js';

const KEYS = ['SDLC_AUTO_ACCEPT', 'SDLC_BASE', 'SDLC_LIMIT_RETRY'];

describe('run page environment rows (web/ui/src/env.ts)', () => {
  test('a quick button with no default adds an empty row for the user to fill (it used to add nothing)', () => {
    const rows = addEnvKey([], 'SDLC_BASE');
    expect(rows).toEqual([['SDLC_BASE', '']]);
    expect(quickKeys(rows, KEYS)).toEqual(['SDLC_AUTO_ACCEPT', 'SDLC_LIMIT_RETRY']);
  });

  test('a quick button with a default adds it with that value; a second click adds nothing', () => {
    const once = addEnvKey([['X', '1']], 'SDLC_AUTO_ACCEPT', '1');
    expect(once).toEqual([['X', '1'], ['SDLC_AUTO_ACCEPT', '1']]);
    expect(addEnvKey(once, 'SDLC_AUTO_ACCEPT', '1')).toBe(once);
  });

  test('an empty row is not sent; once filled it is', () => {
    let rows: EnvRow[] = addEnvKey([['SDLC_LIMIT_RETRY', '1']], 'SDLC_BASE');
    expect(envVars(rows)).toEqual({ SDLC_LIMIT_RETRY: '1' });
    rows = rows.map(r => (r[0] === 'SDLC_BASE' ? [r[0], 'main'] : r));
    expect(envVars(rows)).toEqual({ SDLC_LIMIT_RETRY: '1', SDLC_BASE: 'main' });
    expect(envVars([['  ', 'x'], [' K ', 'v']])).toEqual({ K: 'v' });
  });

  test('setEnvValue replaces a row of that name, and an empty value removes it', () => {
    expect(setEnvValue([['A', '1'], ['B', '2']], 'A', '3')).toEqual([['B', '2'], ['A', '3']]);
    expect(setEnvValue([['A', '1'], ['B', '2']], 'A', '')).toEqual([['B', '2']]);
  });
});
