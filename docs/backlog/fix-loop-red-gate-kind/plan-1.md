# Plan 1: fix-loop-red-gate-kind

Binding decisions (decisions.md): Q1 `decisions.md` is not written; the skip goes to the run output and to
`logs/review-rounds.json` as outcome `implement-skipped` with the accepted test files. Q2 one helper restores the
findings where the run starts at Red tests; the gate logic itself does not read the file.

Root cause: in a fix loop `redTestsStage` uses HEAD as the vacuous-check base, so every passing new test is rejected
and the stop points to Plan. `fixCycle` rewrites the stop into a wrong diagnosis. A resume at Red tests loses
`promptExtra`, so `fixing` is false (Implement commits get stripped). `loops` restarts at 0 in each process.

## Steps (in order)

### 1. `src/pipeline/review-gate.ts`: round data and loop count
- Extend `ReviewRound` with `loop?: number` and `acceptedFiles?: string[]`.
- In `reviewLoop`, replace `let loops = 0` with the highest `loop` found in `readReviewRounds` (0 when none). When a
  fix loop starts, set `entry.loop = loops` along with the `fix loop N of M` outcome. A later pass overwrites the
  previous outcome with `fixed`, so the count must come from `loop`, not from `outcome`.
- Export `findingsText`. Rewrite it per kind: a `blocker` needs a test that fails on the current code for the stated
  reason; a `missing-test` needs a test that passes on the current code and would fail without the fix.
- Add exported `restoreFixFindings(ctx)`: read the last round via `readReviewRounds`. If it has open findings and its
  outcome is not final (not `fixed`/`passed`, not `implement-skipped` because those tests are already committed and
  locked and the run goes on to Review, not starting with `stopped`), set
  `ctx.promptExtra = { ...ctx.promptExtra, REVIEW_FINDINGS: findingsText(round, openFindings) }` and return true. Else
  return false and leave `promptExtra` alone.

### 2. `src/pipeline/stages.ts`: fix-loop gate in `redTestsStage`
- Keep the initial (non-fix) path byte-for-byte unchanged (`fixing` false).
- When `fixing`:
  1. Run the new tests on the current tree with `testsPass(ctx, { targetFiles, onlyTargets: true, noAllowFailures: true })`
     (writes tests.log and tests.json).
  2. Read per-test results (`RunResult.tests`: `file`, `name`, `status`). Failing tests on the current tree are
     accepted.
  3. For each passing test, run it at `origRedSha` with `testsPassAt` (via `resultsAt`). Passing there too means
     vacuous: reject. Failing there means accepted as a `missing-test` test.
  4. Reject tests that cover only `missing-test` findings but pass on both sides. Stop with
     `RED GATE FAILED: test(s) already pass at base commit and on current code:\n  <file> :: <test name>\nOpen findings:\n  [missing-test] <file>: <criterion>: <reason>`.
  5. If any `blocker` finding is open and no test fails on the current tree, stop with
     `RED GATE FAILED: blocker finding has no failing test on current code.\nOpen blocker findings:\n  [blocker] <file>: <criterion>: <reason>`.
  6. Neither stop message mentions Plan or Spec.
- Keep the commit, lock and `origRedSha` logic as is.
- Return/record a flag `ctx.implementSkipped` (new optional boolean on the context type, in `src/pipeline/context.ts`),
  true when every finding is `missing-test` and no test fails on the current tree. In that case also store
  `ctx.acceptedFiles`.

### 3. `src/pipeline/review-gate.ts`: `fixCycle`
- Remove the `catch` that rewrites `RED GATE FAILED` into "a Review finding was wrong or already fixed".
  The failure propagates unchanged to the run output and errors.log.
- After `redTestsStage`: if `ctx.implementSkipped`, print
  `Implement skipped: no new test fails on the current tree; every accepted test covers a missing-test finding`,
  set the round `outcome = 'implement-skipped'` and `acceptedFiles`, save via `saveRounds`, skip
  `implementStage` and `testRepairStage`, and return to the review. Reset the flag.
- Otherwise the existing `resultsAt(red.json)` → `implementStage` → `testRepairStage` path is unchanged.

