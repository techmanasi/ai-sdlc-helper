import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repairTestFiles } from '../src/pipeline/gates.js';
import { Keys } from '../src/testcheck/keys.js';
import type { Ctx } from '../src/pipeline/context.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-scope-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const layout = { testDirs: ['test'], keyDir: '.', pathspecs: ['test/**/*.test.ts'] };
const suites = [{ name: 'unit', dir: '.', runner: 'vitest', testGlobs: ['test/**/*.test.ts'] }];
const claimsFile = 'docs/test-issues.md';
const CLAIM = 'test/claimed.test.ts :: claimed one :: the spec says nothing may be stubbed\n';

interface Fixture { mode?: string; available?: boolean; red?: boolean; claims?: boolean; changed?: string[] }

/** A run whose red commit added failing tests, whose agent claimed a file, and which has one changed test file. */
function fixture({ mode = 'ci', available = true, red = true, claims = true, changed = ['test/changed.test.ts'] }: Fixture = {}): Ctx {
  for (const dir of ['logs', 'docs', 'test']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const f of ['red', 'claimed', 'changed']) fs.writeFileSync(path.join(root, `test/${f}.test.ts`), '');
  if (red) {
    const result = { runner: 'vitest', suite: 'unit', command: 'vitest run', ok: false, exitCode: 1, tests: [{ file: 'test/red.test.ts', name: 'red one', status: 'failed' }], suiteErrors: [] };
    fs.writeFileSync(path.join(root, 'logs/red.json'), JSON.stringify(result));
  }
  if (claims) fs.writeFileSync(path.join(root, claimsFile), CLAIM);
  return {
    root, log: 'logs', docs: 'docs', redSha: red ? 'redsha' : '', lockSha: 'locksha', ciAvailable: available,
    layout,
    keys: new Keys(layout, root),
    git: { lines: (...a: string[]) => (a[0] === 'diff' ? ['test/red.test.ts'] : changed), testsChangedSince: () => changed },
    config: { tests: { fullSuite: mode }, suites },
  } as unknown as Ctx;
}

describe('Test repair runs only its own test files when the full suite is CI', () => {
  it('covers the red tests, the claimed files and anything changed since the lock', () => {
    expect(repairTestFiles(fixture(), 'locksha', claimsFile)).toEqual(['test/changed.test.ts', 'test/claimed.test.ts', 'test/red.test.ts']);
  });

  it.each([['local', true], ['ci', false]])('keeps the full suite for fullSuite %s with CI available=%s', (mode, available) => {
    expect(repairTestFiles(fixture({ mode, available }), 'locksha', claimsFile)).toEqual([]);
  });

  it('falls back to the full suite when nothing is in scope, rather than running no tests at all', () => {
    expect(repairTestFiles(fixture({ red: false, claims: false, changed: [] }), 'locksha', claimsFile)).toEqual([]);
  });
});
