# config-modal-keyboard

Type: feature
Priority: P3 (low)
Source: Gaps found reviewing the Projects page Config modal (`feat/projects-config-modal`).

## Problem
The Projects page opens a project's config form in a modal (`web/ui/src/Projects.tsx`, the `editing &&` overlay near line 304, opened by the **Config** button near line 277). Verified from the code:
- Esc does not close it. The only Esc handlers in the UI are the command palette (`web/ui/src/App.tsx:102`) and the resume picker (`web/ui/src/Run.tsx:399`).
- Opening it leaves focus on the **Config** button behind the backdrop; Tab moves through the page underneath.
- Closing it does not return focus to the **Config** button that opened it.
- No test covers opening or closing it, and it has not been checked in a browser.

## Expected behaviour
1. Esc closes the modal, the same as **Close** and a backdrop click.
2. On open, focus moves into the dialog (its first field, or the **Close** button).
3. Tab and Shift+Tab stay inside the dialog while it is open.
4. On close, focus returns to the **Config** button of that project.

## Decisions
- Put the open/close and focus logic in a small module with no Preact imports (for example `web/ui/src/dialog.ts`) so it can be tested the way `test/resume.test.ts` and `test/tree.test.ts` import `web/ui/src/*.ts`.
- Reuse it for the other `.overlay` dialogs only if that needs no change to them; otherwise leave them.
- No new dependency (no focus-trap library, no DOM test environment unless one is already configured).

## Scope
- In: `web/ui/src/Projects.tsx`, the new helper module, `test/` for the helper.
- Out of scope: the config form's fields, validation and saving; other dialogs' behaviour; styling.

## Tests
- `test/dialog.test.ts`: the helper picks the first focusable element, wraps Tab from last to first and Shift+Tab from first to last, and reports Esc as close.
- Every case runs the real code.
- Manual check in a browser: open Config, press Esc, Tab through, close, and confirm focus is back on Config.

## Docs
- none

## Open questions
- none
