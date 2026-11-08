import { describe, it, expect } from 'vitest';
import { canFocus, focusable, firstFocusable, dialogKey } from '../web/ui/src/dialog.js';

interface El {
  id: string;
  disabled: boolean;
  visible: boolean;
  tabIndex: number;
}

const el = (id: string, over: Partial<El> = {}): El => ({ id, disabled: false, visible: true, tabIndex: 0, ...over });

interface Mods {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}
const key = (k: string, mods: Mods = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('canFocus', () => {
  it('accepts an enabled, visible element with tabIndex >= 0', () => {
    expect(canFocus(el('a'))).toBe(true);
    expect(canFocus(el('a', { tabIndex: 3 }))).toBe(true);
  });
  it('rejects disabled, hidden and negative tabIndex elements', () => {
    expect(canFocus(el('a', { disabled: true }))).toBe(false);
    expect(canFocus(el('a', { visible: false }))).toBe(false);
    expect(canFocus(el('a', { tabIndex: -1 }))).toBe(false);
  });
});

describe('firstFocusable / focusable (2a)', () => {
  it('returns the first focusable candidate, skipping disabled, hidden and tabIndex -1', () => {
    const list = [
      el('dis', { disabled: true }),
      el('hid', { visible: false }),
      el('neg', { tabIndex: -1 }),
      el('close'),
      el('next'),
    ];
    expect(firstFocusable(list)).toBe(list[3]);
  });
  it('returns the very first candidate when it is focusable', () => {
    const list = [el('close'), el('b')];
    expect(firstFocusable(list)).toBe(list[0]);
  });
  it('returns undefined for an empty list', () => {
    expect(firstFocusable([])).toBeUndefined();
  });
  it('returns undefined when nothing is focusable', () => {
    expect(firstFocusable([el('a', { disabled: true }), el('b', { visible: false }), el('c', { tabIndex: -1 })])).toBeUndefined();
  });
  it('focusable keeps document order and drops unfocusable ones', () => {
    const a = el('a');
    const b = el('b', { disabled: true });
    const c = el('c');
    const d = el('d', { visible: false });
    const e = el('e', { tabIndex: -1 });
    const f = el('f');
    const out = focusable([a, b, c, d, e, f]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(c);
    expect(out[2]).toBe(f);
  });
  it('focusable of an empty list is empty', () => {
    expect(focusable([])).toEqual([]);
  });
});

describe('dialogKey Tab wrap (2b-2d)', () => {
  const items = [el('first'), el('mid'), el('last')];

  it('Tab on the last item focuses the first', () => {
    const a = dialogKey(key('Tab'), items, items[2]);
    expect(a).toEqual({ kind: 'focus', target: items[0] });
    expect(a.kind === 'focus' && a.target).toBe(items[0]);
  });
  it('Shift+Tab on the first item focuses the last', () => {
    const a = dialogKey(key('Tab', { shiftKey: true }), items, items[0]);
    expect(a.kind).toBe('focus');
    expect(a.kind === 'focus' && a.target).toBe(items[2]);
  });
  it('Tab on first and middle leaves the default alone', () => {
    expect(dialogKey(key('Tab'), items, items[0])).toEqual({ kind: 'none' });
    expect(dialogKey(key('Tab'), items, items[1])).toEqual({ kind: 'none' });
  });
  it('Shift+Tab on middle and last leaves the default alone', () => {
    expect(dialogKey(key('Tab', { shiftKey: true }), items, items[1])).toEqual({ kind: 'none' });
    expect(dialogKey(key('Tab', { shiftKey: true }), items, items[2])).toEqual({ kind: 'none' });
  });
  it('with a single item both Tab and Shift+Tab keep focus on it', () => {
    const one = [el('only')];
    const t = dialogKey(key('Tab'), one, one[0]);
    const s = dialogKey(key('Tab', { shiftKey: true }), one, one[0]);
    expect(t.kind === 'focus' && t.target).toBe(one[0]);
    expect(s.kind === 'focus' && s.target).toBe(one[0]);
  });
});

describe('dialogKey focus outside the list (2e)', () => {
  const items = [el('first'), el('mid'), el('last')];
  const outside = el('page');

  it('Tab with focus on an unknown element goes to the first', () => {
    const a = dialogKey(key('Tab'), items, outside);
    expect(a.kind === 'focus' && a.target).toBe(items[0]);
  });
  it('Shift+Tab with focus on an unknown element goes to the last', () => {
    const a = dialogKey(key('Tab', { shiftKey: true }), items, outside);
    expect(a.kind === 'focus' && a.target).toBe(items[2]);
  });
  it('null and undefined focus behave like outside', () => {
    for (const f of [null, undefined]) {
      const t = dialogKey(key('Tab'), items, f);
      const s = dialogKey(key('Tab', { shiftKey: true }), items, f);
      expect(t.kind === 'focus' && t.target).toBe(items[0]);
      expect(s.kind === 'focus' && s.target).toBe(items[2]);
    }
  });
});

describe('dialogKey empty list (2f)', () => {
  it('Tab and Shift+Tab only prevent the default', () => {
    expect(dialogKey(key('Tab'), [], null)).toEqual({ kind: 'prevent' });
    expect(dialogKey(key('Tab', { shiftKey: true }), [], null)).toEqual({ kind: 'prevent' });
    expect(dialogKey(key('Tab'), [], el('x'))).toEqual({ kind: 'prevent' });
  });
});

describe('dialogKey Escape (2g)', () => {
  it('closes with a full list', () => {
    const items = [el('a'), el('b')];
    expect(dialogKey(key('Escape'), items, items[0])).toEqual({ kind: 'close' });
  });
  it('closes with an empty list', () => {
    expect(dialogKey(key('Escape'), [], null)).toEqual({ kind: 'close' });
  });
  it('closes when focus is outside the list', () => {
    expect(dialogKey(key('Escape'), [el('a')], el('z'))).toEqual({ kind: 'close' });
  });
});

describe('dialogKey other keys (2h)', () => {
  const items = [el('first'), el('mid'), el('last')];

  it.each(['Enter', 'a', 'ArrowDown', ' ', 'Esc'])('%s does nothing', k => {
    expect(dialogKey(key(k), items, items[2])).toEqual({ kind: 'none' });
    expect(dialogKey(key(k), [], null)).toEqual({ kind: 'none' });
  });
  it('Shift+a does nothing', () => {
    expect(dialogKey(key('a', { shiftKey: true }), items, items[0])).toEqual({ kind: 'none' });
  });
  it.each(['ctrlKey', 'altKey', 'metaKey'] as const)('Tab with %s on the last item does nothing', m => {
    expect(dialogKey(key('Tab', { [m]: true }), items, items[2])).toEqual({ kind: 'none' });
  });
  it.each(['ctrlKey', 'altKey', 'metaKey'] as const)('Shift+Tab with %s on the first item does nothing', m => {
    expect(dialogKey(key('Tab', { shiftKey: true, [m]: true }), items, items[0])).toEqual({ kind: 'none' });
  });
  it('Tab with a modifier does nothing even with an empty list or outside focus', () => {
    expect(dialogKey(key('Tab', { ctrlKey: true }), [], null)).toEqual({ kind: 'none' });
    expect(dialogKey(key('Tab', { altKey: true }), items, el('z'))).toEqual({ kind: 'none' });
  });
});
