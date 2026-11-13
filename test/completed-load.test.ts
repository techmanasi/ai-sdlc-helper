// The Completed page's load: the rows, then the settled list only when a PR is pending; never more than two requests.
import { describe, expect, test } from 'vitest';
import { loadCompleted, type CompletedAnswer, type CompletedLoadEvents } from '../web/ui/src/completed-load.js';

interface CompletedTask { slug: string; prState: string | null; prPending?: true }
const row = (slug: string, extra: Partial<CompletedTask> = {}): CompletedTask => ({ slug, prState: 'MERGED', ...extra });

/** A source answering <rows> and <settled> (or failing with them when they are errors), counting the requests. */
function source(rows: CompletedAnswer<CompletedTask> | Error, settled?: CompletedAnswer<CompletedTask> | Error) {
  const calls: string[] = [];
  const answer = (v: CompletedAnswer<CompletedTask> | Error | undefined, what: string) => { calls.push(what); return v instanceof Error ? Promise.reject(v) : Promise.resolve(v as CompletedAnswer<CompletedTask>); };
  return { calls, src: { rows: (p: string) => answer(rows, `rows ${p}`), settled: (p: string) => answer(settled, `settled ${p}`) } };
}
function events() {
  const seen: Array<[string, unknown[]]> = [];
  const on: CompletedLoadEvents<CompletedTask> = { rows: (...a) => { seen.push(['rows', a]); }, settled: (...a) => { seen.push(['settled', a]); }, error: (...a) => { seen.push(['error', a]); } };
  return { seen, on };
}

describe('loadCompleted', () => {
  test('every PR known: one request, and the rows are the settled list', async () => {
    const { calls, src } = source({ completed: [row('a'), row('b')] });
    const { seen, on } = events();
    await loadCompleted(src, 'shop', on);
    expect(calls).toEqual(['rows shop']);
    expect(seen.map(s => s[0])).toEqual(['rows', 'settled']);
    expect(seen[1][1][2]).toEqual([]);
  });

  test('a pending PR: exactly two requests; the rows the settled list leaves out are named', async () => {
    const { calls, src } = source(
      { completed: [row('a'), row('b', { prState: null, prPending: true }), row('c', { prState: null, prPending: true })] },
      { completed: [row('a'), row('c')], prErrors: [{ slug: 'z', pr: 'p', message: 'm' }] },
    );
    const { seen, on } = events();
    await loadCompleted(src, 'shop', on);
    expect(calls).toEqual(['rows shop', 'settled shop']);
    expect(seen.map(s => s[0])).toEqual(['rows', 'settled']);
    expect((seen[1][1][0] as CompletedTask[]).map(t => t.slug)).toEqual(['a', 'c']);
    expect(seen[1][1][1]).toEqual([{ slug: 'z', pr: 'p', message: 'm' }]);
    expect(seen[1][1][2]).toEqual(['b']);
  });

  test('the rows fail: their error, and no second request', async () => {
    const { calls, src } = source(new Error('500 boom'));
    const { seen, on } = events();
    await loadCompleted(src, 'shop', on);
    expect(calls).toEqual(['rows shop']);
    expect(seen).toEqual([['error', ['500 boom', 'rows']]]);
  });

  test('the settled list fails: the rows stay shown, and its error is said', async () => {
    const { src } = source({ completed: [row('a', { prState: null, prPending: true })] }, new Error('gh down'));
    const { seen, on } = events();
    await loadCompleted(src, 'shop', on);
    expect(seen.map(s => s[0])).toEqual(['rows', 'error']);
    expect(seen[1][1]).toEqual(['gh down', 'settle']);
  });

  test('a newer load meanwhile: what comes back is dropped, and the settled list is not asked for', async () => {
    const { calls, src } = source({ completed: [row('a', { prState: null, prPending: true })] }, { completed: [] });
    const { seen, on } = events();
    await loadCompleted(src, 'shop', on, () => false);
    expect(calls).toEqual(['rows shop']);
    expect(seen).toEqual([]);
  });
});
