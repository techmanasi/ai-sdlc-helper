# Backlog

Pending items are picked top-down. Format: `- [ ] \`slug\` - title`; each item needs `docs/backlog/<slug>/brief.md`.

Markers: [ ] pending, [x] completed, [!] blocked, [~] parked (skipped).

- [x] `add-ui-triage-agent` - Feature: run the triage agent in the web UI (E-8)
- [x] `add-setup-branch-pr` - Feature: commit `add` setup files on a chore/sdlc-setup branch from main, then optionally push and open a PR
- [x] `stage-files-tree-viewer` - Feature: collapsible tree viewer for files changed per stage in web UI
- [ ] `non-node-ecosystem-support` - Feature: support non-Node/non-TypeScript ecosystems (Python, Go, Rust) for test detection, red-checks, and execution
- [ ] `ui-code-indexer-setup` - Feature: interactive UI button to configure and build graft/graphify code indexers
- [x] `config-modal-keyboard` - Improvement: Projects page Config modal closes on Esc, keeps focus inside, and returns it to the Config button
- [ ] `red-tests-minimal-case-tests` - Improvement: Red tests stage writes the fewest tests covering every case, one named test per case ID, shared non-blocking setup
- [ ] `trace-worth-check` - Improvement: check that the always-on trace and its log rotation are worth their cost, or whether an outside tool can do it
- [ ] `ci-full-suite-gate` - Feature: Config option to run the full test suite in CI only: draft PR opens at Red tests, Implement waits for green CI and fixes side-effect failures
- [ ] `stabilise-pr-status-tests` - Bug: Fix the timing-sensitive PR status tests that fail under load
- [x] `edit-backlog-item-in-ui` - Feature: Edit an existing backlog item (title, type, priority, brief) from the web UI
- [x] `resolve-conflicts-after-finalise` - Feature: A stage after Finalise brings the PR up to date with main and resolves conflicts without breaking the task or the work merged meanwhile
- [ ] `stop-implement-on-test-defect` - Improvement: Implement stops and offers Test repair when a round claims a test defect and the next round changes nothing
- [ ] `stage-model-harness-mismatch` - Bug: a stage whose model belongs to another harness dies at the start with "provider ... is not listed in SDLC_PROVIDERS" instead of naming the harness mismatch
