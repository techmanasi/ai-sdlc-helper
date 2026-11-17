# Review round 1: changes required

Reviewed `git diff 5a088d9bcecc0f5ad7ea9501b3c72eb3fbbf24ef` against `specs-1.md` and the accepted decisions, including Round 2's shell-free execution and graphify restriction. The feature has real server and UI implementation; the examined feature tests exercise real code, not documentation.

Four correctness blockers:

- Output buffering permits arbitrarily large partial or single lines, risking server memory exhaustion.
- Successful builds overwrite configuration edits made while the build runs.
- Timeout releases the per-project guard before termination and leaves descendant workers unhandled.
- Reopening a build that completed while dismissed never marks the modal changed, so closing skips Doctor/Settings refresh.

Acceptance coverage is incomplete. Scenarios 1–4 have no rendering tests, and Scenario 5's UI interactions, progress, success, and parent refresh are untested. Server coverage exercises successful build/persistence, malformed config, concurrency, and build failure, but the timeout test never verifies process death. Configuration-save failure also lacks coverage. See `review.json` for concrete test expectations.

Validation attempted: `ai-sdlc-helper run --file web/test/code-search-setup.test.ts`. It exited 2 before executing tests because the installed CLI rejects `tests.fullSuite` and `agent.stages` as unknown settings. No runtime test pass is claimed. The optional project memory file `.opencode/memory/MEMORY.md` is absent. Only the two requested report files were written.
