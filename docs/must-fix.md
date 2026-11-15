# Must fix before customer handover

Found in the `board-quiet-time-setting` run, driven from the web UI with auto-accept on (2026-11-14/15, PR #146).
Each item is a case where the tool tells the user something untrue, or calls work finished when it is not checked.
Status as of 2026-11-15: six of seven fixed; item 2 is open.

| # | Problem | Seen in this run | Where | Backlog | Status |
|---|---|---|---|---|---|
| 1 | **"Done" before the last commit is tested.** With the full suite in CI, only Implement waits for CI. Review can change source after that; Finalise pushes and marks the PR ready without waiting, and the run page keeps the old "CI green". | Run exited 0 at 00:22 while CI on Review's commit `b2538e9` was pending. | `reviewStage` and Finalise in `src/pipeline/stages.ts`; `successCheck` in `src/pipeline/gates.ts` | `ci-after-review-changes` | Fixed, #149 |
| 2 | **Review's findings are never acted on.** Review may record blockers and missing tests in `review-1.md`, but no code reads that file, so the run finishes regardless. | Review noted "the UI has no automated test … not a blocker"; a UI bug (non-numeric input quietly resets the value to 30 s) shipped. | `assets/prompts/prompt-review.md`, `reviewStage` | `review-findings-acted-on` | Open: design agreed (see backlog brief) |
| 3 | **"Create PR: off" is ignored.** The draft PR opened so CI can run the full suite is marked ready for review at Finalise, and the output says "PR created". | Create PR was off; PR #146 was marked ready. | Finalise in `src/pipeline/stages.ts` | — | Fixed, #149 |
| 4 | **The pipeline writes into the user's main checkout.** It adds the `pr:` link to the item's `brief.md` in the main working tree, outside the run's worktree, leaving it modified. | `docs/backlog/board-quiet-time-setting/brief.md` modified on `main` at 23:57:49. | `linkPrEverywhere` in `src/pipeline/pr-link.ts` | `pr-link-committed-not-main` | Fixed, #153; Sync PR comments and the CI failure report are committed on the run's branch since #156 |
| 5 | **A failure is not always logged.** When an agent is killed, nothing goes to `errors.log`, the run file says `"interrupted": false`, and the message does not name the signal. | Spec agent killed (exit 143): message "crashed or failed: interrupted", no `errors.log`. | Agent runner and run supervisor | — | Fixed, #150; a supervisor killed with `kill -9` is closed as interrupted and its pipeline stops itself since #155 |
| 6 | **The red gate accepts a new test that already passes.** It only checks that some new test fails. | "environment quiet time takes precedence over the saved value" passed before Implement. | `redTestsStage` in `src/pipeline/stages.ts` | Note in `non-node-ecosystem-support` | Fixed, #151 |
| 7 | **Agents get an outdated `ai-sdlc-helper` CLI.** The globally installed CLI is older than the project, so agents cannot use it to check their work. | Review: the CLI refused `sdlc.config.json` (`tests.fullSuite`, `agent.stages` unknown). | Agent environment (`PATH`) | — | Fixed, #150 |

## Not yet confirmed
- The done page shows a red "not signed in" banner while it still loads data, and a "1 failed" count in the top bar. The cause is not investigated yet.

The remaining findings are in [good-to-have.md](good-to-have.md).
