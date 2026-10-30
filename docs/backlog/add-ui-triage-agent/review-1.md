# Review 1: add-ui-triage-agent

Diff reviewed: `git diff 54f1656` against `specs-1.md`.

## Blockers

None. No test reads or asserts on documentation text. The prompt tests in `test/triage-run.test.ts` check the output of
`triageSplitPrompt` / `triageItemPrompt`, which is code output, not docs. Everything `docs/web-ui.md` describes is
implemented in `src/triage.ts`, `web/server/triage.ts`, `web/ui/src/api.ts` and `web/ui/src/NewItem.tsx`.

## Fixed in this review

1. **Slugs that are `Object.prototype` keys** (`web/server/triage.ts`). Draft lookups used `slug in run.drafts`, so a
   valid slug such as `constructor` or `tostring` counted as already drafted. `nextItem` skipped it, `allMarked` treated
   it as marked, and `saved`/`skip` on an unknown slug of that name returned 409 instead of 404. Lookups now use an
   own-property check (`hasDraft`).
2. **The drawer never showed the item choice or the questions during a live run** (`web/ui/src/NewItem.tsx`). The client
   state only changed on `done`, so after `items` / `question` it stayed `running`. The UI for `choosing` and `waiting`
   only appeared after a page reload. `items`, `question` and `draft` now re-read the run summary.
3. **Resume doubled the log** (`NewItem.tsx`). A stream already open on a stopped/failed run stayed attached, and the new
   events stream replayed everything into the same log. Resume now closes the old streams and rebuilds the log from the
   replay.
4. **Drawer statuses went stale after Save** (`NewItem.tsx`). Once the stream had closed on `ready`, a Save marked the
   draft on the server but the drawer still showed it as `pending` and still offered Load/Skip. The form's run summary is
   now passed to the drawer and its statuses are synced. Save also only calls `/triage/saved` for a draft that is still
   `pending`, so it no longer gets a 409 toast.
5. **Zero kept items returned the old summary** (`web/server/triage.ts`). It returned state `choosing`; it now returns
   `done`.
6. **An agent that outlived an earlier server could not be stopped** (`web/server/triage.ts`). If a run was `running`
   with a live recorded pid after a restart, there was no session object, so Stop and Discard killed nothing. They now
   kill the recorded pid.
7. Formatting: `const p =(` in `web/ui/src/api.ts`.
8. **Discard could signal a reused pid** (`web/server/triage.ts`). A session object stayed on the run after its agent
   exited, so Discard in `choosing`, `waiting` or `ready` sent SIGKILL to the old pid's process tree. If the system had
   reused that pid, an unrelated process was killed. A session is now cleared when its process closes or fails to start.
9. **Two marks racing could finish the run twice** (`web/server/triage.ts`). `saved`/`skip` await their `marked` event
   before checking `allMarked`. Two requests that mark the last two drafts could both see every draft marked, so each
   ran `finishDone`: two `done` events, and a second worktree, branch and pointer removal. `finishDone` now returns if the
   run is already `done`.
10. **Answers with no recorded session id** (`web/server/triage.ts`). If the item session never printed a `session_id`,
   `/triage/answer` started a new session with only the "questions answered" message, so the agent had no item prompt.
   The item's session now starts afresh from its full prompt followed by the "questions answered" message.

## Acceptance criteria coverage

- 1–4: `test/triage-run.test.ts` (the spec names `test/triage.test.ts`).
- 5–22: `web/test/triage.test.ts` (the spec names `web/test/server.test.ts`). All of them run the real server with a
  stand-in `claude`.
- 23–25: manual, not run.

Gaps (not blockers):
- AC 17: Resume is tested from `stopped` and `failed`, but not from `interrupted`.
- §6: the 400 for a missing triage prompt has no server test.
- §6 check order: `/triage/answer` checks 409 (not waiting) before 400 (unanswered), because the 400 check needs the
  run's file. This is reasonable, but it differs from the spec's 400 → 404 → 409 order.
- `docs/web-ui.md` names the branch `sdlc/triage-<runId>`. The code uses `<branchPrefix>triage-<runId>`, and `sdlc/` is
  only the default prefix.

- §5.8: a `GET /triage/events` stream on a `ready`, `stopped` or `failed` run replays the earlier `done` and stays open,
  so it receives the events after a Resume. This follows §5.7 ("replays ... then streams new events") but not the
  "streams close after a `done` event" rule of §5.8. The two rules conflict for a replayed `done`.
- Fixes 8–10 have no test: the pid-reuse and mark race depend on timing, and the stand-in `claude` always prints a session id.

## Verification

After the fixes: `ai-sdlc-helper run --file web/test/triage.test.ts`: 29 passed. `ai-sdlc-helper run --file test/triage-run.test.ts`:
31 passed. The full suite, lint and typecheck (`npm run check`) were not run here and must be run before commit.
