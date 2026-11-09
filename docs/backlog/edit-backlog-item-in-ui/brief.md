---
pr: https://github.com/techmanasi/ai-sdlc-helper/pull/84
---

# edit-backlog-item-in-ui

Type: feature
Priority: P2 (normal)

## Problem
The web UI can add a backlog item (New item page, api.addItem) but cannot change one afterwards. The New item page refuses a slug that already exists, the run and Completed pages show the brief as read-only text, and the only way to change a brief or its index line is to open the file in an editor ("Open in editor") and keep docs/backlog/index.md in step by hand. Fixing a typo or sharpening a brief before a run starts needs a trip out of the UI.

## Expected behaviour
- Every backlog card on the Board and every run page has an Edit action that opens the New item form in edit mode for that slug, filled from the item's brief.md and its index.md line (title, type, priority).
- The slug is shown but cannot be changed in edit mode (renaming is out of scope).
- Saving writes brief.md and the index line; it never creates a second item and never changes the item's state or checkbox.
- An item that has a run in progress cannot be edited; the form says why and is read-only.
- Two edits that overlap are detected: saving uses the file's version (hash) it was loaded from and refuses with a clear message when the file changed, the same way the settings editor does (src/config/edit.ts).
- The change is left uncommitted in the working tree, like Save on a new item, and the form says so.

## Decisions
- Reuse the New item form and the Markdown editor with preview instead of building a second one.
- Add one server route (read item for edit, write item) next to the existing add-item route, backed by a function in src/backlog/index.ts beside addBacklogItem.
- The index line is the title field; the header line of the brief stays as written.

## Scope
- In: edit mode in NewItem.tsx, the Edit action on the Board card and run page, the server route, the backlog function, tests.
- Out: renaming or deleting an item, committing the change, editing a run's logs or spec and plan documents.

## Tests
- Saving an edit changes brief.md and the index line and nothing else.
- A stale version is refused and nothing is written.
- An item with a running pipeline is refused.
- The slug is not changed, and an unknown slug is a 404.

## Docs
- docs/web-ui.md: the Edit action on backlog items.
