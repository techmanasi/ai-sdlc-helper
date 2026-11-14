// Which server notices the browser still shows: a dismissed one does not come back, with or without storage.
import { describe, expect, test } from 'vitest';
import { loadDismissed, saveDismissed, visibleNotices, type NoticeItem } from '../web/ui/src/notices.js';

const n = (id: string): NoticeItem => ({ id, at: '2026-11-14T10:00:00Z', slug: 'task', text: 'Kept it', level: 'info' });
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

describe('notice dismissal', () => {
  test('a dismissed notice stays gone for its project, after a reload', () => {
    const store = memory();
    saveDismissed('shop', ['a'], store);
    expect(visibleNotices([n('a'), n('b')], loadDismissed('shop', store)).map(x => x.id)).toEqual(['b']);
    expect(loadDismissed('other', store)).toEqual([]);
  });
  test('storage that throws or holds junk shows everything and never throws', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadDismissed('shop', broken)).toEqual([]);
    expect(saveDismissed('shop', ['a'], broken)).toEqual(['a']);
    expect(loadDismissed('shop', { getItem: () => '{"x":1}', setItem: () => {} })).toEqual([]);
    expect(visibleNotices(undefined, [])).toEqual([]);
  });
});
