import { describe, it, expect, vi } from 'vitest';

describe('allow-failure matching (spec 2.3, 8.4)', () => {
  it('A01 parses whole-file and full-name entries', async () => {
    const { parseAllowEntry } = await import('../../src/pipeline/allow-failures.js');
    expect(parseAllowEntry('test/e2e/*.test.ts')).toEqual({ filePattern: 'test/e2e/*.test.ts', testName: null });
    expect(parseAllowEntry('test/a.test.ts > suite rejects > input')).toEqual({ filePattern: 'test/a.test.ts', testName: 'suite rejects > input' });
  });

  it.each([
    ['test/e2e/*.test.ts', 'test/e2e/a.test.ts', undefined, true],
    ['test/e2e/*.test.ts', 'test/e2e/nested/a.test.ts', undefined, false],
    ['test/**/*.test.ts', 'test/e2e/nested/a.test.ts', 'anything', true],
    ['test/a.test.ts', 'test/ba.test.ts', 'anything', false],
    ['test/a.test.ts > suite rejects', 'test/a.test.ts', 'suite rejects', true],
    ['test/a.test.ts > suite rejects', 'test/a.test.ts', 'suite rejects input', false],
    ['test/a.test.ts > suite rejects', 'test/a.test.ts', undefined, false],
    ['test/a.test.ts > suite [a].*', 'test/a.test.ts', 'suite [a].*', true],
    ['test/a.test.ts > suite [a].*', 'test/a.test.ts', 'suite aaaa', false],
  ] as const)('A02 matches %j against %j / %j', async (entry, file, name, matches) => {
    const { matchesAllowEntry } = await import('../../src/pipeline/allow-failures.js');
    expect(matchesAllowEntry(entry, file, name)).toBe(matches);
  });

  it('A03 partitions allowed failures and leaves unrelated failures blocking', async () => {
    const { checkAllowedFailures } = await import('../../src/pipeline/allow-failures.js');
    const allowed = { file: 'test/legacy.test.ts', name: 'old failure' };
    const blocked = { file: 'test/new.test.ts', name: 'regression' };
    const isRed = vi.fn(() => false);
    expect(checkAllowedFailures([allowed, blocked], ['test/legacy.test.ts'], isRed, vi.fn())).toEqual({ allowed: [allowed], blocked: [blocked] });
  });

  it.each(['test/*.test.ts', 'test/red.test.ts > feature fails'])('A04 protects red tests from %j and names the ignored entry', async entry => {
    const { checkAllowedFailures } = await import('../../src/pipeline/allow-failures.js');
    const failure = { file: 'test/red.test.ts', name: 'feature fails' };
    const warn = vi.fn();
    expect(checkAllowedFailures([failure], [entry], vi.fn(() => true), warn)).toEqual({ allowed: [], blocked: [failure] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WARNING'));
    const output = warn.mock.calls.flat().join('\n');
    for (const value of [entry, failure.file, failure.name]) expect(output).toContain(value);
  });
});
