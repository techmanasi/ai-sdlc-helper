# Review 1: config-modal-keyboard

Diff reviewed: `git diff 6941519` (`web/ui/src/Projects.tsx`, new `web/ui/src/dialog.ts`), checked against `specs-1.md`.

## Verdict
No blockers. The feature is in the code, not only in docs. No test reads or asserts on documentation text.

## Acceptance criteria
| AC | Status | Evidence |
|---|---|---|
| 1 | Met | `web/ui/src/dialog.ts` imports nothing at all. |
| 2a–2h | Met | `test/dialog.test.ts` imports the real `canFocus`/`focusable`/`firstFocusable`/`dialogKey` and runs them without a DOM. It covers first-focusable (disabled, hidden, `tabIndex -1`, empty list, nothing focusable), Tab and Shift+Tab wrapping, middle elements, focus outside the list (including null/undefined), the empty list, Escape, other keys, and Tab with Ctrl, Alt or Meta. `ai-sdlc-helper run --file test/dialog.test.ts` passes. |
| 3a | Implemented | `useEffect([editing])` focuses `firstFocusable(wrappers(dialog))`, which is the Close button. |
| 3b | Implemented | The overlay's `onKeyDown` calls `close()` when the action is `close`. It handles only keydowns from inside the dialog. |
| 3c | Implemented | The focusable list is rebuilt on every keydown. On a `focus` action it calls `preventDefault` and then `focus()`. On `prevent` it calls `preventDefault` only. |
| 3d | Implemented | The Config button's `onClick` saves `e.currentTarget` in `opener`. On close the effect focuses it only if `isConnected`, then clears it. All three close routes clear `editing`, so all three return focus. |
| 4, 5, 6 | Met | Close and the backdrop click both go through `close()`, which does the same thing as before. Saving does not touch `editing`. `App.tsx` and `Run.tsx` are unchanged. No `package.json` changes. |
| 7 | Met | `npm run check` (lint, typecheck, tests) exits 0 with this review's fix applied. |
| 8 | Manual: still to be done in the browser and recorded in the PR. |

## Fixed in this review
- `Projects.tsx` `wrappers()`: the disabled check used `el.disabled === true`. That misses controls inside a disabled `<fieldset>`: their `disabled` property is false, but they cannot take focus. It now uses `el.matches(':disabled')`, which covers both cases (B3: disabled elements do not count).

## Notes (not blockers)
- `web/ui/src/dialog.ts` is untracked. Make sure the implement commit includes it.
- Visibility is decided by `getClientRects().length > 0`. That catches `display:none` and `hidden`, but not `visibility:hidden` or `inert`. The current markup uses neither.
- If the focused **Save** button becomes disabled while saving, some browsers move focus to `<body>`. Tab presses then come from outside the dialog, so by B1 the trap does not see them. This is an edge case the spec does not cover.
- Esc during IME composition would close the modal. `KeyInput` has no `isComposing`. Low impact.
