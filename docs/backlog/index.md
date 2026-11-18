# Backlog

Pending items are picked top-down. Format: `- [ ] \`slug\` - title`; each item needs `docs/backlog/<slug>/brief.md`.

Markers: [ ] pending, [x] completed, [!] blocked, [~] parked (skipped).

- [x] `add-ui-triage-agent` - Feature: run the triage agent in the web UI (E-8)
- [x] `add-setup-branch-pr` - Feature: commit `add` setup files on a chore/sdlc-setup branch from main, then optionally push and open a PR
- [x] `stage-files-tree-viewer` - Feature: collapsible tree viewer for files changed per stage in web UI
- [ ] `non-node-ecosystem-support` - Feature: support non-Node/non-TypeScript ecosystems (Python, Go, Rust) for test detection, red-checks, and execution
- [ ] `fix-dependabot-alerts` - Bug: fix the open Dependabot alerts (13: 1 critical, 1 high, 10 medium, 1 low)
- [ ] `ui-code-indexer-setup` - Feature: interactive UI button to configure and build graft/graphify code indexers
- [x] `config-modal-keyboard` - Improvement: Projects page Config modal closes on Esc, keeps focus inside, and returns it to the Config button
- [ ] `red-tests-minimal-case-tests` - Improvement: Red tests stage writes the fewest tests covering every case, one named test per case ID, shared non-blocking setup
- [ ] `trace-worth-check` - Improvement: check that the always-on trace and its log rotation are worth their cost, or whether an outside tool can do it
- [ ] `ci-full-suite-gate` - Feature: Config option to run the full test suite in CI only: draft PR opens at Red tests, Implement waits for green CI and fixes side-effect failures
- [ ] `stabilise-pr-status-tests` - Bug: Fix the timing-sensitive PR status tests that fail under load
- [x] `edit-backlog-item-in-ui` - Feature: Edit an existing backlog item (title, type, priority, brief) from the web UI
- [x] `resolve-conflicts-after-finalise` - Feature: A stage after Finalise brings the PR up to date with main and resolves conflicts without breaking the task or the work merged meanwhile
- [ ] `stop-implement-on-test-defect` - Improvement: Implement stops and offers Test repair when a round claims a test defect and the next round changes nothing
- [x] `stage-model-harness-mismatch` - Bug: a stage whose model belongs to another harness dies at the start with "provider ... is not listed in SDLC_PROVIDERS" instead of naming the harness mismatch
- [ ] `web-perf-measurement-order` - Improvement: settle the measurement-vs-independence order for the web-performance steps and prove each saving after they land
- [ ] `backend-driven-pipeline` - Feature: the pipeline's follow-up work (brief cleanup after a merge, a run's questions) is driven by the server, not by someone opening the board
- [ ] `github-enterprise-support` - Feature: recognise GitHub Enterprise remotes, so a company GitHub on another domain gets the start-up PR fill
- [ ] `board-quiet-time-setting` - Improvement: set the board watcher's quiet time (30 s, now only `SDLC_BOARD_SILENCE_MS`) from the web UI's Config
- [x] `ci-after-review-changes` - Bug: a run says done while CI on Review's last commit is still pending; wait for CI when Review changes source
- [ ] `review-findings-acted-on` - Improvement: Review's blockers and missing-test findings send the run back to Implement or Red tests, or stop it, instead of sitting unread in review-1.md
- [ ] `review-loop-limit-ui-setting` - Feature: set the Review loop limit (default 2) in the web UI
- [ ] `ui-orchestration-gaps` - Feature: make every run decision in the web UI (stage guidance, finding waivers, claim edits) and flag edits made outside it
- [x] `pr-link-committed-not-main` - Bug: commit and push the PR link on the run's branch whenever a PR opens or is replaced, and stop writing it into the main checkout
- [ ] `runs-survive-ui-restart` - Bug: a run started from the UI dies when the UI server stops
- [ ] `fix-loop-red-gate-kind` - Bug: the Review fix loop's red gate rejects every test for a missing-test finding, its stop gets the wrong diagnosis, and the loop limit resets on each start
- [ ] `ui-signin-links-and-domain` - Feature: ui prints both local sign-in links, and a domain set by SDLC_UI_DOMAIN with how to point it at the port
- [ ] `inspect-run-docs-anytime` - Feature: Inspect brief, spec, plan and the agent's questions and answers at any point of a run
- [ ] `red-tests-unique-names` - Bug: Red tests: every new test has a unique name; no false flaky label
- [ ] `ui-confirm-dialogs` - Feature: Replace the inline Confirm / Keep it buttons with a confirmation dialog
- [ ] `repair-stale-stage-discards` - Bug: Runs discarded before the stage-discard fix still show the earlier stage as stopped
- [ ] `orchestrator-agent` - Feature: optional agent that drives a run and decides pauses, with limits and a decision log
- [ ] `lock-icon-unlocked-on-retry` - Bug: the lock icon shows unlocked when a retry or discard restarts from Spec, Plan or Red tests
- [ ] `cost-record-last-stretch` - Bug: commit the final cost record so the last stretch of agent work is not missing
