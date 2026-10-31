# Review: stage-files-tree-viewer

Reviewed `git diff eda3688` (`docs/web-ui.md`, `web/ui/src/Run.tsx`, `web/ui/src/tree.ts`) against `specs-1.md`.

**Result: no blockers, and no source changes made.** AC 8, 9 and 11-18 are not yet verified (see below).

## Blockers
None.
- No test reads or asserts on documentation text. `test/tree.test.ts` imports the real `web/ui/src/tree.ts`; the `docs/...` strings in it are only sample paths passed to `buildDocTree`. No test references `docs/web-ui.md` or `Run.tsx`.
- The documented behaviour has code: the `docs/web-ui.md` line matches the tree rendering in `web/ui/src/Run.tsx:788-806`, with no `openFile` passed, so no Open button appears.

## Correctness and security
No defects found, by reading the code. None of this rendering behaviour was run in a browser.
- Rules 1-10 and 16 are met by the panel and the optional `openFile` prop.
- Rules 11-14 are met: the state is nested by stage, so `A` + `b/c` cannot collide with `A/b` + `c`, and `stageDirs` is separate from `openDirs`.
- Rule 15 is met: `stageDirs` is cleared beside `openDirs`, and it is declared above the `if (!v)` return. `Run` is keyed by route, so a change of slug also remounts it.
- The toggle filter at `web/ui/src/Run.tsx:799` ignores mount and prop-driven `toggle` events. A default-open directory is therefore not recorded on mount, and stale events after a run change do not refill the cleared state.
- Names such as `constructor`, `toString` and `__proto__` are safe in the stage helpers: lookup accepts only booleans, and writes use computed keys, which create own properties.
- File names render as escaped Preact text, and the panel makes no network calls and never calls `api.file`.

## Acceptance criteria coverage
| AC | Status |
|---|---|
| 1-7 | Tested against the real helpers. `ai-sdlc-helper run --file test/tree.test.ts`: 21 passed, 0 failed. |
| 8 | **Partly verified.** `test/tree.test.ts` passes and the `buildDocTree` tests are unchanged. `npm run check` was not run. |
| 9 | **Not verified.** `npm run typecheck` and `npm run build:web` were outside this review's allowed commands, and `impl-1.log` says Implement did not run them either. |
| 10 | Verified by `git diff`: nothing in `src/`, `web/server/` or `package.json` changed. |
| 11-18 | **No automated test and not checked manually.** The spec makes these manual, with no component tests. They rest on code reading only. |
| 19 | Verified by reading: `docs/web-ui.md:170` describes the tree. It has no test, which is correct for documentation. |

## Remaining risks
- The toggle filter at `web/ui/src/Run.tsx:799` has no automated test because it sits inline in the component. The two checks in plan Step 5.4 are its only coverage.
- `npm run check` and `npm run build:web` must pass before Ship. Typecheck covers `web/ui`, so the changed `DocTreeNodeView` props are not yet confirmed by the compiler.

## Left as is
The Documents lookup `openDirs[dir.path] ?? defaultDirOpen(dir)` (`web/ui/src/Run.tsx:818`) can read an inherited value for a top-level directory named `constructor`. The old code did the same, and rule 16 keeps Documents unchanged.
