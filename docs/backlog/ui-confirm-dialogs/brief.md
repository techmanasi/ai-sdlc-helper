# ui-confirm-dialogs

Type: improvement
Priority: P2 (normal)
Source: User, 2026-11-18: "Discard Red Tests - shows the `Confirm: Discard red tests` and `keep it` button instead of pop up - add to back log - replace all such buttons"

## Problem

On the Run page, a destructive button such as **Discard Red tests** does not open a pop-up. It swaps itself, in place, for a
`Confirm: discard Red tests` button and a `Keep it` button, so the layout shifts under the pointer, the warning text sits in a
separate line elsewhere, and nothing moves focus. The same inline pattern is used for these buttons:

- `web/ui/src/Run.tsx:797-798`, per-stage **Discard <stage>** -> `Confirm: discard <stage>` / `Keep it` (deletes only the uncommitted files that stage made; the text is at line 719).
- `web/ui/src/Run.tsx:710-711`, **Restart** -> `Confirm: discard and start again` / `Keep it` (deletes the worktree and branch, starts over from Spec; text at line 717).
- `web/ui/src/Run.tsx:713-714`, **Discard** (whole run) -> `Confirm discard` / `Keep it` (deletes worktree, branch and run record; text at line 718).
- `web/ui/src/Run.tsx:614-615`, **Stop** -> `Confirm stop` / `Keep running`.
- `web/ui/src/Run.tsx:617-618`, **Undo** (last start) -> `Confirm undo` / `Keep it`.
- `web/ui/src/NewItem.tsx:188-194`, triage **Discard** -> `Yes, discard` / `No` (deletes the triage run, its worktree and drafts).
- `web/ui/src/NewItem.tsx:249`, a browser `window.confirm('Replace the current form with the draft?')`.

A second, ad hoc kind of dialog already exists: `Run.tsx:1310` (run-level override) and `Run.tsx:1334` (resume stage) are
hand-written `role="dialog"` blocks, and `App.tsx:43`, `Projects.tsx:382` and `Run.tsx:1277` are other overlays. There is no
shared confirm component; the Config modal's keyboard and focus rules are in `web/ui/src/dialog.ts` (`dialogKey`, `firstFocusable`).

## Expected behaviour

1. One shared confirm dialog component in `web/ui/src`, used by every button listed above.
2. It has `role="dialog"` and `aria-modal="true"`, labelled by its title; focus moves into it when it opens and returns to the button that opened it when it closes.
3. Esc and a click on the backdrop cancel. Tab stays inside it (reuse `dialog.ts`).
4. Enter does not confirm a destructive action: the initial focus is on the safe button (Keep / Cancel), and the confirm button needs an explicit click or a focused Enter/Space.
5. The confirm button is styled as danger (`btn-d`). The text says what will be lost (worktree path, branch, files, run record) and whether it can be undone (for example, "the branch tip is saved").
6. While the action runs the dialog shows the busy state on its confirm button and cannot be dismissed; an error is shown in the dialog and the user can retry or cancel.
7. The original button stays where it is (no swap, no layout shift) and `confirm` state in `Run.tsx` no longer holds inline-confirm modes.
8. No `window.confirm` remains in `web/ui/src`.

## Tests

- The dialog-state module (a plain `web/ui/src` module, no DOM): open, confirm, cancel, Esc, backdrop, busy (cannot cancel), error then retry.
- Each listed action goes through the module: its dialog text and confirm label are the ones above, and cancelling never calls the API function.
- `test/ui-automation.test.ts` passes with the updated selectors.

## Notes

- Logic is tested through a plain `web/ui/src` module (no jsdom); the component stays a thin view over it.
- `tools/UI-automation/sdlc-ui.js` `SELECTORS` and functions change in the same PR (the `Confirm:` / `Keep it` button lookups move to the dialog); `test/ui-automation.test.ts` fails when a selector leaves `web/ui/src`.
- The PR description carries screenshots of the dialog (at least the per-stage Discard and the whole-run Discard), and no claim of a run without a record.
- Consider folding the two existing ad hoc dialogs at `Run.tsx:1310` and `Run.tsx:1334` into the shared component, if that stays small.
