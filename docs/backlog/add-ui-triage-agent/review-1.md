# Review 1: add-ui-triage-agent

Diff reviewed: `git diff 54f1656` against `specs-1.md`.

## Blockers

None.
- No test reads or asserts on documentation text. `test/triage-run.test.ts` checks the output of `triageSplitPrompt` /
  `triageItemPrompt` (code output) and writes fixture backlog files; `web/test/triage.test.ts` drives the real server with
  a stand-in `claude`.
- Everything `docs/web-ui.md` describes has code: `src/triage.ts`, `web/server/triage.ts`, `web/server/index.ts`,
  `web/ui/src/api.ts`, `web/ui/src/NewItem.tsx`, and the prompt texts in `assets/prompts/triage-*.md`.

## Fixed in this review

1. **Resume retried the wrong item** (`web/server/triage.ts`, `startItem`). If building an item's prompt failed (for
   example the triage skill or `report.md` became unreadable), the run went `failed` with `current` still naming the
   item drafted before it. Resume then continued that finished session, re-emitted its draft and reset its status to
   `pending`, even if it was already saved. `current` is now set before anything can fail.
2. **Item session ids read through the prototype** (`web/server/triage.ts`). `run.sessions.items[slug]` for the valid
   slug `constructor` returned `Object`'s constructor when no id was recorded, so Answer and Resume passed a function to
   `--resume` and the spawn threw. Lookups now use an own-property check (`itemSession`), like `hasDraft`.
3. **An empty `Type:` or `Priority:` line took the next line** (`src/triage.ts`, `buildTriageDraft`). `\s*` crossed the
   newline, so `Priority:` followed by `## Summary` gave the priority `## Summary`. The patterns now use `[ \t]*`.

Earlier fixes already in the diff (own-property `hasDraft`, live `choosing`/`waiting` in the drawer, Resume not doubling
the log, drawer statuses after Save, zero kept items returning `done`, Stop/Discard of an agent that outlived the server,
clearing ended sessions so a reused pid is never signalled, `finishDone` idempotent under racing marks, answers with no
session id) were re-checked and hold.

## Acceptance criteria coverage

- 1–4: `test/triage-run.test.ts` (the spec names `test/triage.test.ts`).
- 5–22: `web/test/triage.test.ts` (the spec names `web/test/server.test.ts`), real server and stand-in `claude`.
- 23–25: manual, not run.

Gaps (not blockers):
- AC 17: Resume is tested from `stopped` and `failed`, not from `interrupted`.
- §6: the 400 for a missing triage prompt has no server test; fixes 1–3 above have no test.
- §6 check order: `/triage/answer` returns 409 (not waiting) before 400 (unanswered), since the 400 needs the run's file.
  Saved/skip on a `done` run return 404 (its pointer is gone), not 409.
- §5.8: a `GET /triage/events` stream on a `ready`/`stopped`/`failed` run replays the earlier `done` and stays open, so it
  sees events after a Resume. This follows §5.7 but not "streams close after a `done`"; the two rules conflict on replay.
- After a restart, a run whose recorded agent is still alive stays `running` with no session tracking its exit; Stop
  (which kills the recorded pid) then Resume recovers it.

## Verification

`ai-sdlc-helper run --file test/triage-run.test.ts`: 31 passed. `ai-sdlc-helper run --file web/test/triage.test.ts`:
29 passed. `npm run check` (lint, typecheck, full suite) was not run here and must be run before commit.
