// Appearance: the Light / Dark / System choice, kept in this browser's storage and applied as data-theme on <html>.
// The stylesheet resolves System with prefers-color-scheme, so 'system' is stored and applied as-is (no matchMedia
// listener needed). Every read and write is safe when storage is missing or blocked (private windows).
export type Theme = 'light' | 'dark' | 'system';

export const THEME_OPTIONS: readonly Theme[] = ['light', 'dark', 'system'];
export const THEME_KEY = 'sdlc-theme';

/** The two methods of the browser's storage this module uses. */
export interface ThemeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The saved theme: 'system' when nothing is stored, the value is not a theme, or storage is unavailable. */
export function readTheme(store: ThemeStore | undefined | null): Theme {
  if (!store) return 'system';
  try {
    const t = store.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' || t === 'system' ? t : 'system';
  } catch { return 'system'; }
}

/** Saves the theme; a blocked or missing store is ignored (the choice just does not persist). */
export function writeTheme(store: ThemeStore | undefined | null, theme: Theme): void {
  if (!store) return;
  try { store.setItem(THEME_KEY, theme); } catch { /* private window */ }
}

/** The data-theme attribute value: 'system' is kept so the stylesheet's prefers-color-scheme rule decides. */
export const themeAttr = (theme: Theme): string => theme;

/** Applies <theme> to the document root; safe where there is no document (tests, server-side rendering). */
export function applyTheme(theme: Theme): void {
  try { document.documentElement.setAttribute('data-theme', themeAttr(theme)); } catch { /* no document */ }
}
