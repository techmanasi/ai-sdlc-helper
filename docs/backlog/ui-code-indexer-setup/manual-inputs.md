# Manual inputs (orchestrator, 2026-11-17)

## red-tests

Red tests for Review round 1 findings (fix loop). The code is implemented, so every new test must fail against the current tree. The red gate refused the previous attempt because 4 tests already pass; drop them:
- "rejects unsupported or unavailable selection" (all three cases): selection validation already works and no finding asked for it.
- "reports a deterministic write failure after a verified build and keeps the index": the configuration-save failure already behaves as the spec asks, so that missing-test finding is closed with no new test.

Write tests only for the four blockers in review.json, each against real code:
1. `src/config/codeSetup.ts` output buffer: a single line or an unterminated partial longer than 32 KB is capped (last 100 lines or 32 KB, Decision Q5).
2. `src/config/codeSetup.ts` persistence: a configuration edit made while the build runs is kept; the write re-reads the file at persistence time (Decision Q1).
3. `src/config/codeSetup.ts` timeout: the per-project guard stays held until the process has exited, and a child that ignores SIGTERM is killed with SIGKILL after the grace period (Scenario 9). Use a fixture that traps SIGTERM.
4. `web/ui/src/CodeIndexerSetup.tsx` refresh after a build that finished while the modal was dismissed: the repo has no DOM test setup, so test this through a pure helper. Import `setupChanged` from a NEW module `web/ui/src/codeIndexerState.ts` (it does not exist yet, so the test fails); it takes the operation state seen when the modal opens and returns true when a build completed successfully, including one that finished while dismissed. Implement creates the module and uses it in the component.

Put the new tests in a NEW file, `web/test/code-indexer-findings.test.ts`, and revert the uncommitted edits to `web/test/code-search-setup.test.ts`. Run the new file and confirm every test fails before finishing.

## implement

Fix the four Review blockers above. Create `web/ui/src/codeIndexerState.ts` with `setupChanged` and use it in `CodeIndexerSetup.tsx`.

## review

Orchestrator decisions on round 1, do not raise them again:
- UI rendering tests for Doctor (Projects.tsx), Settings.tsx and the modal (Scenarios 1-5) need a DOM test environment (jsdom and testing-library) that this repo does not have. Adding it is out of scope here and goes to the backlog; the modal's refresh logic is covered through `setupChanged`.
- Configuration-save failure after a verified build (edge case 8) already behaves as specified; no new test.
- `ai-sdlc-helper run --file` failing on `tests.fullSuite` and `agent.stages` is the globally installed CLI being older than this repo; run tests with `npx vitest run <file>` instead.
