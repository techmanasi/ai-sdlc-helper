# Spec: config-modal-keyboard

Type: feature · Priority: P3 · Source: `docs/backlog/config-modal-keyboard/brief.md`

## Summary
The Projects page's Config modal (`web/ui/src/Projects.tsx`, the `editing &&` overlay, opened by each project's **Config** button) gets standard modal keyboard behaviour: Esc closes it, focus moves into it on open, Tab and Shift+Tab stay inside it, and focus goes back to the opening **Config** button on close. The keyboard and focus decisions live in a new module with no Preact imports (`web/ui/src/dialog.ts`), tested directly from `test/dialog.test.ts`.

## Current behaviour (verified)
- The modal closes only through the **Close** button or a click on the backdrop (the `.overlay` element itself).
- Esc does nothing to it. The only Esc handlers are the command palette's global `keydown` listener (`web/ui/src/App.tsx:103`) and the resume picker's `onKeyDown` (`web/ui/src/Run.tsx:410`).
- Opening it leaves focus on the **Config** button behind the backdrop. Tab moves through the page underneath.
- Closing it does not return focus to the **Config** button.
- The project has no DOM test environment: no jsdom or happy-dom, and no `environment` setting for Vitest.

## Behaviour

### B1: Esc closes the modal
- While the Config modal is open, pressing Esc closes it, exactly as **Close** and a backdrop click do (the `editing` state is cleared).
- The modal handles only keydown events that come from inside it: from the dialog element or anything it contains. Any Esc handling that already exists elsewhere (the palette's global listener) stays as it is.
- Closing with Esc does not save the form, the same as **Close** today. Unsaved edits are dropped, as they are now.
- Any other key, with or without modifiers, does not close the modal.

### B2: Focus moves into the dialog on open
- When the modal opens, focus moves to the first focusable element inside the dialog in document order. In the current markup that is the **Close** button in the dialog header. The config form's fields come later and appear only after the settings load.
- If the dialog has no focusable element, focus is not moved and nothing fails. With the current markup this cannot happen, because **Close** is always there.

### B3: Tab and Shift+Tab stay inside the dialog
- While the modal is open, the focusable elements are the dialog's descendants that can take keyboard focus: enabled `button`, `input`, `select` and `textarea` elements, `a` elements with an `href`, and elements with a `tabindex` that is not negative. Disabled elements, and elements that are hidden or not rendered, do not count.
- Tab on the last focusable element moves focus to the first one. Shift+Tab on the first focusable element moves focus to the last one. In both cases the browser's default Tab action is prevented.
- Tab and Shift+Tab between other elements keep the browser's default, so focus moves to the next or previous element in the dialog.
- If focus is not on any of the dialog's focusable elements when Tab is pressed (for example on the dialog container itself after a click on non-focusable content), Tab moves focus to the first focusable element and Shift+Tab to the last one, with the default prevented.
- If the dialog has no focusable element, Tab and Shift+Tab are prevented and focus stays where it is.
- The set of focusable elements is worked out again on every Tab press, because the form appears after loading and controls change with the scope radio, the effort picker and the busy state (for example, **Save** is disabled while saving).
- Tab with Ctrl, Alt or Meta held is not handled by the trap.

### B4: Focus returns to the opening Config button on close
- When the modal closes by any route (Esc, **Close** or a backdrop click), focus returns to the **Config** button of the project whose modal was open.
- If that button is no longer in the document when the modal closes (for example, the project list reloaded without it), focus is not moved and nothing fails.
- Saving the form does not close the modal (unchanged), so saving does not move focus.

### B5: The helper module
A new module, `web/ui/src/dialog.ts`. It imports nothing from Preact, so `test/dialog.test.ts` can import it the way `test/resume.test.ts` and `test/tree.test.ts` import `web/ui/src/*.ts`. Because there is no DOM test environment, the decision logic must run without a DOM: it works on plain inputs (a list of focusable items, the index or identity of the item that currently has focus, and the key pressed with its Shift, Ctrl, Alt and Meta state). A thin DOM layer that collects focusable elements and applies the decisions is allowed in the same module or in `Projects.tsx`, but every decision listed below must sit in the DOM-free part.

It must provide:
- **First focusable:** given the dialog's candidate elements in document order, it returns the first one that can take focus (see B3), or nothing when there is none.
- **Key decision:** given a key event and the focusable list with the currently focused one, it returns one of:
  - *close*, for Esc;
  - *move focus to element X and prevent the default*, for Tab on the last element, Shift+Tab on the first, either key when focus is outside the list, as B3 describes;
  - *prevent the default only*, for Tab or Shift+Tab when the list is empty;
  - *nothing*: let the browser handle it, for every other case.

`Projects.tsx` uses these for B1 to B4. It remembers the **Config** button that opened the modal so it can be focused again on close.

## Inputs and outputs
- Inputs: keydown events inside the Config dialog (Escape, Tab, Shift+Tab, other keys) and the open and close transitions of the `editing` state.
- Outputs: the `editing` state cleared (closed); `focus()` called on one element; `preventDefault()` called on the key event. Nothing is written to disk, nothing goes to the server, and no state other than `editing` changes.

## Error cases
- The dialog has no focusable element: open does not move focus; Tab and Shift+Tab are prevented and do nothing else; nothing is thrown.
- The opening **Config** button is gone at close: focus is not moved; nothing is thrown.
- Esc while the modal is closed: no change from today.
- The helper receives an empty candidate list or an unknown focused element: it returns the result B3 defines and never throws.

## Out of scope
- The config form's fields, validation and saving.
- The other `.overlay` dialogs: the command palette (`App.tsx`) and the file viewer (`Run.tsx`). Wiring the helper into them would mean changing them, and the brief allows reuse only without changes, so they are left as they are.
- Styling.
- New dependencies: no focus-trap library and no DOM test environment (jsdom, happy-dom).
- Docs: none.

## Dependencies
- None new.

## Acceptance criteria
1. `web/ui/src/dialog.ts` exists and imports nothing from `preact` or `preact/*`.
2. `test/dialog.test.ts` imports the real helper and runs it, with no DOM environment, to check:
   a. the first-focusable choice returns the first enabled, visible candidate in order, skipping disabled or hidden ones, and returns nothing for an empty list or a list of only unfocusable candidates;
   b. Tab on the last focusable returns "move focus to the first" with the default prevented;
   c. Shift+Tab on the first focusable returns "move focus to the last" with the default prevented;
   d. Tab and Shift+Tab between middle elements return "nothing", so the browser default applies;
   e. Tab or Shift+Tab with focus outside the list returns "move to first" or "move to last" respectively;
   f. Tab or Shift+Tab with an empty list returns "prevent default only";
   g. Escape returns "close";
   h. other keys, and Tab with Ctrl, Alt or Meta, return "nothing".
3. `Projects.tsx` uses the helper so that, in a browser:
   a. opening Config puts focus on the dialog's first focusable element (the **Close** button);
   b. Esc closes the modal;
   c. repeated Tab, and repeated Shift+Tab, cycle only through the dialog's controls, including the form fields once they load, and never reach the page behind;
   d. closing by Esc, by **Close** or by a backdrop click puts focus back on the **Config** button of the same project.
4. **Close**, the backdrop click and saving behave as before, apart from the focus return.
5. The palette and file-viewer dialogs are unchanged.
6. No dependency is added to any `package.json`.
7. `npm run check` passes.
8. Manual browser check, recorded in the PR: open Config, Tab through, press Esc, and confirm focus is back on Config; repeat closing with **Close** and with a backdrop click.
