# Review 1: edit-backlog-item-in-ui

Diff reviewed: `git diff 5271518` against `specs-1.md`.

## Verdict

No blockers. The feature is built in code: `readBacklogEdit` and `editBacklogItem` in `src/backlog/index.ts`, the
`GET …/backlog/<slug>/edit` and `POST …/backlog/<slug>` routes in `web/server/index.ts`, and the edit mode in
`web/ui/src/NewItem.tsx`, with links from `Board.tsx` and `Run.tsx`. No test reads or asserts on documentation text.
Each part of the `docs/web-ui.md` section has code behind it.

## Fixed in this review

1. **A failed index.md write left brief.md changed** (`src/backlog/index.ts`, `editBacklogItem`). brief.md was
   written first. If the index.md write then failed, the save returned an error but the new brief stayed on disk.
   That breaks spec §5 ("every error writes nothing"). Now the old brief.md is put back. If brief.md did not exist
   before, it is removed, and so is its folder when the save created it.
2. **A non-string `priority` was silently dropped** (`web/server/index.ts`). For example, `priority: 5` was ignored,
   and the save went ahead without it. Spec §4 says a given priority must be one of the four options or the save
   gets a 400. Now it is passed to `editBacklogItem`, which refuses it with the priority message.

## Acceptance criteria coverage

| # | Covered by |
|---|---|
| 1–3 | `test/backlog-edit.test.ts` "changes brief.md and the item's index line…" and "ignores a slug field"; route test "reads an item… saves a change" |
| 4, 5 | "stale versions" block; route test "a save with an old version is a 409" |
| 6 | "items whose pipeline has started": record states, branch, worktree, in-place status.json; route test starts a real run |
| 7 | ".discarded marker… editable again"; the route test discards a real run |
| 8 | unknown slug tests (read and write, `stray` has a brief.md) |
| 9 | completed/archived tests (lib and route) |
| 10 | "an indexed item with no brief.md can be saved"; version of empty text |
| 11 | Type-only and Priority-only rewrites, missing lines go into `notSaved`, unchanged selects |
| 12 | "invalid fields" block; route invalid-fields test |
| 13, 14 | **No automated test.** The repo has no UI component test setup, so the Edit links, the read-only form and the return to the opening page were checked by reading the code only. |

Both test files pass: `test/backlog-edit.test.ts` (45) and `web/test/backlog-edit-route.test.ts` (8).

## Notes (not fixed, low risk)

- If the developer types a title that ends in `(blocked: …)`, or starts with `Bug:`, that text is written into the
  index line. It is then read back as a note or a label. Status still comes from the marker, so nothing breaks.
- The version check and the writes are not one atomic step, so a file changed in that small gap is not caught. This
  matches how `editSettings` works.
- `briefType` matches `^[ \t]*Type:`, but `parseBrief` matches `^\s*Type:`. They differ only on unusual whitespace.
