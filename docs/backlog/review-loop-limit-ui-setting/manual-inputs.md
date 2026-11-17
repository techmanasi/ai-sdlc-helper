# Manual inputs (orchestrator, 2026-11-17)

The red gate found 9 new tests that already pass. That behaviour exists on the base branch (feat/ui-refresh) and is NOT part of this item:

- Saving, merging, clearing and refusing `review.maxLoops` through the existing project settings route and `src/config/settings.ts` (the `'integer'` rule, the stale-hash and bad-value 400s, default 2).
- Review stopping on a missing or invalid review.json, an unknown verdict, or "changes" without findings, and the multi-model union (`src/pipeline/review-gate.ts`, `test/review-gate.test.ts`).

What is new, and the only thing tests may target:

1. The project settings screen shows "Review loop limit" with its current value and the default 2, and saves or clears it through the existing route.
2. A per-run override `SDLC_REVIEW_MAX_LOOPS` in the run options environment: a whole number 0 or more wins over `sdlc.config.json` for that run only; anything else refuses the start with a message (400); empty means the project value.
3. 0 means no fix loop: the first Review with open findings fails the run as "needs you".
4. The run page names the run's effective limit.

## plan

Use the list above. Mark the existing behaviour as existing in the plan and plan no tests for it.

## red-tests

Follow the Tests section of plan-1.md. Write no test for the existing behaviour listed above; every new test must fail before implementation.

The uncommitted test changes in the worktree are from the previous Red tests attempt, which the red gate refused. Rework them:
- `test/config/review-loop-limit.test.ts`: delete "merges, persists, clears and resolves project values", "resolves run option as 1" and any other case that passes today. Keep only run-option cases that fail before implementation.
- Drop the `run option "" ... resolves to 1` case: an empty option already means the project value.
- Put new tests in NEW files, not in `test/review-gate.test.ts` or `web/test/server.test.ts`. Move the per-run override cases to `test/review-loop-override.test.ts` and the server cases to `web/test/review-loop-limit.test.ts`, reusing the existing helpers. Revert your edits to those two existing files. This run's red gate wrongly counts their existing `test.each` and escaped-quote titles as new (tool fix in PR #169).

Before finishing, run each new file and confirm every test in it fails.

Red tests for Review findings (fix loop): the code is implemented now, so each new test must fail against the current tree. Put them in a NEW file, `web/test/review-loop-limit-findings.test.ts`. Do not edit the committed `web/test/review-loop-limit.test.ts`: the red gate wrongly counts its existing `test.each` cases as new (PR #169). Revert the uncommitted edits to that file from the previous attempt. Write tests only for findings that are still open. Save, clear and invalid save of `review.maxLoops` through the settings route already work (listed above as existing), so write no test for those findings. The open ones are: clearing an invalid file value from the UI patch (the blocker), and the empty run option using the file value through the server API, if that test fails today.


## review

Refusing -1, 1.5 and abc for `review.maxLoops` through the settings route (AC4) and its error messages already exist on the base branch (feat/ui-refresh) and are covered there. Do not raise a finding for them.

CI on PR #170 fails `npm run typecheck` on all four Node jobs: `web/test/review-loop-limit-findings.test.ts(23,14): error TS18046: 'view' is of type 'unknown'` (also lines 24 and 25). It is being fixed through Test repair (test-issues.md); raise it only if `tsc -p web --noEmit` still fails.

Orchestrator decisions on round 4 findings, do not raise them again:
- Saving 3 or 0 and clearing `review.maxLoops` through the settings API (AC2, AC3) already work on the base branch; no new tests.
- The `Number.isSafeInteger` bound is accepted: values above 2^53 are not a meaningful loop limit.
- A setting saved but not committed in the main checkout not reaching a new run's worktree applies to every setting, not just this one. It is out of scope here and goes to the backlog.
