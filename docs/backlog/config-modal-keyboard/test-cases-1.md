# Test cases: config-modal-keyboard

Automated tests: `test/dialog.test.ts` (imports `web/ui/src/dialog.ts`, no DOM environment).

## Matrix

| # | Spec / AC | Case | Input | Expected | Test |
|---|-----------|------|-------|----------|------|
| 1 | B3, 2a | canFocus accepts enabled, visible, tabIndex >= 0 | plain candidate | true | canFocus |
| 2 | B3, 2a | canFocus rejects disabled / hidden / tabIndex -1 | each flag | false | canFocus |
| 3 | B2, 2a | firstFocusable skips unfocusable, keeps order | disabled, hidden, tabIndex -1, then ok | first ok one | firstFocusable |
| 4 | B2, 2a | firstFocusable on empty or all-unfocusable list | [] / only bad | undefined | firstFocusable |
| 5 | B3, 2a | focusable filters, order kept | mixed list | filtered, same order | focusable |
| 6 | B3, 2b | Tab on last | 3 items, focus last | focus items[0] | dialogKey Tab wrap |
| 7 | B3, 2c | Shift+Tab on first | focus first | focus items[2] | dialogKey Tab wrap |
| 8 | B3, 2d | Tab/Shift+Tab between middle elements | Tab on first/mid; Shift+Tab on mid/last | none | dialogKey Tab wrap |
| 9 | B3 | single item | Tab and Shift+Tab | focus stays on it | dialogKey Tab wrap |
| 10 | B3, 2e | focus outside list / null / undefined | Tab / Shift+Tab | first / last | focus outside the list |
| 11 | B3, 2f | empty list | Tab, Shift+Tab | prevent | empty list |
| 12 | B1, 2g | Escape | full, empty, outside focus | close | Escape |
| 13 | B1, 2h | other keys (Enter, a, ArrowDown, space, Shift+a) | any list | none | other keys |
| 14 | B3, 2h | Tab / Shift+Tab with Ctrl, Alt, Meta | on last / first / empty / outside | none | other keys |

## Review items (not covered by unit tests; DOM layer in `Projects.tsx`, no DOM env)
- AC1: `dialog.ts` imports nothing from `preact`.
- AC3a-d / B1-B4: browser behaviour (focus to Close on open, Esc closes, Tab cycles incl. form fields, focus returns to the same project's Config button for Esc, Close and backdrop; missing opener does not throw; save does not move focus). Covered by the manual browser check (AC8) recorded in the PR.
- B1: handler does not call `stopPropagation`, so the palette's global Escape listener is unchanged.
- AC4/AC5: Close, backdrop and save behave as before; palette and file viewer untouched (diff review).
- AC6: no dependency added to any `package.json`.
- AC7: `npm run check` passes.
