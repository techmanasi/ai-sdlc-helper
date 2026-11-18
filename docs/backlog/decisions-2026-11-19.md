# Decisions, 2026-11-19

Taken after reviewing what was raised earlier and left unfinished. Executors: Codex CLI as subagent where it is
cheaper in tokens and cost; the parent runs long checks and merges.

## Now (in this order)
1. PR #185 (always-on stage pane): fix its CI first.
2. Pane redesign to match the design deck ("Run page stage rail"): step pills, dark selects, chip and eyebrow sizes, footnote, Red tests lock badge.
3. README demo GIFs under `demo/screenshots`, rebuildable.
4. README repo links: `imaimai86` to `techmanasi`, and the other stale lines (Settings read-only, "comes next", stage count).
5. `red-tests-unique-names`.
6. `ui-confirm-dialogs`, with a redesign.

## After "now" is finished
- `runs-survive-ui-restart`
- `ui-orchestration-gaps`
- `review-findings-acted-on`

## Run in the pipeline
- `fix-loop-red-gate-kind` (operate through the web UI only).

## Later (backlog)
- `orchestrator-agent` (brief to write), `lock-icon-unlocked-on-retry`, `inspect-run-docs-anytime`, `repair-stale-stage-discards`, `ui-signin-links-and-domain`, `ui-code-indexer-setup`, CHANGELOG `[Unreleased]` refresh.

## Standing
- `cost-record-last-stretch`: the cost record in git can miss the last stretch; commit the final cost to the PR.
- Codex dollar amounts being estimates, and the guarantee strip's "untouched" claim on older runs: accepted as they are.
