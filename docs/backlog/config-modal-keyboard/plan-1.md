# Plan: config-modal-keyboard

Spec: `docs/backlog/config-modal-keyboard/specs-1.md`. No `decisions.md` exists; nothing open.

## Constraints found in the code
- `test/dialog.test.ts` is typechecked by `tsc -p test` (`test/tsconfig.json` extends the root `tsconfig.json`: `lib: ["ES2022"]`, no `DOM`). Anything `test/` imports is compiled under that config, so **`web/ui/src/dialog.ts` must not name any DOM type** (`HTMLElement`, `KeyboardEvent`, `Element`, `document`). It is generic over the element type `T`. All DOM work (querying, `getClientRects`, `focus()`, `preventDefault()`) lives in `Projects.tsx`, which is compiled by `tsc -p web/ui` (has `DOM`).
- Tests import web UI modules with a `.js` suffix: `import { … } from '../web/ui/src/dialog.js';` (as `test/resume.test.ts`, `test/stale.test.ts`).
- `vitest.config.ts` already includes `test/**/*.test.ts`; no config change.
- The App's global listener (`web/ui/src/App.tsx:101-106`) closes the palette on Escape. The dialog handler must **not** call `stopPropagation`, so that listener stays as it is (spec B1); it is a no-op when the palette is closed.

## Step 1: `web/ui/src/dialog.ts` (new, no imports at all)

Header comment: one line saying it holds the Config modal's keyboard and focus decisions, DOM-free so `test/dialog.test.ts` runs them without a DOM.

```ts
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
export interface KeyInput { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }

export type DialogAction<T> =
  | { kind: 'close' }
  | { kind: 'focus'; target: T }   // move focus to target and prevent the default
  | { kind: 'prevent' }            // prevent the default only
  | { kind: 'none' };              // let the browser handle it

export const canFocus = (c: FocusCandidate): boolean => !c.disabled && c.visible && c.tabIndex >= 0;
export function focusable<T extends FocusCandidate>(candidates: readonly T[]): T[]   // filter(canFocus), order kept
export function firstFocusable<T extends FocusCandidate>(candidates: readonly T[]): T | undefined
export function dialogKey<T>(e: KeyInput, items: readonly T[], focused: T | null | undefined): DialogAction<T>
```

`dialogKey` rules (`items` is the already-filtered focusable list, in document order; `focused` is compared by identity with `indexOf`):
1. `e.key === 'Escape'` → `{ kind: 'close' }` (regardless of modifiers).
2. `e.key !== 'Tab'`, or any of `ctrlKey`/`altKey`/`metaKey` → `{ kind: 'none' }`.
3. `items.length === 0` → `{ kind: 'prevent' }`.
4. `i = focused == null ? -1 : items.indexOf(focused)`; `first = items[0]`, `last = items[items.length - 1]`.
   - `i === -1` → `{ kind: 'focus', target: e.shiftKey ? last : first }`.
   - Tab (no shift) and `i === items.length - 1` → focus `first`.
   - Shift+Tab and `i === 0` → focus `last`.
   - otherwise → `{ kind: 'none' }`.
   (With one item, Tab and Shift+Tab both return focus on that item, which keeps focus inside.)

Never throws; empty arrays and unknown `focused` are covered by rules 3 and 4.

## Step 2: `test/dialog.test.ts` (new; Red tests)

Import `{ canFocus, focusable, firstFocusable, dialogKey }` from `'../web/ui/src/dialog.js'`, `describe/expect/test` from `vitest`. Candidates are plain objects such as `{ id: 'close', disabled: false, visible: true, tabIndex: 0 }`; identity is checked with `toBe`. A helper `key(k, mods = {})` builds a `KeyInput` with all modifiers false by default.

