# Decisions for stage-files-tree-viewer

## Round 1 (2026-11-01)

### Q1: Open action for stage files inside the item's backlog folder
The brief says a non-openable stage file renders as a label, which leaves open whether openable ones keep an "Open" button. Stage file paths are relative to the project root (for example `docs/backlog/<slug>/specs-1.md`), but `api.file` takes paths relative to the item's folder and refuses or 404s anything else. `RunView` does not expose the backlog directory, so offering Open would mean inferring that prefix in the UI or changing the server, and the server is out of scope. Should any file in this panel have an Open button?
**Suggested:** No. Every file in "Files changed per stage" renders as a label with no Open button. Files in the item's folder can already be opened from the Documents panel, so `DocTreeNodeView`'s Open action becomes optional and this panel leaves it off.
**Answer:** accept

### Q2: Default expansion of directories, and how long toggles last
The brief allows "preserved or defaults sensibly" and gives two different examples (open when few files/folders, or native `<details open>`), so the spec needs one rule. The Run screen also reloads its data every 2 seconds, and `DocTreeNodeView` sets `open` from state, so the spec must say whether a toggle survives that reload. Which default applies, and how long do a developer's toggles last?
**Suggested:** Use the Documents rule: a directory starts open when it has at most one child and closed otherwise, so single-child chains unfold on their own. A developer's toggle is then kept per stage, so the same directory in two stages stays independent. It survives the 2-second reloads and collapsing the stage, and is cleared when moving to another run, as `openDirs` is today. Stage rows keep starting closed.
**Answer:** accept

### Q3: What the failing tests cover, given the red gate
The brief only asks for tests "if any tree helper functions are added", and otherwise relies on typecheck, build and manual checks. The Red tests stage stops the run with `RED GATE FAILED` if the tests pass before implementation, so a change with no new failing test cannot get past it. The repo has no component rendering tests: `test/tree.test.ts` only imports the pure `web/ui/src/tree.ts`, and `jsdom` and a Preact renderer are not dependencies. What should the failing tests exercise?
**Suggested:** Move the panel's decisions into pure helpers in `web/ui/src/tree.ts`, covering the default open rule and the lookup of a directory's open state per stage (including isolation between stages), and use them from `Run.tsx`. Cover them in `test/tree.test.ts`, with no new dependency. The rendering itself is checked by typecheck, `npm run build:web` and the manual check in the brief.
**Answer:** accept
