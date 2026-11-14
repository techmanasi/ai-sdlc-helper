# backend-driven-pipeline

Type: feature
Priority: P2 (normal)

## Problem
Some follow-up work only happens when someone opens a page. After a run's PR merges, the main checkout's brief still holds the PR link until `cleanMainBrief` (`src/pipeline/pr-link.ts`) takes it out. Today that cleanup is started from only these places (`graft callers cleanMainBrief`):
- Finalise, for the run that is finishing (`cleanMergedBrief` in `pr-link.ts`).
- The board view (`boardView` in `src/runs/view.ts`, via `cleanMergedRunBrief`).
- The Completed page (`completedTasks` / `completedListAsync` in `src/runs/completed.ts`, via `cleanMergedRunBrief`).

Someone who only opens the run page, or no page at all, never gets the cleanup. The same gap applies to questions: a question a run raises should reach the user, and be recorded, without the board being open.

The user's rule: "people can miss opening the board, the pipeline should be driven by the backend, not the frontend board", except where a user input or action is needed.

## Goal
With the server running, a merged PR's brief cleanup and a run's question both happen without any page being open. A page only shows what the server already did.

## Idea
- The server's PR-status refresh (the hourly re-ask) and the board watcher already notice when a PR becomes MERGED. When they do, they run `cleanMergedRunBrief` for that run, one brief at a time per repository (two checkouts fight over git's index lock).
- A question a run raises is surfaced by the server: a notification, plus a line on the run page, and recorded in the run's files so it is still there after a restart. It does not wait for the board to be open.
- Pages keep calling the same code as a safety net; it must stay safe to run twice.

## Acceptance criteria
- With no page open, a PR that turns MERGED has its link removed from the main checkout's brief after the next status refresh.
- Opening only the run page also leads to the cleanup.
- A run's question reaches the user (notification and run page) with no board open, and is recorded.
- Running the cleanup twice, or from two triggers at once, does the same as once.
- Failures go to `errors.log` and the run output, never swallowed.
- Tests for each trigger, using real code.

## Out of scope
- Anything that needs the user's input or action (approving a gate, answering the question itself).
- Running work when the server is not running.
- Changing how often GitHub is asked.

## Docs
-
