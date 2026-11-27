# Review round 1: review-loop-limit-ui-setting

Verdict: **changes**

## What works
- `review.maxLoops` has a dedicated `reviewLimit` schema entry. Its error reads "must be a whole number of 0 or more".
- `resolve` uses the run's `SDLC_REVIEW_MAX_LOOPS` first, then the current project file (also when the run is in a worktree, through `agentFrom`), then 2. It uses `??`, so 0 is kept.
- The server rejects invalid overrides in `envOf` before it builds a context or starts a run. It also drops any `SDLC_REVIEW_MAX_LOOPS` in its own environment, so every request falls back to the project value unless it sends its own.
- `web/test/review-loop-limit.test.ts` (12 tests, all passing) drives the real server and pipeline. It covers:
  - the settings round trip, plus refusing -1 and 0.5;
  - API override rejection;
  - an override of 0 stopping with "needs you";
  - inheriting the project value and the default when the worktree copy is stale;
  - a pass on the last allowed round.
- The UI automation tool has selectors for both new inputs.

## Blocker
- `Run.tsx:334`: a `SDLC_REVIEW_MAX_LOOPS` row with an empty value counts as an invalid override. Every launch is then refused, and the error cannot be cleared from the override field. A blank value must mean "inherit".

## Missing tests
- Project settings form (`Projects.tsx`): no test runs the displayed default, the client-side rejection message, or the patch it builds.
- Run options (`Run.tsx`): no test runs the override validation, the rule that keeps an invalid override out of storage and the launch, the summary, or clearing.

For both, move the logic into a plain `web/ui/src` module and test it there.
