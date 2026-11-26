# Review round 2: review-loop-limit-ui-setting

Verdict: **pass**

## Round 1 findings
- **Blocker fixed.** An empty `SDLC_REVIEW_MAX_LOOPS` row now means "inherit". `reviewLimitError` ignores `''`, and `envVars` drops the row. A cleared override no longer blocks launches.
- **Missing tests added.** The form logic moved into `web/ui/src/env.ts`:
  - project settings: `reviewSettingsDraft` and `reviewSettingsPatch`;
  - run options: `reviewLimitError` and `reviewLimitOptions`.

  `test/review-loop-limit-ui.test.ts` tests these functions directly. It covers the default draft (2), a configured 0, the rejection message for -1, 0.5, '' and 'abc' with no patch, and a patch only when the value changed. It also covers an invalid override kept out of the env and launch, 0 kept in the env and summary, and clearing.

## Acceptance criteria
1. **Default and configured value shown:** `reviewSettingsDraft` (UI test) and the settings GET (server test).
2. **Save, reopen, unrelated settings kept:** the server round trip checks the whole file.
3. **Override, including 0; project file unchanged; inherit without override:** server tests on the real pipeline.
4. **Rejection in both forms and through the API:** UI helper tests, settings 400, and the start route's 400 before any worktree or record is made. Every run POST route goes through `envOf`.
5. **"needs you" kept, and a pass on the last round completes:** server tests.

Both files pass locally:
- `web/test/review-loop-limit.test.ts`
- `test/review-loop-limit-ui.test.ts`

## Notes (not blocking)
- `web/ui/src` now imports `ai-sdlc-helper/review-limit`. This is the UI's first import by package name. `web/ui/tsconfig.json` has a path for it, but `web/ui/vite.config.ts` has no alias, so `vite build` depends on resolving the package's own name to `dist/`. I could not run the build here. Confirm in CI (the `prepare` and e2e builds) that `build:web` succeeds.
- `parseReviewLimit` accepts the strings `2.0` and `1e1`, because their values are whole numbers. Client, server and engine all handle them the same way.
- While the override is invalid, every action that resumes the run is blocked, including saving answers or claims without resuming. This is stricter than needed but does not break the spec.