### 4. `src/pipeline/run.ts`: start at Red tests
- In `stages()`, where `fromN === 3` (start at Red tests), call `restoreFixFindings(ctx)` before `redTestsStage`
  and clear `ctx.promptExtra` afterwards. Fresh runs and runs whose last round passed return false and start as usual.
- When `fromN <= 2`, add `logs/review-rounds.json` to the `setAside` list so the loop count resets on a restart
  from Spec or Plan. A discard starts clean.
- The review step after a resumed red-tests gate that skipped Implement must go straight to `reviewLoop`: in the
  `fromN <= 5` block of `stages()`, when `ctx.implementSkipped` is set (also record the outcome/`acceptedFiles` on the
  restored round through a shared helper exported from review-gate.ts, the same one `fixCycle` uses), skip `resultsAt`,
  `implementStage` and `testRepairStage`, and clear the flag. `reviewLoop` reads the loop count from the file, so a
  resumed fix loop is not counted twice.

### 5. `src/pipeline/hints.ts`: diagnosis
- In `stageRecoveryHint`, before the existing "already pass before implementation" branch, match
  `RED GATE FAILED: test(s) already pass at base commit` and `RED GATE FAILED: blocker finding has no failing test`.
  Return `{ stage: 'red-tests', diagnosis: <names the rejected tests and their findings from the log line>,
  autoAction: 'Resume at Red tests', manualAction: <points at logs/tests.log, plus the resume command via
  resumeCommand>, escapeHatch: undefined }`. It never offers Plan, Spec or Resume at Implement.
- Leave the initial-run branch untouched.

### 6. Tests (all run real code; none read documentation)
Run each with `ai-sdlc-helper run --file <file>`; the full suite runs in CI.
- `test/review-gate.test.ts` (uses `fixture`, `pipeline`, `configure`, `read`, `readReviewRounds`):
  - missing-test only, test passes now and fails at `origRedSha`: accepted, `implementStage` and test repair do
    not run, stdout holds the `Implement skipped: ...` line, the round in review-rounds.json has outcome
    `implement-skipped` and `acceptedFiles`.
  - missing-test test passes on both sides: stops with the `already pass at base commit and on current code` message
    listing the test and the open finding, no Plan mention.
  - blocker finding with no failing test: stops with the `blocker finding has no failing test on current code`
    message.
  - blocker test failing now: normal path, Implement runs.
  - maxLoops persistence: with a round of `loop: 1` already on disk, a second `reviewLoop` run with `maxLoops: 1`
    stops with `REVIEW NOT RESOLVED after 1 fix loop(s)` without running another fix cycle. A start from Plan sets the file aside
    and the count restarts.
  - Resume (decision Q2): a fix-loop red-gate stop, then `start --from red-tests`, runs the fix-loop gate (no strip of
    Implement commits via git log check, no Plan hint) and the agent prompt received by the fake agent contains the
    findings text. A fresh run and a run whose last round passed leave `promptExtra` empty.
  - Existing assertion at review-gate.test.ts:97 (`RED GATE FAILED`) is updated to the new message.
- `test/hints.test.ts`: both new stop messages give `autoAction: 'Resume at Red tests'`, a `manualAction` naming
  `logs/tests.log`, and no `escapeHatch`; the old initial-run message still returns its Plan hint.
- `test/pipeline.test.ts` / `test/pipeline-resume.test.ts`: update only the assertions that referenced the old
  fix-loop message, if any.
- Unit test for `restoreFixFindings` and `findingsText` through direct imports with a temp `review-rounds.json`:
  open findings and non-final outcome restore; passed or `stopped` rounds do not; empty file does not.

### 7. Docs (separate step, not tested)
- `docs/PLAN.md`: update the review fix loop description (per-kind red gate, Implement skipped, resume at Red tests,
  persisted loop count).
- `CHANGELOG.md` under `## [Unreleased]`: `### Fixed` entry for the fix-loop red gate and `### Changed` for the new
  hint.
- Run `npm run lint` after the docs edit; targeted test files only for source changes.
- Refresh the graph with `graft build` after the code changes.

## Dependencies
- none
