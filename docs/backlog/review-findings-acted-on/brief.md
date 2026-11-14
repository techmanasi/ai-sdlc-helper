# review-findings-acted-on

Type: improvement
Priority: P2 (medium)
Source: User, after the board-quiet-time-setting UI run (2026-11-15): "What if the review agent finds any issues in the code? How is that issue handled?" Answer: only the fixes it makes itself count; everything it writes down is ignored.

## Problem
The Review agent (`reviewStage`, `src/pipeline/stages.ts`, prompt `assets/prompts/prompt-review.md`) fixes problems in source files itself and writes a summary to `review-1.md`. It may not change tests. The prompt asks it to record some issues "as a blocker in review-1.md", but no code reads `review-1.md`. So:
- A blocker does not stop or pause the run; Finalise still commits, pushes and marks the PR ready.
- A gap that needs a test (Review cannot write tests) is only a note. In the board-quiet-time-setting run, Review wrote "the UI has no automated test … not a blocker", and a real UI bug (non-numeric input quietly resets the value to 30 s instead of being refused) shipped in PR #146.
- The run page shows "done" and never shows the findings.

## Goal
Every Review finding either gets fixed by the pipeline or stops the run in front of the user. Nothing found by Review is lost in a file nobody opens.

## Idea
- Review also writes a small machine-readable verdict next to `review-1.md`, for example `review.json` with `blockers` and `needsTests` lists (each with file, criterion and one-line reason).
- `needsTests`: go back to Red tests with the findings as input (the only stage allowed to write tests), then Implement, then Review again.
- `blockers` Review could not fix: send them back to Implement with the findings as input, then Review again.
- At most one or two such loops; after that the run stops with "needs you" and lists the open findings.
- The run page shows Review's findings and what happened to each.
- A missing or unreadable verdict is an error, logged to `errors.log` and shown in the run output, not treated as "no findings".

## Acceptance criteria
- A Review verdict with a blocker sends the run back to Implement with that blocker in the prompt, and the run does not reach Finalise until Review reports none (test with a fake agent).
- A verdict with a missing test sends the run back to Red tests with that finding in the prompt.
- After the loop limit, the run stops with a "needs you" state naming each open finding.
- A verdict file that is missing or not valid JSON stops the run with a logged error.
- The run page lists the findings for a run that has them.

## Out of scope
- Human PR review comments (already fed to the next agent by `prCommentsInput`).
- Checking Review's own code changes in CI (`ci-after-review-changes`).

## Docs
- `docs/` pipeline description: what Review may change and how its findings are handled.
