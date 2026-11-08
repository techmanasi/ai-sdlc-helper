// The Config modal's keyboard and focus decisions, DOM-free so test/dialog.test.ts runs them without a DOM.

/** What the DOM layer reports about one candidate element. */
export interface FocusCandidate {
  /** The element's `disabled` property is true. */
  disabled: boolean;
  /** The element is rendered (has client rects): false for display:none, `hidden`, input[type=hidden]. */
  visible: boolean;
  /** The element's `tabIndex` (negative = not reachable with Tab). */
  tabIndex: number;
}

/** The key event fields the decision needs (a KeyboardEvent satisfies it structurally). */
export interface KeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type DialogAction<T> =
  | { kind: 'close' }
  | { kind: 'focus'; target: T }
  | { kind: 'prevent' }
  | { kind: 'none' };

export const canFocus = (c: FocusCandidate): boolean => !c.disabled && c.visible && c.tabIndex >= 0;

export function focusable<T extends FocusCandidate>(candidates: readonly T[]): T[] {
  return candidates.filter(canFocus);
}

export function firstFocusable<T extends FocusCandidate>(candidates: readonly T[]): T | undefined {
  return candidates.find(canFocus);
}

/** `items` is the already-filtered focusable list in document order; `focused` is compared by identity. */
export function dialogKey<T>(e: KeyInput, items: readonly T[], focused: T | null | undefined): DialogAction<T> {
  if (e.key === 'Escape') return { kind: 'close' };
  if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return { kind: 'none' };
  if (items.length === 0) return { kind: 'prevent' };
  const i = focused == null ? -1 : items.indexOf(focused);
  const first = items[0];
  const last = items[items.length - 1];
  if (i === -1) return { kind: 'focus', target: e.shiftKey ? last : first };
  if (!e.shiftKey && i === items.length - 1) return { kind: 'focus', target: first };
  if (e.shiftKey && i === 0) return { kind: 'focus', target: last };
  return { kind: 'none' };
}
