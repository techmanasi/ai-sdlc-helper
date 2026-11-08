# Backlog

Pending items are picked top-down. Format: `- [ ] \`slug\` - title`; each item needs `docs/backlog/<slug>/brief.md`.

Markers: [ ] pending, [x] completed, [!] blocked, [~] parked (skipped).

- [x] `add-ui-triage-agent` - Feature: run the triage agent in the web UI (E-8)
- [x] `add-setup-branch-pr` - Feature: commit `add` setup files on a chore/sdlc-setup branch from main, then optionally push and open a PR
- [ ] `stage-files-tree-viewer` - Feature: collapsible tree viewer for files changed per stage in web UI
- [ ] `non-node-ecosystem-support` - Feature: support non-Node/non-TypeScript ecosystems (Python, Go, Rust) for test detection, red-checks, and execution
- [ ] `ui-code-indexer-setup` - Feature: interactive UI button to configure and build graft/graphify code indexers
- [x] `config-modal-keyboard` - Improvement: Projects page Config modal closes on Esc, keeps focus inside, and returns it to the Config button
- [ ] `red-tests-minimal-case-tests` - Improvement: Red tests stage writes the fewest tests covering every case, one named test per case ID, shared non-blocking setup
- [ ] `trace-worth-check` - Improvement: check that the always-on trace and its log rotation are worth their cost, or whether an outside tool can do it
