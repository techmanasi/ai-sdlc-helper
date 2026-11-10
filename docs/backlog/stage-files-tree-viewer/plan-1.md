# Plan: stage-files-tree-viewer

Spec: `specs-1.md`. Decisions: `decisions.md` (Q1 no Open button in this panel; Q2 Documents default rule, per-stage toggles; Q3 pure helpers, tested in `test/tree.test.ts`).

## Dependencies
- none

## Files touched
| File | Change |
|---|---|
| `web/ui/src/tree.ts` | Add `StageDirState`, `defaultDirOpen`, `isStageDirOpen`, `recordStageDir` |
| `test/tree.test.ts` | Add tests for those helpers (Red tests stage) |
| `web/ui/src/Run.tsx` | Generalise `DocTreeNodeView`; add `stageDirs` state; render the panel as a tree |
| `docs/web-ui.md` | Run screen list, line 169 |

Nothing in `src/`, `web/server/` or `package.json` changes. `web/ui/src/api.ts` does not change either: `RunView.stageFiles` stays `Record<string, string[]>`.

## Design decisions (settled here)

**State shape: nested, not a joined key.** `StageDirState = Record<string, Record<string, boolean>>`, stage name then directory path. A joined string key such as `${stage}/${path}` is the collision rule 13 forbids (`A` + `b/c` versus `A/b` + `c`). Nesting rules it out without any separator.

**Property-name safety.** State objects are plain objects and directory names come from the target project, so a directory called `constructor` or `toString` would read an inherited value from `Object.prototype`. `isStageDirOpen` therefore accepts a recorded value only when `typeof recorded === 'boolean'`, which also keeps a recorded `false` distinct from "no record". `recordStageDir` writes with computed keys, which create own properties even for `__proto__`.

**`DocTreeNodeView` takes a lookup callback, not a map.** Rule 17 requires `Run.tsx` to use the lookup helper, and the two panels look up differently. The `openDirs` prop becomes `isDirOpen: (node: DocTreeNode) => boolean`.

**`onToggleDir` receives the node, and the stage panel ignores non-user toggles.** A `<details>` fires `toggle` whenever its `open` attribute changes, including when it is first rendered open and when `open` is set from props. Recording those events unconditionally would break the spec:
- A default-open directory would be recorded as `true` on mount, so one that later gains a second child would not follow the default rule ("A reload adds files to a stage").
- When the run changes, `stageDirs` is cleared while the old `v` is still on screen. The `open` changes that follow would write the old run's directories into the cleared state, breaking rule 15.

So the stage panel's handler records only when the new value differs from the current lookup (step 3.5). A user toggle always differs, and these events never do. This filter lives in the stage panel's callback, not in `DocTreeNodeView`, so the Documents panel keeps today's behaviour exactly (rule 16). That means `onToggleDir` changes from `(path, isOpen)` to `(node, isOpen)`.

**Trees are built inside the stage map, with no `useMemo`.** The spec allows either. `Run` returns early at `if (!v)` (`web/ui/src/Run.tsx:290`), so a new hook after that line would run on only some renders. Stage lists are small, and open/closed state lives in `stageDirs`, so rebuilding on each reload loses nothing. The new `useState` must go above that early return.

**Stage rows get `key={name}`.** They are unkeyed today, so a stage inserted ahead of others would make Preact reuse a row's `<details>` for a different stage and carry its native open state across. Rule 13 makes per-stage identity matter here.

## Step 1: Red tests: `test/tree.test.ts`

Extend the import on line 2:
```ts
import { buildDocTree, defaultDirOpen, isStageDirOpen, recordStageDir, type StageDirState } from '../web/ui/src/tree.js';
```

Add these blocks after the `buildDocTree` block, leaving that block unchanged. Build nodes with `buildDocTree`, so the tests use real trees: for example `buildDocTree(['a/x.ts'])[0]` for a single-child directory and `buildDocTree(['a/x.ts', 'a/y.ts'])[0]` for a multi-child one. For the 0-child case use a literal `{ name: 'a', path: 'a', isDir: true, children: [] }`.

`describe('defaultDirOpen')`:
- 0 and 1 children give `true`; 2 or more give `false` (AC 1).
- Counts direct children, not descendants: `buildDocTree(['a/b/x.ts', 'a/b/y.ts'])[0]` has one direct child, so it gives `true`.

`describe('isStageDirOpen')`:
- With `{}`, returns the default for single-child and multi-child directories (AC 2).
- With `{ S: {} }`, also returns the default (stage present, directory absent).
- A recorded `true` opens a multi-child directory; a recorded `false` closes a single-child directory (AC 3).
- A directory whose path is `constructor` (from `buildDocTree(['constructor/x.ts', 'constructor/y.ts'])[0]`) returns its default of `false` with no record, and with `{}` and a stage named `constructor`. After `recordStageDir` with `true`, it returns `true`.

`describe('recordStageDir')`:
- Recording in stage `A` leaves the same directory path in stage `B` at its default (AC 4).
- Stage `A` + `b/c` and stage `A/b` + `c` stay separate in both directions. Use nodes with those paths and record opposite-to-default values (AC 5).
- The input is not mutated, checked against a `structuredClone` taken beforehand, and the result is a different object (AC 6).
- Recording a held value returns the same object (`toBe`), for both `true` and `false` (AC 6).
- Recording the opposite of a held value returns a new state with the new value (rule 12).
- Keeps values recorded for other stages and for other directories in the same stage (AC 7).
- Leaves other stages' inner objects unchanged (`toBe`), so unrelated stages keep their identity.

These fail before Step 2 because the three functions do not exist. Check with `ai-sdlc-helper run --file test/tree.test.ts`.

## Step 2: Helpers: `web/ui/src/tree.ts`

