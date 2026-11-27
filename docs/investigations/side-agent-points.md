# Points raised by side agents: branch moves, reviews and must-fix work (#130 to #158)

Notes written between 2026-11-14 and 2026-11-23. Each point is as the side agent raised it, followed by what was done
about it. Points 1 to 10 are in `web-performance-side-agent-points.md` in this folder.

"Open" describes the date the point was written. Lines marked "Rechecked 2026-11-27" were compared with `main` on that
day; every other open point has not been rechecked.

## Added during the branch-move work (#130 to #132)

11. **Side agent, on the `ui-code-indexer-setup` run:** #130 alone may not stop that run from testing locally. A resume at Review now asks for CI, but a refused push still falls back to the local suite; the cure is the branch move (#132).
    - Resolved: #132 merged (813b4d0). The run itself was parked.
12. **Independent review of #132 at 62fc82c (Opus):** do not merge as is; 11 defects, the worst being that "Fix with Implement" would move to a new pull request. The full list (`review-findings-pr-132.md`) was not committed.
    - Done: redesigned as a push check after Plan, merged as #132 (813b4d0); follow-up fixes in #135.
13. **Sonnet fix agent for #132:** stopped by the spend limit after the first two fixes and part of the third (branch names `<slug>_<n>`); its uncommitted work was handed to the Opus agent.

## Added 2026-11-14 (PR #135, merged as 851a137)
14. #135 review (Sonnet): D1–D4 fixed in 350f372. Not fixed: D5 `resume_from` parsed from the stop message text (better as a typed field); D6 `appendRound` errors.log folder not checked for every caller. The details file (`review-findings-pr-135.md`) was not committed.
   - Rechecked 2026-11-27: D5 is fixed (#143): the resume stage comes from a typed field. D6 not rechecked.
15. #135 test gaps left: mutation M8 (stop path skips `abortAll`) may still survive; no test for "old branch can't be checked out again after a stash conflict" (changes stay only in the stash; output says so); M1/M1b each guarded twice so neither alone is tested.
16. #135 agent open points: the resolved new branch isn't checked locally before push; the main checkout's brief is edited, not committed; `createPrForCompleted` unchanged; `nextRunBranch` treats an `ls-remote` failure as "no names on origin"; "cannot lock ref" re-diagnosed only once.
   - Rechecked 2026-11-27: the `ls-remote` point is fixed (#143): the run stops with an error when origin cannot be asked. The other points were not rechecked.
17. Flaky: `test/step-progress.test.ts` "a write carrying the step takes well under a millisecond" failed on CI check (22) at 1.08 ms vs 1 ms; passed on re-run. The 1 ms limit is too tight for shared runners.
   - Rechecked 2026-11-27: #143 loosened the limit, then #152 changed the test to measure CPU time instead of wall-clock time.
18. #136 (merged 9bd73d5) open points: board/completed-list cleanup messages go to stderr only (no run output); run page alone never triggers cleanup; board path untested on its own; a whitespace-only edit at the brief's start/end counts as "link only" and is restored away.
19. #137 (Completed board speed) open points: Create PR clears every cached PR status, so the next Completed load is fully cold (pipeline code, left); the detail panel request still makes 4 blocking git calls; on repos with many PRs, older PRs outside `gh pr list` are looked up one by one, and on a slow gh the list can wait up to 18 s; F1–F3 not checked by the reviewer (needs a browser); `test/pr-status.test.ts` timed out twice locally under parallel load (passed alone); step-progress 1 ms test failed again on CI check (24) at 1.0028 ms.
20. #138 (merged a84f231) open points: close() mid-warm-up doesn't stop a running gh call; GitHub detection matches "github" in the origin URL (Enterprise hosts without it are skipped); cold-load settle ~0.1 s slower than #137 (extra round trip); warm-up runs one gh pr view per branch-keyed task (4 at a time) at each start; untested: component's two-request wiring, close mid-warm-up, missing-gh skip, the stderr line.

## Added 2026-11-14 (the 26-note loop: #142, #143, #144, #145)
21. #145 (merged b02a514) open points: the comment on `askPrStatuses` in `src/runs/completed.ts` still says "one `gh pr list`"; `scripts/completed-probe.mjs`'s fake gh only answers `gh pr list`, so the probe fails until it also answers `gh api graphql`; a PR-status refresh already running when a PR is forgotten can still write its old answer afterwards (existed before); the new rule `PAGE_COST_IN_VIEW_ROUNDS` reads another page only if it could fill 16+ links (page 3.4–3.9 s vs one view 0.73–0.79 s, measured); `graft build` not run.
   - Rechecked 2026-11-27: by reading the code, the comment on `askPrStatuses` still names only `gh pr list`, and the probe's fake gh still answers no `gh api graphql` call. The probe was not run.
22. #145 CI first run: 8 failures in `web/test/completed-speed.test.ts` because its fake gh knew only `gh pr list`; the agent hadn't run that file. Fixed in the test's fake gh only.
23. #144 CI first run: one failure in `web/test/completed-speed.test.ts` (an exact-equality check saw the new `notices` field). Fixed by comparing the rows and checking the notices.
24. `test/pr-status.test.ts` "cold read" timed out once more under local parallel load (passed alone), as in point 19.

## Added 2026-11-15 (must-fix fixes: #149 to #156)
25. #151 (red gate): the existing-test check matched any word suffix of a title; fixed to quote-bounded titles before merge.
26. #155 (merged 0d13db6) judgment calls: stopping an agent (abort or time-out) now kills its whole process tree, not just the agent (Windows unchanged: the agent only). The old test "supervisor that died … shows as stopped" now expects interrupted plus the message. Open: no web-server test for the 30 s gone-run sweep.
   - Rechecked 2026-11-27: a name search of the tests for "sweep" found nothing.
27. #156 (merged e32920a) judgment calls: with no worktree, the files are committed through a temporary detached worktree of `origin/<branch>` and pushed there, so the local branch is not updated (readers try `origin/<branch>` first); a run done in the main checkout counts as having no worktree; branch reads are cached until the ref files change; a sync whose save failed still returns `ok: true` with `err` lines.
28. #156 open points: while origin can't be reached, every sync retries the push and reports the failure again; with no worktree, the CI failure report reaches only origin's branch, and whether "Restart Implement with the CI failure" picks it up from there was not checked.

## Added 2026-11-23 (PR #158, branch sync, after the rebase onto main)
29. **Review's fix rounds skip the branch sync.** After the rebase, Review comes from #165's redesign: when it finds problems it runs Red tests, Implement and Review again inside its own loop. The sync ran once before the whole loop, so a push to GitHub during a fix round (for example to the locked tests) would not be seen.
    - Done in #158: new setting `review.syncEachRound` (default on; env `SDLC_REVIEW_SYNC_ROUNDS=0/1`; a checkbox in the run's Review settings) syncs before each fix round's Red tests and Implement and before each later Review round.
    - Decided 2026-11-23: someone else's commits on GitHub are never brought into a running task. The sync moves the run to a new `<branch>_<n>` from its own tip (uncommitted changes go along); the old branch and its PR keep their commits. Only commits by the run's own git user (same email) are fast-forwarded or rebased in. To use others' changes, stop the pipeline and make them yourself; extra context goes in the run page's note boxes. With SDLC_MOVE_BRANCH=0 the run stops instead. This also settles the author-check question.
   - Rechecked 2026-11-27: #158 is merged; the setting, its checkbox on the run page and tests for it are on `main`. The tests were not rerun for this note.