Cases (spec acceptance 2a-2h):
- a. `firstFocusable` returns the first enabled, visible, tabIndex ≥ 0 candidate, skipping a disabled one, a `visible: false` one and a `tabIndex: -1` one placed before it; returns `undefined` for `[]` and for a list of only unfocusable candidates. `focusable` keeps order and drops the same ones.
- b. Tab on the last of three items → `{ kind: 'focus', target: items[0] }`.
- c. Shift+Tab on the first → `{ kind: 'focus', target: items[2] }`.
- d. Tab on items[0] and items[1], Shift+Tab on items[1] and items[2] → `{ kind: 'none' }`.
- e. Tab with `focused` = an object not in the list, and with `null` → focus first; Shift+Tab → focus last.
- f. Tab and Shift+Tab with `[]` → `{ kind: 'prevent' }` (also with `focused` null).
- g. `Escape` → `{ kind: 'close' }` (with an empty list and a full list).
- h. `Enter`, `a`, `ArrowDown`, `Shift`+`a` → `none`; Tab on the last item with `ctrlKey`, `altKey`, `metaKey` each → `none`.

Run: `ai-sdlc-helper run --file test/dialog.test.ts`.

## Step 3: wire it into `web/ui/src/Projects.tsx` (`Projects`, L272-337)

1. Imports (L2): `import { useEffect, useRef, useState } from 'preact/hooks';` and add `import { dialogKey, firstFocusable, focusable, type FocusCandidate } from './dialog';`.
2. Module-level DOM helper (above `Projects`):
   ```ts
   const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';
   type Wrapped = FocusCandidate & { el: HTMLElement };
   const wrappers = (root: HTMLElement | null): Wrapped[] =>
     root ? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).map(el => ({
       el,
       disabled: (el as HTMLButtonElement).disabled === true,
       visible: el.getClientRects().length > 0,
       tabIndex: el.tabIndex,
     })) : [];
   ```
   Elements are not mutated. Pass wrappers to `focusable` / `firstFocusable` and map results back via `.el`. For `dialogKey`, pass `items.map(w => w.el)` and `document.activeElement` so the identity check works on real elements.
3. State/refs in `Projects`: `const dialog = useRef<HTMLDivElement>(null);` and `const opener = useRef<HTMLElement | null>(null);`. Add `const close = () => setEditing(null);`.
4. Config button (L301): `onClick={e => { opener.current = e.currentTarget as HTMLElement; setEditing(p.name); }}`.
5. Effect on `[editing]`:
   - `editing` set → `firstFocusable(wrappers(dialog.current))?.el.focus()` (no-op when none; B2).
   - `editing` null and `opener.current` set → `if (opener.current.isConnected) opener.current.focus(); opener.current = null;` (B4; covers Esc, Close and backdrop, since all go through `setEditing(null)`). Saving does not change `editing`, so it does not move focus.
6. Overlay div (L328): add `ref={dialog}` and
   `onKeyDown={e => { const items = focusable(wrappers(dialog.current)).map(w => w.el); const a = dialogKey(e, items, document.activeElement as HTMLElement | null); if (a.kind === 'close') close(); else if (a.kind === 'focus') { e.preventDefault(); a.target.focus(); } else if (a.kind === 'prevent') e.preventDefault(); }}`.
   The list is rebuilt on every keydown (B3: form loads later, Save disables while busy). Keep `role="dialog"`, `aria-modal`, the backdrop `onClick` (switch it and the Close button to `close`), unchanged otherwise. Add `tabIndex={-1}` to the overlay div so it can hold focus without entering the Tab order (it is excluded by `canFocus` since `tabIndex < 0`).
7. No change to `EditSetup`, `App.tsx`, `Run.tsx`, styles.

## Step 4: verify
- `ai-sdlc-helper run --file test/dialog.test.ts`, then `npm run check > /tmp/sdlc-config-modal-keyboard.log 2>&1; echo exit=$?` (lint, all four `tsc` projects, tests).
- Manual browser check for the PR (acceptance 8): `node dist/bin.js ui` (or `scripts/dev.mjs`), open Config → focus on Close; Tab/Shift+Tab cycle through the dialog only, including form fields once loaded; Esc closes and focus is on that project's Config; repeat closing with Close and with a backdrop click.

## Docs
- None (spec: "Docs: none"). The PR description records the manual browser check.

## Dependencies
- none
