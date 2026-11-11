# stop-implement-on-test-defect

Type: improvement
Priority: P2 (medium)
Source: `docs/pipeline-edge-cases.md`, entries 1 and 3 (seen on `ci-full-suite-gate`, 2026-11-11).

## Problem
Tests are locked before Implement and a guard stops the run if Implement edits them. When a locked test has a defect (an unused import, a `no-restricted-imports` violation), Implement cannot fix it. Observed on `ci-full-suite-gate`:
- Attempt 1 fails on `LINT:` lines that point into `test/` and `web/test/`; the agent writes `test-issues.md` ("agent claimed test defect").
- Attempt 2 changes 0 files and ends with the same blockers; the run keeps going until the attempt limit.
- The run page keeps offering Implement. Nothing tells the user to resume at Test repair; the only hint is a `WARNING` in `run.out` when `test-issues.md` already exists at resume.

## Expected behaviour
1. After an Implement round that wrote `test-issues.md` is followed by a round that changed no files and left the same failing checks, the stage stops without spending the remaining attempts.
2. The stop report is in plain language: which test files have the defect, why Implement cannot fix them, and that the next step is Test repair.
3. The run page shows **Resume at Test repair** as the suggested button for that stop.
4. A stop for any other reason is unchanged.

## Decisions
- Reuse the existing "same failing checks as the previous attempt" comparison (`repeatedFailures` in `src/pipeline/stages.ts`) and the `test-issues.md` marker; add no new state.
- The stop is a normal stop with a reason, not a failure of the run's record.
- Do not let Implement edit locked tests.

## Scope
- In: `src/pipeline/stages.ts` (Implement loop), the stop report text, the suggested button in `web/ui/src/Run.tsx` and the view data in `src/runs/view.ts`, tests.
- Out of scope: Test repair itself; the `empty answer` warning (separate edge case, entry 2); the `EPERM` cache failure (entry 4).

## Tests
- A fake agent that writes `test-issues.md` in round 1 and changes nothing in round 2: the stage stops after round 2 with the Test repair reason, not after the last attempt.
- A fake agent that changes files in round 2: the loop continues as before.
- A fake agent with no `test-issues.md`: unchanged behaviour.
- The view reports the Test repair suggestion for the stopped run.
- Every case runs the real code.

## Docs
- Mark entry 1 in `docs/pipeline-edge-cases.md` fixed, with the PR.
