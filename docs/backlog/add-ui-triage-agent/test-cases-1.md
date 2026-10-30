# Test cases: add-ui-triage-agent

Sources: `specs-1.md` (§9 criteria numbered here as AC), `plan-1.md`. Tests are red until the feature exists.
Files: `test/triage-run.test.ts` (engine helpers, mirrors `src/triage.ts`), `web/test/triage.test.ts` (routes, mirrors `web/server/triage.ts`). A stand-in `claude` (a node script passed as `ServerOptions.claude`) writes the files a real agent would and prints stream-json.

## Matrix

| # | AC | Case | File / test group |
|---|---|---|---|
| 1 | 1 | Valid `items.json` parses in file order; `[]` valid | triage-run / parseTriageItems |
| 2 | 1 | Missing, not JSON, wrong shape, bad slug, duplicate slug each rejected, message names file and problem | triage-run / parseTriageItems |
| 3 | 2 | Draft has brief text, type, priority, title after `Bug:`/`Feature:` (case-insensitive) | triage-run / buildTriageDraft |
| 4 | 2 | Bad `Type:`, missing brief, no index line rejected naming slug/file | triage-run / buildTriageDraft |
| 5 | 3 | Unanswered questions detected; missing file → none | triage-run / triage questions |
| 6 | 3 | Missing/blank answer, bad id, unknown question → throws, file unchanged | triage-run / triage questions |
| 7 | 3 | After answering ("accept" kept as written) none remain | triage-run / triage questions |
| 8 | 4 | Split/item prompts hold report + skill; quick item prompt headless, interactive not | triage-run / prompts |
| 9 | 8 | `newRunId` safe charset, format, varies; `triageRunDir` | triage-run / newRunId |
| 10 | 9, 10 | `createTriageWorktree`: path, branch, copies config/index/briefs only, no commit; remove deletes both | triage-run / createTriageWorktree |
| 11 | 7 | No commit → start's text, nothing left | triage-run / createTriageWorktree |
| 12 | 7 | Existing folder/branch refused untouched | triage-run / createTriageWorktree |
| 13 | – | `parseStreamLine`: session id, text, tool summary; thinking/non-JSON ignored | triage-run / parseStreamLine |
| 14 | – | Package entry exports the new helpers and `alive`, `killTree` | triage-run / newRunId |
| 15 | 5 | Empty/whitespace report 400, unknown project 404, nothing created | web / POST /triage bad input |
| 16 | 6 | Second run → 409 with message | web / POST /triage bad input |
| 17 | 7 | No-commit repo → 400, nothing left, later POST not 409 | web / POST /triage bad input |
| 18 | 8 | Happy path event order, choosing, subset in `items.json` order, drafts, `done 0`, ready, stream closes | web / interactive run |
| 19 | 8 | `items` 400/404/409 cases change nothing | web / interactive run |
| 20 | 9 | Worktree, branch, run folder files, pointer, nothing committed | web / interactive run |
| 21 | 10 | Worktree has uncommitted config, index, briefs, and nothing else | web / interactive run |
| 22 | 5.2 | claude flags (stream-json, acceptEdits, allowedTools), `--model` passthrough | web / interactive run |
| 23 | 11 | Question → waiting, no draft; answer 400/404; resume with `--resume`; draft on same stream; 409 when not waiting | web / questions |
| 24 | 12 | Quick: no choosing, no question events, all drafts | web / questions |
| 25 | 13 | Zero proposed / zero kept → `done 0`, worktree+branch+pointer removed | web / finishing without drafts |
| 26 | 14 | saved/skip while later items run; 409 repeats; 404 unknown; all marked → done and cleaned | web / saved and skipped drafts |
| 27 | 15 | Events replay (incl. done) then live; two viewers; unknown runId 404; `GET /triage` null | web / reconnecting |
| 28 | 20 | Aborting client stream keeps the agent running; events stored | web / reconnecting |
| 29 | 16 | Stop kills process, `done 130`, worktree kept; other states 409 with message | web / stop, resume and discard |
| 30 | 17 | Resume from stopped uses `--resume`; running/ready → 409; failed resume finishes | web / stop…, session failures |
| 31 | 18 | Discard from any state, kills process, removes all, runId then 404, new run allowed | web / stop, resume and discard |
| 32 | 19 | Missing claude 127; non-zero exit; bad/missing items.json code 1; missing brief stops later items, earlier drafts markable | web / session failures |
| 33 | 21 | Restart: dead-pid running → interrupted; waiting stays; stale pointer dropped | web / server restart |
| 34 | 22 | All routes 401 without token | web / authentication |

## Review items (no test)

- AC 23–25 (manual UI verification in `web/ui`): enabled button, drawer, Load into form with replace prompt, P0 option, `mapPriority` fallback note, reopen on refresh, Stop/Resume/Discard confirm. `mapPriority` is exported from a React file; add a unit test in a later stage if `web/ui` gets a test setup.
- Prompt wording of `assets/prompts/triage-*.md` and the docs (`docs/web-ui.md`, Roadmap): checked in Review.
- Spec §5.8 ambiguity: whether a `GET /triage/events` replay that already contains a `done` stays open until the next `done`. Tests accept either (they abort the stream after seeing the replay).
- Plan §3.7 for `/saved` and `/skip` on a `done` run returns 404 (pointer is gone), though the spec table says 409; tests assert 404 after clean-up.
- Out of scope for tests: the 15 s SSE ping, SIGKILL after 5 s, `close()` killing children.
