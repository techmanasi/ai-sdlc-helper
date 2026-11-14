# review-findings-acted-on

Type: improvement
Priority: P1 (high): must-fix item 2 in `docs/must-fix.md`
Source: User, after the board-quiet-time-setting UI run (2026-11-15): "What if the review agent finds any issues in the code? How is that issue handled?" Answer: only the fixes it makes itself count; everything it writes down is ignored.

## Problem
Today the Review agent (`reviewStage`, `src/pipeline/stages.ts`, prompt `assets/prompts/prompt-review.md`) fixes problems in source files itself and writes a summary to `review-1.md`. It may not change tests. The prompt asks it to record some issues "as a blocker in review-1.md", but no code reads `review-1.md`. So:
- A blocker does not stop or pause the run; Finalise still commits, pushes and marks the PR ready.
- A gap that needs a test (Review cannot write tests) is only a note. In the board-quiet-time-setting run, Review wrote "the UI has no automated test … not a blocker", and a real UI bug (non-numeric input quietly resets the value to 30 s instead of being refused) shipped in PR #146.
- The run page shows "done" and never shows the findings.

## Goal
Every Review finding either gets fixed by the pipeline (through Red tests and Implement) or stops the run in front of the user. Nothing found by Review is lost in a file nobody opens.

## Decisions (user, 2026-11-15)
- **Review reports only.** It may not change source or tests; every fix goes through Red tests or Implement, so every change is tested. The Review prompt and the stage enforce this: a Review that leaves changes in the tree is an error, logged and shown, and the changes are not committed.
- **Machine-readable verdict.** Review writes `review.json` next to `review-1.md`: `verdict` (`pass` or `changes`), `blockers` and `missingTests`, each item with file, criterion and a one-line reason. A missing or unreadable verdict is an error, logged to `errors.log` and shown in the run output, never "no findings".
- **Always back to Red tests.** Any finding, blocker or missing test, sends the run back to Red tests with the findings as input: Red tests writes a failing test for each, then Implement, then Review again. A finding whose test already passes before Implement is a wrong finding, reported as such (the red gate's rule).
- **Loop limit is a setting,** `review.maxLoops` in `sdlc.config.json`, default 2. Setting it in the web UI is a separate item, `review-loop-limit-ui-setting`.
- **At the limit the run fails.** Open findings after the last loop are a blocker: the run stops as failed, "needs you", listing each open finding, with resume actions. It never finishes with the findings only noted in the PR.
- **Single or multi-model review, chosen by the user.** Single: one Review agent. Multi: several Review agents on different models (no model used twice), plus a summariser agent on its own model that merges their findings into the one `review.json`, keeping a finding only one reviewer made and noting where they disagree. The choice and the models are settings (Run options and `sdlc.config.json`).

## Acceptance criteria
- A Review verdict with a blocker or a missing test sends the run back to Red tests with that finding in the prompt, then Implement, then Review; the run does not reach Finalise until Review reports `pass` (test with a fake agent).
- A Review that changes a file is an error: logged, shown in the run output, and the change is not committed.
- After `review.maxLoops` loops with open findings, the run stops as failed with "needs you", naming each open finding.
- A verdict file that is missing or not valid JSON stops the run with a logged error.
- Multi-model review: each reviewer runs on a different model, and the summariser's `review.json` holds every finding any reviewer made (test with fake agents).
- The run page lists the findings for each Review round and what happened to each.

## Out of scope
- Human PR review comments (already fed to the next agent by `prCommentsInput`).
- Checking Review's own code changes in CI (`ci-after-review-changes`).

## Docs
- `docs/` pipeline description: what Review may change and how its findings are handled.
