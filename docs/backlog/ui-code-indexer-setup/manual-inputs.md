# Manual inputs (orchestrator, 2026-11-17)

## red-tests

Red tests for Review round 1 findings (fix loop). The code is implemented, so every new test must fail against the current tree. The red gate refused the previous attempt because 4 tests already pass; drop them:
- "rejects unsupported or unavailable selection" (all three cases): selection validation already works and no finding asked for it.
- "reports a deterministic write failure after a verified build and keeps the index": the configuration-save failure already behaves as the spec asks, so that missing-test finding is closed with no new test.

Write tests only for the four blockers in review.json, each against real code:
1. `src/config/codeSetup.ts` output buffer: a single line or an unterminated partial longer than 32 KB is capped (last 100 lines or 32 KB, Decision Q5).
2. `src/config/codeSetup.ts` persistence: a configuration edit made while the build runs is kept; the write re-reads the file at persistence time (Decision Q1).
3. `src/config/codeSetup.ts` timeout: the per-project guard stays held until the process has exited, and a child that ignores SIGTERM is killed with SIGKILL after the grace period (Scenario 9). Use a fixture that traps SIGTERM.
4. `web/ui/src/CodeIndexerSetup.tsx` refresh after a build that finished while the modal was dismissed (see the screen tests below, `setupChanged`).

Screen tests (Review missing tests for Scenarios 1-5). This repo tests UI behaviour by moving a component's logic into a plain module and testing that module directly, without rendering: see `web/ui/src/dialog.ts` with `test/dialog.test.ts`, `web/ui/src/stages.ts` with `test/board-stages.test.ts`, `web/ui/src/notices.ts` with `test/notice-dismiss.test.ts`. Follow that pattern. Import from a NEW module `web/ui/src/codeIndexerState.ts` (it does not exist yet, so these tests fail before Implement) and put them in `test/code-indexer-screens.test.ts`:
- Scenarios 1-2, Doctor (`Projects.tsx`): `doctorSetupAction(check)` says whether the code-indexer check shows the setup action (shown for a failing or warning code-indexer check, not for a passing one or another check).
- Scenario 3, Settings (`Settings.tsx`): `settingsSetupAction(codeSearch)` is always available, for a healthy, a `none` and an unindexed configuration, with the label or hint the spec gives for each.
- Scenario 4, the modal: `buildEligibility(indexer, running)` enables Build only for an installed, runnable indexer when no build runs, and returns the guidance text the spec gives otherwise; `initialPick(view)` picks the indexer the spec says to preselect.
- Scenario 5, the build lifecycle: `buildPhase(operation)` maps an operation (none, running, succeeded, failed, timeout) to what the modal shows (progress, done, retry) and whether to keep polling; `setupChanged(openedWith, now)` is true when a build succeeded, including one that finished while the modal was dismissed.
Use the exact wording and states from specs-1.md; do not invent behaviour the spec does not give.

Put the new tests in a NEW file, `web/test/code-indexer-findings.test.ts`, and revert the uncommitted edits to `web/test/code-search-setup.test.ts`. Run the new file and confirm every test fails before finishing.

## implement

Fix the four Review blockers above. Create `web/ui/src/codeIndexerState.ts` with the functions the screen tests import, and make `Projects.tsx`, `Settings.tsx` and `CodeIndexerSetup.tsx` use them instead of inline logic, so the tested logic is the logic the screens run.

## review

Orchestrator decisions on round 1, do not raise them again:
- Screens (Scenarios 1-5) are tested through `web/ui/src/codeIndexerState.ts`, the repo's pattern for UI logic; no DOM rendering setup is added. Check that the three components really use that module.
- Configuration-save failure after a verified build (edge case 8) already behaves as specified; no new test.
- `ai-sdlc-helper run --file` failing on `tests.fullSuite` and `agent.stages` is the globally installed CLI being older than this repo; run tests with `npx vitest run <file>` instead.
