Type: bug
Priority: P2
Source: User, 2026-11-18: "Park this in backlog, I am not aware of this" (about runs discarded before the fix in `fix/stage-discard-state`).

## Problem

Before the fix, a stage discard moved `status.json`'s `stage` back to the previous stage and left the old stop in place. The run's `state` (`failed` or `paused`), its `note`, its `attempt` and its `resume_from` all stayed. The fix (`docs/plans/stage-discard-state.md`) writes `state: ready`, keeps the run at the discarded stage and sets `resume_from` to that stage. That only applies to discards made after it ships.

Runs discarded earlier still show the stage before as failed or waiting, with the discarded stage's stop reason. Their main button resumes at the old `resume_from`, which can rerun a stage that passed. Seen on `fix-loop-red-gate-kind`: Red tests was discarded, Plan shows "Stopped here", and Resume would run Plan.

## Expected behaviour

1. The run view recognises an old discard. The last line of `logs/run.out` is `stage <key> discarded; ready to retry`, `status.json` has no `discarded_stage`, and the run is not running. It shows that run the way the fix does: state `ready`, stage = the discarded stage, `resumeFrom` = its key, no recovery card and no "Why it failed" panel.
2. Optionally, it also rewrites that run's `status.json` once in the new shape, so the CLI (`status`, `start` with no `--from`) agrees.
3. Runs that were not discarded are unchanged.

## Tests

- A fixture run with the old shape (`stage: Plan`, `state: failed`, `resume_from: plan`, last `run.out` line `stage red-tests discarded; ready to retry`) gives a `runView` that is `ready` at Red tests, with `resumeFrom` `red-tests` and recovery null.
- A failed run whose last `run.out` line is something else stays `failed`.

## Notes

- Depends on the `ready` state from `fix/stage-discard-state`.
- Until this lands, an affected run can be started with **Resume at… → the discarded stage** rather than the main button.
