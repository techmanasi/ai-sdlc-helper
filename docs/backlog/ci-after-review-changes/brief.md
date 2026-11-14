# ci-after-review-changes

Type: bug
Priority: P1 (high)
Source: User, after the board-quiet-time-setting UI run (2026-11-15): "Done before the last commit is tested … how did the review comments get fixed?"

## Problem
With `tests.fullSuite: "ci"`, only Implement waits for the full suite in CI. Review may then change source files. After Review, `successCheck` (`src/pipeline/gates.ts`) runs only the task's own test files and lint locally. Finalise (`src/pipeline/stages.ts`) commits Review's change, pushes, and marks the draft PR ready without waiting for CI. The run then reports "done" (exit 0) while CI on the final commit is still pending, and the run page keeps showing "CI green" from the earlier commit.

In the board-quiet-time-setting run, Review changed `web/server/index.ts` (commit `b2538e9`). The run said done at 00:22 with CI on `b2538e9` pending; it went green later, but nothing in the run checked it.

## Goal
A run never reports done for code the full suite has not passed, and the CI status on the run page belongs to the PR's current head.

## Idea
- When Review (or any stage after Implement) changes a source file and the full suite runs in CI, Finalise waits for CI on the new head, the same way Implement does.
- CI green: finish as today. CI red: stop with the CI failure, offering Resume at Implement, which already reads CI failures as input.
- Review changed nothing: the earlier green result still holds; no wait.
- The run page's CI badge names the commit it belongs to and turns "pending" when the head moves.

## Acceptance criteria
- A run whose Review changes a source file does not reach done until CI on that commit is green (test with a fake CI).
- A red CI after Review stops the run with the failing checks and a Resume at Implement option.
- A run whose Review changes nothing does not wait for CI again.
- After the head changes, the run page does not show the previous commit's CI result as current.

## Out of scope
- Acting on Review's written findings (`review-findings-acted-on`).
- Runs with `tests.fullSuite` other than `"ci"` (the full suite already runs locally there).

## Docs
- `docs/` pipeline description: when CI is waited for.
