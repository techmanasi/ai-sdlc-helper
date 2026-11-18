# Plan: a discarded stage leaves the run ready to retry, not failed at the stage before

## Problem

Discarding Red tests on a failed run turned Plan red ("Stopped here"). The "Why it failed" panel and the recovery
card then showed the Red tests failure as Plan's.

Cause: `discardStage` (`src/runs/index.ts`) moves `status.json`'s `stage` back to the latest earlier stage that
still has files. It changes nothing else:

- The run record keeps `exit_code` 1 (or 2 for a pause), so `viewState` still reports `failed` (or `paused`).
- `status.json` keeps the old `resume_from`.
- The board strip, the run page's stage rail and the recovery card all give the run's state to the stage in
  `stage`, so the earlier stage, which passed, takes the stop.
- The recovery card and the "Why it failed" panel read the tail of `run.out`, which holds the discarded stage's
  failure.

This happens with every stage, because one code path discards them all:

- A failed Implement, once discarded, marks Red tests failed.
- A paused Plan (questions), once discarded, marks Spec "Waiting for you".
- Discarding Spec leaves `stage` empty. The run page then marks Spec failed, because `Math.max(0, -1)` picks the
  first stage.

## Fix

A new run state, **`ready`**: nothing is running, the last stage was discarded, and the run is ready to retry it.

**Engine (`src/runs/index.ts`, `discardStage`)**
- It writes `status.json` with:
  - `state: 'ready'`.
  - `stage`: the discarded stage itself. The run stays there, and it is the next stage to run. Before this change
    the run moved back to the latest earlier stage that still had work. The stages before keep their work, and only
    the stage the run is at can be discarded.
  - `resume_from`: the discarded stage's key.
  - `discarded_stage: { stage, at }`.
  - The `note`, `agent`, `attempt` and `step` cleared.
- The next start rewrites `status.json` (the `Status` class writes only its own fields), so `ready` ends with it.

**View (`src/runs/view.ts`)**
- `viewState` returns `ready` when `status.json` says `ready` and the run is not running. This check comes before
  the record's exit code. A run stopped by the discard has an interrupted record, and `ready` wins over that too.
- `ready` gets no recovery card: there is nothing to recover from.
- `RunView.discardedStage` is `{ stage, at }` or null.

**UI (`web/ui/src`)**
- `ViewState` in `api.ts` gains `ready`. `GLYPH` gives it ↺. A `.s-ready` colour uses the waiting tone, not the
  failure one.
- `stripStates` (board) and the run page's stage states mark the stage in `stage` as pending (waiting to run
  again). The stages before it are done and the rest are pending.
- The run page's `stageStates` moves from `Run.tsx` into `insights.ts` so it can be tested, and is built on
  `stripStates`. The `Math.max(0, -1)` case goes away.
- The "Why it failed" panel shows only for `failed` and `stopped`, so `ready` hides it. A short panel says instead:
  "<Stage> was discarded at <time>. Its files are gone; the stages before it are kept. Resume from <Stage> to run
  it again."
- The main button reads "Resume from <discarded stage>", from `resume_from`.
- Board: `ready` counts as Needs you, because the user has to start the run again. It is not a failure, and no
  notification fires.
- `tools/UI-automation/sdlc-ui.js` reads the new panel, and `SELECTORS` gains its id.

## Tests (real code)

- `test/runs.test.ts` (or the file that covers `discardStage`): after a failed Red tests stage is discarded, the
  `runView` state is `ready`. `stage` is Red tests and `resumeFrom` is `red-tests`, and Plan can no longer be
  discarded. Recovery is null and
  `discardedStage.stage` is Red tests. The same holds for a paused Plan: the state is `ready`, not `paused`.
- A start after the discard makes the state `running` again, and `discarded_stage` is gone.
- `test/insights.test.ts`:
  - `stripStates` and `stageStates` for `ready` at Red tests give Spec and Plan done, and Red tests pending.
  - A failed run still marks its current stage failed.

## Not in this change

- The handoff file is kept on a stage discard. It is still shown, and still goes to its stage if the user resumes
  there.
- Runs discarded before this fix keep their wrong state until they are started again. The
  `fix-loop-red-gate-kind` run is one of them. Backlog item: `repair-stale-stage-discards`.
