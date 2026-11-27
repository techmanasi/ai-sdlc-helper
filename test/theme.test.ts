// Appearance: reading, writing and applying the Light / Dark / System theme, safe when storage is missing or blocked.
import { describe, expect, test } from 'vitest';
import { applyTheme, readTheme, themeAttr, THEME_KEY, THEME_OPTIONS, writeTheme } from '../web/ui/src/theme.js';

const store = (init?: Record<string, string>) => {
  const map = new Map<string, string>(Object.entries(init || {}));
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
};

describe('theme', () => {
  test('reads the saved theme, falling back to system when nothing or something else is stored', () => {
    expect(readTheme(store())).toBe('system');
    expect(readTheme(store({ [THEME_KEY]: 'dark' }))).toBe('dark');
    expect(readTheme(store({ [THEME_KEY]: 'light' }))).toBe('light');
    expect(readTheme(store({ [THEME_KEY]: 'system' }))).toBe('system');
    expect(readTheme(store({ [THEME_KEY]: 'nonsense' }))).toBe('system');
    expect(readTheme(null)).toBe('system');
    expect(readTheme(undefined)).toBe('system');
  });

  test('a store that throws is treated as unset on read and ignored on write', () => {
    const bad = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
    expect(readTheme(bad)).toBe('system');
    expect(() => writeTheme(bad, 'dark')).not.toThrow();
  });

  test('writes the theme and keeps system as the data-theme attribute value', () => {
    const s = store();
    writeTheme(s, 'dark');
    expect(s.getItem(THEME_KEY)).toBe('dark');
    expect(themeAttr('system')).toBe('system');
    expect(themeAttr('light')).toBe('light');
    expect(THEME_OPTIONS).toEqual(['light', 'dark', 'system']);
  });

  test('applying the theme is safe where there is no document (it does not throw)', () => {
    expect(() => applyTheme('dark')).not.toThrow();
  });
});
