# Test cases: stage-files-tree-viewer

Tests live in `test/tree.test.ts` and import the real helpers from `web/ui/src/tree.ts`.

## Automated matrix

| ID | Requirement | Case | Test |
|---|---|---|---|
| T1 | AC 1, rule 11 | 0 children defaults open | defaultDirOpen > 0 children is open |
| T2 | AC 1 | 1 child defaults open | defaultDirOpen > 1 child is open |
| T3 | AC 1 | 2+ children default closed | defaultDirOpen > 2 or more children is closed |
| T4 | rule 6/11 | Direct children counted, not descendants | defaultDirOpen > counts direct children |
| T5 | AC 2 | No record returns default (single, multi) | isStageDirOpen > empty state |
| T6 | AC 2 | Stage present, directory absent | isStageDirOpen > stage present but directory absent |
| T7 | AC 3 | Recorded true opens multi-child dir | isStageDirOpen > recorded true |
| T8 | AC 3, rule 12 | Recorded false closes single-child dir (false is not "no record") | isStageDirOpen > recorded false |
| T9 | design: property safety | Dir/stage named `constructor` ignores inherited values | isStageDirOpen > constructor |
| T10 | AC 4, rule 13 | Record in stage A, stage B keeps default | recordStageDir > another stage |
| T11 | AC 5, rule 13 | `A`+`b/c` vs `A/b`+`c` do not collide, both directions | recordStageDir > separate |
| T12 | AC 6 | Input not mutated, new object returned | recordStageDir > does not mutate |
| T13 | AC 6 | Held value (true and false) returns same object | recordStageDir > held value |
| T14 | rule 12 | Opposite of held value updates | recordStageDir > opposite |
| T15 | AC 7 | Other stages and dirs kept | recordStageDir > keeps other stages |
| T16 | plan Step 1 | Other stages' inner objects keep identity | recordStageDir > inner objects identical |
| T17 | design: property safety | `constructor`/`toString` names written as own keys | recordStageDir > inherited keys |

`buildDocTree` existing tests are unchanged (AC 8).

## Review items (no automated test)

- AC 8-10: `npm run check`, `npm run typecheck`, `npm run build:web`, `git diff` touching nothing in `src/`, `web/server/` or `package.json`.
- AC 11-18 and rules 1-10, 14-16: rendering (tree layout, 📁/📄 labels, tooltips, no Open button, "No files changed.", per-stage state surviving reloads, clearing on run change, Documents panel unchanged). No component tests per spec; verify manually. Includes the toggle filter in the stage panel (a single-child directory gains a second child after reload and follows the default).
- AC 19: `docs/web-ui.md` describes the tree view (documentation, checked in Review).
- Edge cases from the spec table (empty `stageFiles`, blank/duplicate paths, root-level file) are rendering behaviour built on `buildDocTree`; verify manually.
