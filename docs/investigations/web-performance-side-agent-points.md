# Web performance work: points raised by side agents (2026-11-13)

Notes from the work in `docs/plans/web-performance.md` (#117 to #128).

Each point is as the side agent raised it, followed by what was done about it.

1. **Graft hooks ran twice per action** (about 3.4 s added to every edit); `/doctor` did not fix it.
   - Done: the global copies were removed from `~/.claude/settings.json` (a backup was kept beside it). The project's own hooks remain.

2. **P0 was being built before plan #115 was merged**, with two decisions still open and `gitTop` dropped.
   - Done: #115 was merged first, the decisions were recorded in the plan (section 12), then P0 (#117) merged.

3. **The two stream choices overlap.** With hidden tabs closing their connection, "one connection per browser" buys little except correct titles in hidden tabs.
   - Open: your decision. My recommendation is to drop "one connection per browser".

4. **The performance PRs were stacked**, so they had to be merged in order or code would land in another PR's branch.
   - This happened once: #122 was merged into the P7 branch. #123 replaced it. Later PRs were branched from `main`.

5. **The three-tab test showed no saving from #121**, because hidden tabs already drop their connection.
   - Done: re-measured with three visible windows: 197 git calls / 111 builds a minute before, 84 / 39 after, 26 / 39 with P3.

6. **File watching cannot see a crashed run or a changed PR status**, so a timer you had not asked for was being added, and the silence check was set to 30 s, not the 2 minutes you named.
   - Done: there is no separate timer. A dead run is looked for at the watcher's quiet moment, only while a run is going. PR status is re-asked from the same quiet moment once the poll interval (1 hour) has passed, and the board is rebuilt when GitHub answers.
   - Confirmed by the user on 2026-11-13: 30 s stays as a setting to tune (`SDLC_BOARD_SILENCE_MS`); liveness at the quiet moment; the pull request status went to a file (#127).

## Added after the board watcher (points from the reviewer and the Sonnet agents)

7. **Independent review of #126 (Opus):** 13 of 18 criteria passed; four real defects found and fixed before merge. Full list: `web-performance-review-pr-126.md` in this folder.
8. **Sonnet, pull request status file:** no problem with the plan. Noted that `onPrStatusChange` is now used only by a test.
9. **Sonnet, measurements:** on a cold start a second board rebuild follows the first at once, probably from the status file being written (not confirmed). The run page's watcher sees the status writer's temp file as an extra event (12 in two minutes); possibly only in the simulation.
10. **Sonnet, finished-run counts:** stopped at a check in the plan (`commonDirOf` is not cached) and asked; it is a few file reads, so it went ahead. The median rebuild did not fall (19 to 23 ms); the gain is 64 to 20 git calls and the longest rebuild 276 to 69 ms. Git's own `status` can refresh the index during the first build, which causes one extra re-read.
