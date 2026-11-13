# Independent review of PR #126 (board watcher)

Reviewer: a separate agent on Opus, given only the goal, the acceptance criteria and the result.
Reviewed commit: 7193e6d. Date: 2026-11-13.
Verdict: 13 of 18 criteria pass, 4 fail (2, 7, 12, 16), CI green. The failures are gaps in comments, stated constants
and tests, not wrong behaviour. Criterion 18 (look for real defects) found four, listed below.

"Status" is what was done after the review. The fixes were merged with #126 (`7a636db`).

## Per criterion

| # | Criterion | Result | Evidence from the reviewer | Status |
|---|---|---|---|---|
| 1 | The probe runs and supports the header's numbers | PASS | Ran `node scripts/watch-probe.mjs` on two volumes: 0 of 200 missed on each, first event 11.5 to 12.4 ms median, 25.2 ms worst. The probe does not produce the audit cost or the run-silence figures | Header now says which figures come from the probe and which from the runs' trace files; worst case stated as "about 20 ms" |
| 2 | The silence constant is justified by a measurement | FAIL | The 30 s is chosen to match the run page's `tickMs`, yet the comment said "Measured" | Fixed: header and constant now say "chosen", with the reason. Settable with `SDLC_BOARD_SILENCE_MS` |
| 3 | Real file-system tests: rename, removed folder, missing folder | PASS (weak) | The rename and removed-folder tests also accepted a rebuild from the audit, so a deaf watcher would pass them | Rename test now accepts only the watcher (silence set to 60 s). The removed-folder test still accepts either, because on Linux the watcher dies with the folder |
| 4 | A new run's folder gets watched | PASS | `board-watch.test.ts:110`, and the view test names a folder that does not exist yet | |
| 5 | `web/server/watch.ts`, `web/ui`, `package.json` unchanged | PASS | The diff for those paths is empty | |
| 6 | Each stated transition has a test that fails when it is wrong | PASS | Mutations M1 to M3, M8, M11, M12, M16 caught. Untested: a re-attach that fails after a good start | Tests added for a failed attach, and for one that recovers |
| 7 | Every constant has a name, unit and source | FAIL | `debounceMs` had no source; `silenceMs` was labelled "Measured" | Fixed: each constant says chosen or required, and why |
| 8 | Worst-case staleness per state proven on a fake clock | PASS | Debounce, deaf watcher and fallback each tested | |
| 9 | No audit while events keep coming | PASS | Test at `:65`, mutation M4 caught. A fingerprint is still taken at each rebuild, only not compared | By design: that is the baseline for the next audit |
| 10 | Tenth failure in a row enters fallback; a clean audit resets | PASS | Tests at `:152` and `:142`; M1, M2, M8 caught | |
| 11 | A trace line per transition and per audit | PASS (gap) | No line when watchers are attached again | Fixed: `board-watch:attach`, plus `board-watch:error` and `board-watch:check retry` |
| 12 | No real-timer wait over 200 ms for the long periods | FAIL (minor) | One test waited 450 ms on a real timer | Fixed: the wait is removed |
| 13 | Mutation check | PASS | 14 of 17 caught (table below) | Tests added for two of the three survivors |
| 14 | The watcher tests run in under 10 s | PASS | 17 tests in 1.30 s | |
| 15 | CI on #126 | PASS | `check` on Node 18, 20, 22, 24; `e2e` on 20, 22; `lint` | Passed again after the fixes |
| 16 | The header can be read without other context | FAIL | Undefined: "the host", "a run said to be going still is", "the run page's safety tick", "two volumes", where two figures come from; "audit/waiting/failure" listed as states though the type has two | Fixed: header rewritten with the words defined, two states and the steps within watching |
| 17 | The plan says what this replaces | PASS | Section 13 heading and the status table | |
| 18 | Real defects | 4 found | See below | |

## Mutations (criterion 13)

| Mutation | Result |
|---|---|
| M1 remove the failure reset | caught |
| M2 `>=` to `>` on the failure limit | caught |
| M3 skip re-attach on failure | caught |
| M4 compare the fingerprint on every event | caught |
| M5 drop the awaited-name filter | caught |
| M6 drop the ignore filter | caught |
| M7 an event does not reset the silence timer | caught |
| M8 fallback leaves watchers attached | caught |
| M9 an error does not rebuild | caught |
| M10 fingerprint taken after the build | **survived**. Test added: a change made during a build is found at the next audit |
| M11 no re-attach when the folders change | caught |
| M12 an audit that finds a missed change does not rebuild | caught |
| M13 `close()` leaves the silence timer | **survived**, harmless: the audit checks `closed` first. No test added |
| M14 `baseline()` does nothing | **survived**. Test added: after `baseline()` the next audit finds nothing |
| M15 no trace line on audit | caught |
| M16 an awaited name does not trigger a re-attach | caught |
| M17 a fallback check never rebuilds | caught |

## Defects (criterion 18)

1. **A change made during a rebuild could be missed.** The order was fingerprint, build, attach. A write into a folder
   that had just appeared, made after the fingerprint and before the attach, was not reported: it showed only at the
   next event or at the audit up to 30 s later, and was counted as a failure. The window was the whole build time.
   - Fixed: the watchers are attached before the fingerprint is taken and the board built.
2. **Changes to `sdlc.config.json` were never reported by the watcher.** The file was in the fingerprint, but its
   folder (the project root) was not watched, so each edit was found by the audit and counted as a failure.
   - Fixed: the project folder is watched for that one file; everything else in it is ignored.
3. **Ten failures in a row could all happen in one call.** A failed attach called itself again with no delay, so one
   brief error (too many open files) put the process in fallback for good.
   - Fixed: a failed attach is tried again after 5 s, comparing the fingerprint first; each failed try is one
     failure, so the fallback is reached after about 50 s.
4. **Host calls ran inside timers with no try/catch.** The old 2 s tick caught exceptions; the new timer callbacks did
   not, so an exception from reading settings would have ended the server. The reviewer could not make it throw, so
   this was a risk, not a confirmed bug.
   - Fixed: every timer and watcher callback is guarded; the error goes to the trace and the next audit still comes.
5. **Small cost and wording points.**
   - An idle audit goes through `mainTree`, whose kept answer lasts 60 s, so an idle board likely runs
     `git worktree list` about once a minute. "0 git calls" was measured over one 60 s window.
     Status: the plan's table now says so. Not changed in code.
   - Each rebuild computes the board's inputs two or three times. Status: left as is (about 1 ms each); noted here.
   - A stale comment "How often the live board is read… (default 2000)" was still above `pollMs`. Status: removed.
6. **No leaks found.** `close()` clears every timer and closes the watchers; the feed closes the watch; the server's
   `close()` drops the pull request listener.

## Still open after the fixes

- The removed-folder test still passes with a deaf watcher (by necessity on Linux).
- M13 has no test (harmless).
- The board's inputs are computed more than once per rebuild.
- Linux behaviour is only exercised in CI; Windows is untested.
