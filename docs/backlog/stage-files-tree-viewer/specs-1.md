# Specification: stage-files-tree-viewer

## Summary
On the web dashboard's Run screen, the "Files changed per stage" panel shows each stage's files as a collapsible directory tree instead of a flat list. It looks like the tree in the Documents panel, but its files are plain labels with no Open button. Each stage keeps its own directory open/closed state.

## Scope
**In:**
- `web/ui/src/Run.tsx`: the panel, and making the tree node view usable without an Open action.
- `web/ui/src/tree.ts`: pure helpers for the open/closed decisions.
- `test/tree.test.ts`: tests for those helpers.
- `docs/web-ui.md`: description of the panel.

**Out:**
- Stage file collection in `src/` and `web/server/`, including the shape of `RunView.stageFiles`.
- Git diff viewing and git commit history changes.
- Opening a stage file from this panel, in any form.
- New packages. This feature needs none.

## Inputs
`v.stageFiles` from the run view: an object mapping a stage name to an array of file paths relative to the project root. It is read as it is today, and refreshed by the Run screen's 2-second reload.

## Behaviour

### Panel and stage rows (unchanged)
1. The panel is shown only when `v.stageFiles` has at least one stage, under the title "Files changed per stage".
2. Stages appear in the order of `v.stageFiles`, one collapsible row each.
3. Each stage row's header shows the stage name and, muted and in parentheses, the length of that stage's file list.
4. Stage rows start closed.

### Tree content
5. Inside a stage row, the stage's paths are turned into a tree with the existing `buildDocTree`, so directories come before files and each level is alphabetical. No flat list is rendered.
6. A directory node shows 📁, the directory name, and, muted and in parentheses, its number of direct children (not the number of files beneath it). It expands and collapses through a `<details>` element.
7. A file node shows 📄 and the file's base name in the `.mono .small` style. Its tooltip (`title`) is the file's full path. Long names are cut with an ellipsis, as in Documents.
8. A file node has no Open button and no other action, for every file in this panel, including files in the item's backlog folder. It is not clickable.
9. Child nodes are indented by `14px`, and spacing matches the Documents tree.
10. If a stage's tree has no nodes, the stage row shows the muted small text "No files changed." in place of the tree. The header still shows the list length.

### Directory open/closed state
11. **Default.** A directory with no recorded toggle starts open when it has at most one direct child, and closed otherwise, so single-child chains unfold on their own. This is the same rule as Documents, and both panels use the same helper.
12. **Toggle.** When a directory is toggled, its new state is recorded for that stage and overrides the default, in both directions: a closed-by-default directory can stay open and an open-by-default one can stay closed.
13. **Isolation.** State is held per stage. Toggling a directory affects no other stage, even when the other stage has the same directory path. A stage/path pair must never collide with a different pair: for example, stage `A` with directory `b/c` and stage `A/b` with directory `c` stay separate.
14. **Separate from Documents.** Toggling a directory here has no effect on the Documents panel, and toggling one in Documents has no effect here.
15. **Lifetime.** Recorded state survives the 2-second reloads and closing and reopening the stage row. It is cleared when the Run screen moves to another run (a different project or slug), at the same point `openDirs` is cleared today. It is held in memory only, so a page reload clears it, as it does for Documents.

### Documents panel (unchanged)
16. The Documents panel looks and behaves as it does today, with an Open button on each file, the same default open rule, and the same "No files yet." text. To allow this, the Open action on the tree node view becomes optional: a file node shows the button only when an open action is supplied.

### Helpers
17. `web/ui/src/tree.ts` gains pure helpers, with no Preact or browser dependency, that provide:
    - **Default rule:** for a directory node, whether it starts open (rule 11).
    - **Lookup:** for a stage, a directory node and the per-stage state, whether the directory is open. This is the recorded value if there is one, including a recorded `false`, and otherwise the default.
    - **Record:** given the per-stage state, a stage, a directory path and a value, the updated state. The input is not mutated. If the value is already recorded for that stage and path, the same state object is returned, so no re-render is caused.

    `Run.tsx` uses these helpers rather than repeating the logic. Helper names and the state's shape are decided at the Plan stage.

## Performance
Trees may be memoized per stage or computed inside the stage map. Either is acceptable, since stage lists are typically under 100 files. A reload must not lose open/closed state whichever is chosen.

## Error and edge cases
| Case | Behaviour |
|---|---|
| `v.stageFiles` is empty | The panel is not shown. |
| A stage's file list is empty | The stage row shows `(0)` and "No files changed." |
| Every entry in a stage's list is blank, so the tree has no nodes | The stage row shows "No files changed." The header still shows the list length. |
| Duplicate paths in a stage's list | The tree shows one node, as `buildDocTree` does. The header still shows the list length. |
| Backslashes or repeated slashes in a path | Normalised by `buildDocTree`. The file tooltip shows the path as given. |
| File at the project root, with no directory | Shown as a top-level file node. |
| A reload adds files to a stage | New nodes appear, and directories with recorded state keep it. Directories with no recorded state follow the default rule using their current child count. |
| A recorded directory disappears from a stage | Nothing is shown for it and no error occurs. Its state may stay in memory until the run changes. |

The panel adds no error messages or network calls of its own. `api.file` is not called from this panel.

## Docs
In `docs/web-ui.md`, the Run screen list says that files changed per stage are shown per stage as a collapsible directory tree, as labels without an Open button. The mod feature table row ("8 shown, then +N more") describes the mod and stays as it is.

## Tests
- `test/tree.test.ts` covers the helpers in rule 17, with no new dependency. These are the Red tests stage's failing tests.
- Rendering has no component tests. It is checked by typecheck, `npm run build:web` and the manual check below.

## Acceptance criteria
**Default rule**
1. A directory with 0 or 1 child defaults to open, and one with 2 or more children defaults to closed.

**Lookup and record**
2. With no recorded state, the lookup returns the default for both a single-child and a multi-child directory.
3. After recording `true` for a multi-child directory, the lookup returns open. After recording `false` for a single-child directory, the lookup returns closed.
4. After recording a value for a directory in one stage, the lookup for the same directory path in another stage still returns the default.
5. State recorded for stage `A` and directory `b/c` does not affect the lookup for stage `A/b` and directory `c`, and the reverse.
6. Recording leaves the input state unchanged and returns a new state. Recording a value already held returns the same state object.
7. Recording in one stage keeps the values already recorded for other stages and for other directories in the same stage.

**Build**
8. `npm run check` passes, including the new tests in `test/tree.test.ts`, and `buildDocTree`'s existing tests pass unchanged.
9. `npm run typecheck` and `npm run build:web` succeed.
10. `git diff` touches no files in `src/` or `web/server/`, and `package.json` is unchanged.

**Manual, on a run with stage files**
11. Opening a stage row shows a tree with directories first, 📁 with direct child counts, and 📄 with base names. Hovering a file shows its full path. No file has an Open button.
12. A chain of single-child directories is unfolded on first view, and a directory with several children is closed.
13. Stage rows start closed, and each header still shows the stage name and count.
14. Toggling a directory in one stage leaves the same directory in another stage and in Documents unchanged.
15. A toggle remains after waiting more than 2 seconds for a reload, and after closing and reopening the stage row.
16. Moving to another run and back restores the default open state.
17. A stage with no files shows "No files changed."
18. The Documents panel still shows Open buttons, and Open still shows the file.

**Docs**
19. `docs/web-ui.md` describes the tree view for files changed per stage.
