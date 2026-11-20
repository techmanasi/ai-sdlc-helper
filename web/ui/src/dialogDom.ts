// The DOM half of the dialog focus rules: collect focusable candidates so the DOM-free decisions in dialog.ts can run.
// Shared by the Config dialog and the code search setup dialog.
import type { FocusCandidate } from './dialog';

export const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

export interface Wrapped extends FocusCandidate {
  el: HTMLElement;
}

export const wrappers = (root: HTMLElement | null): Wrapped[] =>
  root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).map(el => ({
    el,
    disabled: el.matches(':disabled'),
    visible: el.getClientRects().length > 0,
    tabIndex: el.tabIndex,
  })) : [];