Append after `buildDocTree`. No imports.

```ts
/** Recorded directory open/closed toggles: stage name, then directory path. */
export type StageDirState = Record<string, Record<string, boolean>>;

/** A directory starts open when it has at most one direct child, so single-child chains unfold on their own. */
export function defaultDirOpen(node: DocTreeNode): boolean {
  return node.children.length <= 1;
}

/** Whether a directory is open in a stage: the recorded value if there is one, otherwise the default. */
export function isStageDirOpen(state: StageDirState, stage: string, node: DocTreeNode): boolean {
  const recorded = state[stage]?.[node.path];
  return typeof recorded === 'boolean' ? recorded : defaultDirOpen(node);
}

/** Records a directory's state for a stage without mutating the input. Returns the same object if nothing changes. */
export function recordStageDir(state: StageDirState, stage: string, path: string, open: boolean): StageDirState {
  if (state[stage]?.[path] === open) return state;
  return { ...state, [stage]: { ...state[stage], [path]: open } };
}
```

`?.` on `state[stage]` is needed at runtime even if the type does not require it, and `noUncheckedIndexedAccess` is not assumed either way. If typecheck or lint flags it as unnecessary, keep the runtime behaviour and adjust the type (for example `Partial<Record<...>>`) rather than removing the check.

## Step 3: Component and panel: `web/ui/src/Run.tsx`

1. **Import** (line 6):
   ```ts
   import { buildDocTree, defaultDirOpen, isStageDirOpen, recordStageDir, type DocTreeNode, type StageDirState } from './tree';
   ```

2. **`DocTreeNodeView` props** (lines 40-50):
   ```ts
   node: DocTreeNode;
   openFile?: (path: string) => void;
   isDirOpen: (node: DocTreeNode) => boolean;
   onToggleDir: (node: DocTreeNode, isOpen: boolean) => void;
   ```
   - Lines 80-87: render the button only when supplied, as `{openFile && (<button …>Open</button>)}`. The inner `onClick={() => openFile(node.path)}` type-checks on the repo's TypeScript 5.9, which keeps the narrowing inside closures for unassigned parameters.
   - Lines 92-94: replace with `const isOpen = isDirOpen(node);`.
   - Line 102: `onToggleDir(node, target.open);`.
   - Lines 131-137 (recursion): pass `openFile={openFile}`, `isDirOpen={isDirOpen}`, `onToggleDir={onToggleDir}`.

3. **State**: after line 228, above the `if (!v)` return:
   ```ts
   const [stageDirs, setStageDirs] = useState<StageDirState>({});
   ```

4. **Clear on run change**: in the `[project, slug]` effect, directly after `setOpenDirs({});` on line 267, add `setStageDirs({});`.

5. **Panel**: replace lines 785-790:
   ```tsx
   {Object.entries(v.stageFiles).map(([name, files]) => {
     const tree = buildDocTree(files);
     return (
       <details key={name}>
         <summary>{name} <span class="muted">({files.length})</span></summary>
         <div style={{ paddingTop: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
           {tree.map(node => (
             <DocTreeNodeView
               key={node.path}
               node={node}
               isDirOpen={dir => isStageDirOpen(stageDirs, name, dir)}
               onToggleDir={(dir, open) => setStageDirs(prev => (open === isStageDirOpen(prev, name, dir) ? prev : recordStageDir(prev, name, dir.path, open)))}
             />
           ))}
           {!tree.length && <span class="muted small">No files changed.</span>}
         </div>
       </details>
     );
   })}
   ```
   No `openFile` is passed, so no file has a button (rule 8), and this panel never calls `api.file`. The check uses `tree.length`, not `files.length`, so all-blank lists also show the empty text. The header keeps `files.length`.

6. **Documents panel** (lines 798-804): same output, adapted to the new props:
   ```tsx
   <DocTreeNodeView
     key={node.path}
     node={node}
     openFile={openFile}
     isDirOpen={dir => openDirs[dir.path] ?? defaultDirOpen(dir)}
     onToggleDir={(dir, open) => setOpenDirs(prev => (prev[dir.path] === open ? prev : { ...prev, [dir.path]: open }))}
   />
   ```
   `openDirs` stays a separate state, which gives rule 14. It keeps recording every `toggle`, as it does today.

## Step 4: Docs: `docs/web-ui.md`

Change line 169 to say that files changed per stage are shown per stage as a collapsible directory tree, as labels without an Open button. Keep the line within the file's wrap width:
```md
   - files changed and uncommitted, tests passed and failing;
   - files changed per stage, each stage as a collapsible directory tree of labels with no Open button;
```
Leave line 22 (the mod feature table, "8 shown, then +N more") as it is.

## Step 5: Verify

1. `npm run check > /tmp/sdlc-$(basename $PWD).log 2>&1; echo exit=$?` (AC 8, and the `typecheck` half of AC 9).
2. `npm run build:web` (AC 9).
3. `git diff --stat` shows only the four files above (AC 10).
4. Manual check on a run with stage files, AC 11-18. Two checks target the toggle filter:
   - A single-child directory left untouched closes by default once a reload gives it a second child.
   - After moving to another run and back, every directory is at its default (AC 16).

Rendering has no component tests, per the spec and Q3.

## Order

Steps 1 → 2 → 3 → 4 → 5. Step 1 belongs to the Red tests stage; Steps 2-4 belong to Implement. Step 2 must come before Step 3 because `Run.tsx` imports the helpers.

## Acceptance criteria coverage
| AC | Covered by |
|---|---|
| 1-7 | Step 1 tests against Step 2 helpers |
| 8-10 | Step 5 |
| 11-18 | Step 3, checked manually in Step 5 |
| 19 | Step 4, checked in Review |
