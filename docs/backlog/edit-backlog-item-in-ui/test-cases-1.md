# Test cases: edit-backlog-item-in-ui

Spec: `specs-1.md`. Plan: `plan-1.md`.
Test files: `test/backlog-edit.test.ts` (backlog functions), `web/test/backlog-edit-route.test.ts` (HTTP routes).

## Matrix

| # | Criterion | Case | Test file |
|---|---|---|---|
| 1 | 1, 3 | Edit changes brief.md and the item's line only; other lines byte-identical; `git status` lists two paths; no commit; no new folder; returned hash equals fresh read | backlog-edit |
| 2 | 3 | A `slug` field in the payload is ignored; no `.tmp` file left | backlog-edit |
| 3 | 2 | Blocked and parked keep marker and note; label added when missing | backlog-edit, route |
| 4 | 11 | Selects unchanged: brief `Type:`/`Priority:` lines kept as typed | backlog-edit |
| 5 | 11 | Only type / only priority changed rewrites only the first matching line | backlog-edit |
| 6 | 11 | Brief without `Type:`/`Priority:`: nothing added, `notSaved` lists them | backlog-edit |
| 7 | 1 | CRLF endings and missing trailing newline of index.md are kept | backlog-edit |
| 8 | 4 | Stale: brief changed on disk, or own line changed, gives 409, current hash, nothing written; second save with old hash is stale; returned hash is accepted next | backlog-edit, route |
| 9 | 5 | Another item's line changed between read and write: save succeeds, change kept | backlog-edit |
| 10 | 6 | Started (running, failed, done, interrupted, refused, unparsable record; branch only; worktree dir only; in-place status.json): 409, nothing written, read `editable: false` with stop-and-discard reason | backlog-edit |
| 11 | 6 | Started check precedes version check; neighbours unaffected | backlog-edit |
| 12 | 6, 7 | Real run started over HTTP: read-only and 409; after stop + discard editable again | route |
| 13 | 7 | Only `<slug>.discarded` marker left: editable | backlog-edit |
| 14 | 8 | Unknown slug (also with brief.md, also `../one`): 404 read and write, nothing written | backlog-edit, route |
| 15 | 8 | Missing index.md: 404 | backlog-edit |
| 16 | 9 | Completed and archived: read `editable: false` (`archived: true` for old), write 400, nothing written | backlog-edit, route |
| 17 | 10 | No brief.md: read `brief: null`, hash equals that of empty brief; save creates brief.md | backlog-edit |
| 18 | 12 | Invalid title (two lines, CR, blank), type, priority, blank brief, missing/empty/non-text hash: 400, nothing written; all four priorities accepted | backlog-edit, route |
| 19 | read view | Title without label/note, type from label else brief else `feature`, priority, marker, status, version scope | backlog-edit |
| 20 | 3.4 | `GET …/backlog/<slug>` still answers `{ slug, brief }`; bad slug is 400 | route |

## Review items (not tested by code)

- Criteria 13, 14 (Edit on Board card and run page, edit-mode form, read-only form with reason, Save/Cancel return to origin, toast, uncommitted note): UI has no test harness; check in Review and by hand (`npm run build`, `node dist/bin.js ui`).
- Error case 7 (filesystem failure gives 500, temp file removed): not reproducible portably without mocking `node:fs`; check `atomicWrite` in Review.
- Section 8: `docs/web-ui.md` describes the Edit action: documentation, checked in Review.
- Priority options in `NewItem.tsx` match `PRIORITY_OPTIONS` in `src/backlog/index.ts`: review item.
