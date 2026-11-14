# pr-link-committed-not-main

Type: bug
Priority: P1 (high)
Source: User, after the board-quiet-time-setting UI run (2026-11-15): the main checkout showed `pr:` front matter in `docs/backlog/board-quiet-time-setting/brief.md` as an uncommitted change.

## Problem
The run's pull request link is written into `brief.md` in two places by `linkPrEverywhere` (`src/pipeline/pr-link.ts`):
- **The run's worktree.** When the draft PR opens (`checkCiAvailability` in `src/pipeline/ci.ts`, `openMovedPr` in `src/pipeline/branch-move.ts`), the link is written but not committed; it is swept into the next stage's commit (in this run, the `[implement]` commit `d6ceefa`). Only Finalise (`finalise` in `src/pipeline/finalise.ts`) commits and pushes it on its own ("link pull request").
- **The main checkout**, on purpose, so the board there can show the link. It is never committed there, and it is removed (`cleanMainBrief`) only after the PR is merged and only when someone opens the board. A PR that is closed, discarded or never merged leaves the main checkout dirty for good.
- When a run moves to a new branch (`recordMove`), the old link is cleared in the worktree without a commit, and the main checkout keeps the old link until the new PR opens.

## Goal
After a run, the PR link is committed and pushed on the run's branch, and the user's main checkout has no change the pipeline made.

## Idea
- Whenever a PR is opened or replaced, write the link into the worktree's brief and commit and push it right away as its own commit (`chore(<slug>): link pull request`), in every path: draft PR for CI (`checkCiAvailability`), new PR after a move or discard (`openMovedPr`, replacing the old link), and Finalise when the full suite runs locally.
- Stop writing into the main checkout. The board takes the link from the run record (`.git/sdlc-runs/<slug>.json`, `status.ci.pr`) or the pushed branch instead.
- The link reaches `main` with the PR when it merges, so `cleanMainBrief` is no longer needed for new runs; keep it for briefs written by older versions.

## Acceptance criteria
- Opening the draft PR at Red tests leaves a pushed commit on the branch whose only change is the `pr:` line, and the next stage's commit does not contain it (test with a fake `gh`).
- After a move to a new branch, the new branch has a pushed commit with the new link and no trace of the old one.
- With the full suite run locally, Finalise commits and pushes the link as today.
- At no point does a run change any file in the main checkout (test: main checkout's `git status --porcelain` is empty after a whole run with a fake agent).
- The board still shows the PR link for a running and a finished run.
- A failed commit or push of the link is logged to `errors.log` and shown in the run output.

## Out of scope
- Other pipeline writes to the main checkout, if any are found (list them in the PR).

## Docs
- `docs/web-ui.md`: where the board gets a run's PR link.
