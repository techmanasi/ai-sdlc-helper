# Always-on stage pane

The run page's stage rail gets a pane that is always visible under it, joined to the selected tile.

- The pane follows the running stage (or the paused or failed one). Picking another tile shows a back bar with a "Back to <stage>" button.
- Outline colour follows the stage: red stopped or failed, teal running, green done, grey idle.
- Left column: agent, model and effort, Finalise options, files, Discard. Right column: steps for the round, round chips, the test lock.
- A stage that has not started shows its planned steps (`RunView.stepPlan`, from `STEP_PLAN` in `src/runs/view.ts`) as dashed rows.
- Tiles carry a "Round N" pill and Finalise a pull request badge. On a narrow window tiles are 150px wide with edge fades and hidden-tile counts; on a phone the details open under the tapped stage, or by themselves when it pauses or fails.
- Logic lives in `web/ui/src/stagePane.ts` (tested in `test/stage-pane.test.ts`); `StageSpan.rounds` comes from `src/runs/timeline.ts`.

Screenshots: `docs/plans/screenshots/stage-tabs-{running,stopped,pending}.jpg`.
