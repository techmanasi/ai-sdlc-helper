# Handover to Codex (2026-11-19)

Read `AGENTS.md` first (it holds the repo rules), then `docs/backlog/decisions-2026-11-19.md` (the order of work).
Claude's weekly budget is nearly spent; Codex finishes the "now" items. Work one item at a time, one branch and PR each,
branching from `origin/main`, worktrees under `../ai-sdlc-helper-sdlc/<slug>`.

## Hard rules (from the user)
- Never merge a PR yourself: stop and report the PR number and its CI rows; the user says yes. Never merge #91; never
  delete branches; never push fix commits onto `sdlc/*` branches.
- UI changes: take screenshots of the changed screens (Chrome, or the UI tool `tools/UI-automation/sdlc-ui.js`) and
  put them in the PR body. State they were taken against synthetic state. Do NOT push a UI change before the user has
  seen the screenshots: commit locally, save the screenshots under `docs/plans/screenshots/`, then stop and report.
- Operate pipeline runs only through the web UI; never edit a run's files. Print the signed `?t=` link after any UI
  server restart. Sample projects are throwaway.
- A UI markup or label change updates `tools/UI-automation/sdlc-ui.js` `SELECTORS` in the same PR.
- Run only targeted tests locally; the full suite runs in CI (`gh pr checks <n>`). Log long commands to `/tmp/sdlc-*.log`.
  `npm run typecheck` includes `tsc -p test`: web/ui files imported by tests need `.js` extensions on relative imports.
- Node 18 APIs only. Tests exercise real code; never assert on Markdown. Name SDLC stages, never number them.
- Never `pkill`/`killall` by name. Leave the UI servers on ports 4477-4486 alone.
- Commit trailers: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` is for Claude; use your own identity.
- Keep the user's email and tokens out of external services.

## Status on 2026-11-20

The always-on stage pane, unique test names, and the Review findings loop have merged. [Pane #185](https://github.com/techmanasi/ai-sdlc-helper/pull/185) · [Unique names #182](https://github.com/techmanasi/ai-sdlc-helper/pull/182) · [Review loop #165](https://github.com/techmanasi/ai-sdlc-helper/pull/165)

| Remaining item | Status | Next step |
| --- | --- | --- |
| Stage pane redesign | Partial. Local commit `cd080b9` on `feat/stage-tabs` matches the deck. | Show the Running, Stopped and Pending screenshots from that worktree’s `docs/plans/screenshots/` before pushing. Open a fresh PR from current main. |
| README demo GIFs | Partial. The `demo-gifs` worktree has untracked capture and build scripts and screenshot sequences. | Generate the animations and add them to the README. |
| README repo links and stale text | Pending. Old repository references and outdated release and Settings instructions remain. | Update the README, releasing guide and plan. Account for the subsequent README title change to “Software Factory”. |
| `ui-confirm-dialogs` | Pending. The redesign has a brief. | Implement the shared confirmation dialog and migrate the inline controls. |
| `runs-survive-ui-restart` | Pending. Survival and reattachment after a UI restart still need verification. | Exercise both restart cases in the brief and fix any failures. |
| `ui-orchestration-gaps` | Partial. Stage guidance and Red tests recovery have landed. | Finish the brief, including finding waivers and detection of edits outside the UI. |
| `fix-loop-red-gate-kind` | Partial, blocked. UI runs have started. The latest Implement resume exited during model validation. Draft [PR #184](https://github.com/techmanasi/ai-sdlc-helper/pull/184) has conflicts and failing Node checks. | Resolve the incompatible Spec model effort and resume through the UI. |
| `cost-record-last-stretch` | Partial. Resolve conflicts can commit costs on an existing push. | Ensure the final agent costs reach the PR branch at run completion. |

## Original work order (2026-11-19)
1. **PR #185** (`feat/stage-tabs`, worktree `../ai-sdlc-helper-sdlc/stage-tabs`): read `gh pr checks 185`. If red, fix on
   that branch and push. If green, report to the user for merge.
2. **Pane redesign to the design deck** (artifact https://claude.ai/artifact/RrbUCYRhYmxVz1DjTsnggz, page "Run page
   stage rail"; read-only data, do not edit): step pills in `StepList` (`web/ui/src/RunInsights.tsx`; radius 999,
   border #323c49, bg #1a212b, 13px; done = green check; running = teal spinner on #10323a; failed = red stop square
   "failed at 42s"; not started = dashed, no time), dark selects `.sel` (12px, padding 6px 10px, border #323c49,
   radius 6, bg #0d1117, colour #dbe2ea), eyebrow 11px/600/.06em #8f9baa, round chips 11px outlined with the active chip
   inverted, an amber "TEST LOCK" eyebrow with closed (green) and open (dashed amber) lock badges on Red tests, the
   footnote "A pill appears when its step starts. The running one counts up; the others keep their final time."
   Pure logic lives in `web/ui/src/stagePane.ts` (tested in `test/stage-pane.test.ts`). Do this on `feat/stage-tabs`
   as extra commits, commit locally, take Running/Stopped/Pending screenshots, STOP and report before pushing.
3. **README demo GIFs** in `demo/screenshots`, rebuildable by a script, from end-to-end runs through the UI.
4. **README repo links**: `imaimai86` to `techmanasi` in README, `docs/RELEASING.md`, `docs/PLAN.md`; fix stale lines
   (Settings are editable now; npm release is out; 8 stages not 6; title "Dark Factory"; add `gh` to Requirements).
   Markdown-only: run `npm run lint` only.
5. **`red-tests-unique-names`** and 6. **`ui-confirm-dialogs`** (with redesign: replace inline Confirm / Keep it
   buttons with a dialog): briefs are in `docs/backlog/<slug>/`.
7. After those: `runs-survive-ui-restart`, `ui-orchestration-gaps`, `review-findings-acted-on` (briefs in `docs/backlog/`).
8. `fix-loop-red-gate-kind` (PR #184): only through the UI, "Resume at..." the discarded stage.
9. `cost-record-last-stretch`: commit the final cost record to the PR.

Open PRs at handover on 2026-11-19: #185, #184, #186 (this handover and the decisions), #170 (excluded), #167, #158, #91 (never merge).
