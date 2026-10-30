# stage-files-tree-viewer

Type: feature
Priority: P2 (normal)
Source: User request: "In the web UI (`web/ui/src/Run.tsx`), under 'Files changed per stage', currently each stage's files are rendered as a flat unordered list (`<ul><li>{f}</li></ul>`). The user wants the files to be rendered in a collapsible tree viewer (similar to the Documents tree viewer in `web/ui/src/tree.ts` and `DocTreeNodeView` in `Run.tsx`), instead of a plain list of files."

## Problem
In the web dashboard's Run details screen (`web/ui/src/Run.tsx`), the "Files changed per stage" panel displays modified files per stage (`v.stageFiles`) inside a `<details>` element with a flat unordered list (`<ul class="mono small" style={{ margin: '4px 0', paddingLeft: '18px' }}>{files.map(f => <li>{f}</li>)}</ul>`).
For stages that touch nested paths across multiple directories (e.g. `docs/backlog/...`, `src/...`, `web/ui/src/...`, `test/...`), a flat list makes it hard to see directory grouping, file hierarchy, and changes at a glance.
In contrast, the "Documents" panel already visualizes hierarchical files using `buildDocTree` from `web/ui/src/tree.ts` and `DocTreeNodeView` in `web/ui/src/Run.tsx`. "Files changed per stage" lacks this hierarchical tree presentation.

## Expected behaviour
In `web/ui/src/Run.tsx`, under "Files changed per stage":
1. Each stage continues to have its summary header showing the stage name and file count: `<summary>{name} <span class="muted">({files.length})</span></summary>`.
2. Inside each stage, instead of rendering a flat `<ul><li>{f}</li></ul>`, the stage's file paths are converted into a hierarchical tree using `buildDocTree(files)`.
3. The files and directories are rendered as a collapsible tree view:
   - Directory nodes display a folder icon (📁), directory name, and child count `({children.length})`. They are collapsible/expandable via `<details>`.
   - File nodes display a file icon (📄) and file name with the full path available in the title tooltip.
   - Child nodes are indented cleanly (e.g. `paddingLeft: '14px'`), matching the styling of `DocTreeNodeView`.
4. If a stage has 0 files, an empty indicator (e.g. `<span class="muted small">No files changed.</span>`) is shown instead of an empty tree.
5. Directory collapse/expand state is preserved or defaults sensibly (e.g. default open when few files/folders, or native `<details open>` behavior).

## Decisions
- Reuse `buildDocTree` from `web/ui/src/tree.ts`: `buildDocTree(files)` already accepts an arbitrary array of file path strings (`string[]`) and produces a sorted tree (`DocTreeNode[]` with dirs first, alphabetical sorting).
- Extract or specialize the tree node view: either adapt `DocTreeNodeView` to make the "Open" action optional/configurable (since stage files don't currently have an `api.file` endpoint unless they happen to be in the backlog folder), or introduce a dedicated `StageFileTreeNodeView` / reusable `TreeNodeView`.
- File item display: render file icon (📄) and file basename/path with `.mono .small` font. If the stage file is non-openable, it renders as a clean label rather than rendering an unusable "Open" button.
- Keep per-stage tree state isolated: each stage's tree manages its directory expansion state independently (or relies on native `<details>` element state).
- Performance & memoization: memoize tree generation per stage where appropriate (`useMemo`) or compute inside stage map since stage file lists are typically small (<100 files).

## Scope
- In: `web/ui/src/Run.tsx`, and optionally `web/ui/src/tree.ts` (if extracting/sharing tree node components or types).
- Out of scope: Backend stage file collection in `src/engine/` or `web/server/`, git diff viewing, git commit history changes.

## Tests
- `test/tree.test.ts`: Add test cases if any tree helper functions are added or modified.
- `web/ui`: Verify TypeScript typecheck passes (`npm run typecheck`).
- Web build: Verify `npm run build:web` succeeds without errors.
- Manual verification: Open a run with stage files in the web UI and verify the collapsible directory tree displays correctly per stage.

## Docs
- Update `docs/web-ui.md` to document the collapsible tree view for files changed per stage.

## Open questions
- none
