# Specification: fix-loop-red-gate-kind

## 1. Overview & Objectives

In the Review fix loop (`src/pipeline/review-gate.ts`, `reviewLoop` and `fixCycle`), findings are returned to `redTestsStage` to write regression or missing tests before code fixes are applied in `implementStage`. Currently:
1. The red gate applies a blanket check demanding that all new tests fail on the current working tree. While appropriate for `blocker` findings, this causes all `missing-test` findings (which assert built behaviour that passes on current code) to fail the red gate.
2. The diagnostic hint falls back to a generic syntax/runner error, and recovery incorrectly suggests Plan or resuming at Implement.
3. Resuming at Red tests via `ai-sdlc-helper start <slug> --from red-tests` loses the fix-loop context because `promptExtra.REVIEW_FINDINGS` is not restored.
4. The review loop limit (`review.maxLoops`) resets to `0` on every new pipeline process start instead of tracking loops across starts for the whole run.

This specification defines the behavior for:
- Evaluating new tests individually based on test execution results (at the current tree and at `origRedSha`), supporting both `blocker` and `missing-test` findings.
- Skipping `implementStage` and advancing directly to Review when every accepted test covers `missing-test` findings and none fails on the current tree.
- Restoring fix-loop context and Review findings when resuming at Red tests.
- Tracking fix loop iterations persistently across resumes via `logs/review-rounds.json`, and resetting loop counts on a restart from Spec/Plan or discard.
- Providing targeted diagnoses and recovery options for fix-loop red-gate stops.
- Preserving existing behavior for initial (non-fix-loop) Red tests stages and other pipeline stages.

---

## 2. Scope & Files Affected

- **`src/pipeline/stages.ts`**:
  - `redTestsStage`: Branch logic for `fixing` (when `ctx.promptExtra?.REVIEW_FINDINGS` is set). Per-test evaluation against the current tree and `origRedSha`, validation that blockers have at least one failing test, rejection of vacuous tests, skipping Implement if no test fails, and locking/committing tests.
- **`src/pipeline/review-gate.ts`**:
  - `findingsText`: Updated instructions per finding kind (`blocker` vs `missing-test`).
  - `fixCycle`: Handling of skipped Implement (bypassing `implementStage` and `testRepairStage`), recording outcome and accepted test files in `logs/review-rounds.json`, and removing/adjusting the misdiagnosed catch block.
  - `reviewLoop`: Tracking loop count across starts using historical rounds in `logs/review-rounds.json`.
- **`src/pipeline/run.ts`**:
  - Resume helper on `--from red-tests` to detect open review findings in the latest round of `logs/review-rounds.json` and restore `ctx.promptExtra.REVIEW_FINDINGS`.
  - Handling of `review-rounds.json` archiving (`setAside`) when restarting from Spec or Plan (`fromN <= 2`).
  - Skipping `implementStage` when resuming at Red tests in a fix loop where Implement was flagged as skippable.
- **`src/pipeline/hints.ts`**:
  - `stageRecoveryHint`: Dedicated diagnosis and recovery for fix-loop red-gate failures. Recommends "Resume at Red tests"; omits Plan, Spec, and "Resume at Implement".
- **`docs/PLAN.md` & `CHANGELOG.md`**:
  - Documentation updates describing the Review fix loop, gate behavior per finding kind, and persistent loop counting.

---

## 3. Detailed Behaviour

### 3.1. Findings Prompt for Red Tests (`findingsText`)
When constructing the prompt for the Red tests agent in a fix loop (`promptExtra.REVIEW_FINDINGS`), findings must be partitioned or annotated by kind:
- **For `blocker` findings**: The agent is instructed to write tests verifying the required behavior that currently **fail** against the codebase for the stated reason. If a blocker finding is already satisfied by the codebase, it requires no test but should be reported as a wrong finding.
- **For `missing-test` findings**: The agent is instructed to write tests verifying the already built behavior that currently **pass** against the codebase (and test behavior added during implementation).

### 3.2. Fix-Loop Red Gate Evaluation (`redTestsStage` on `fixing = true`)

In a fix loop, the gate evaluates each new or modified test individually based on test execution results:
1. **Execution on Current Tree**:
   - Run the new/modified test files against the current tree (which includes all prior implementation commits).
   - Record per-test results (`tests.json`), identifying which new tests pass and which fail.
2. **Execution at `origRedSha`**:
   - For each new test that **passes** on the current tree, verify whether it fails when executed against `origRedSha` (the test commit prior to any implementation commits on the task branch) with the new test files laid over it (using `testsPassAt` / `withWorktreeAt`).
3. **Acceptance Criteria per Test**:
   - **Accepted as a blocker test**: The test **fails** on the current tree.
   - **Accepted as a missing-test test**: The test **passes** on the current tree AND **fails** at `origRedSha` (demonstrating that it exercises behavior introduced by implementation commits).
   - **Rejected (vacuous test)**: The test **passes** on the current tree AND **passes** at `origRedSha`. It tests pre-existing baseline behavior and proves nothing about the task or findings.
4. **Round-Level Gate Conditions**:
   - **Vacuous Tests Stop**: If any new test passes both on the current tree and at `origRedSha`, stop the run. The stop message lists the rejected test(s) (file and test name) and the round's open findings.
   - **Blocker Test Requirement**: If the round contains at least one `blocker` finding, at least one new test must fail on the current tree. If no new test fails on the current tree while a blocker finding remains open, stop the run stating that the blocker has no failing test, naming the open blocker findings.
   - **No Tests Added**: If no new or modified test files were produced, stop the run as in standard red tests.
5. **Implement Skipping**:
   - If every open finding was `missing-test` and all new tests are accepted (i.e. every new test passes on the current tree and fails at `origRedSha`, and no test fails on the current tree):
     - The tests are staged, committed, and locked as usual.
     - The pipeline notes the skip in the run output:
       `Implement skipped: no new test fails on the current tree; every accepted test covers a missing-test finding`
     - The round entry in `logs/review-rounds.json` is updated with outcome `implement-skipped` along with the list of accepted test files.
     - `implementStage` and `testRepairStage` are bypassed; the pipeline proceeds directly to `reviewRound` (or subsequent Review stage).
     - Per Decision 1, `decisions.md` is **not** modified.
   - If at least one test fails on the current tree:
     - The tests are committed and locked.
     - `implementStage` executes normally so the agent can make the failing tests pass.

### 3.3. Pipeline Resumption & Context Restoration (`--from red-tests`)

When the pipeline starts at Red tests (`ai-sdlc-helper start <slug> --from red-tests` or via recovery action):
- Before running `redTestsStage`, check `logs/review-rounds.json`.
- If `logs/review-rounds.json` exists and the latest round has open findings whose outcome is not final (neither passed nor stopped due to reaching `maxLoops`):
  - Reconstruct `promptExtra.REVIEW_FINDINGS` using the round's findings and `findingsText(round, findings)`.
  - Consequently, `fixing` is set to `true`, preventing `redTestsStage` from stripping implementation commits or pointing to Plan upon failure.
- If there are no open review rounds or the last round passed, Red tests runs as a fresh stage.

### 3.4. Review Loop Counting Across Starts (`reviewLoop`)

- Fix loops are counted over the entire run by inspecting `logs/review-rounds.json` rather than initializing `let loops = 0` on process startup.
- The number of previously executed fix loops is determined from the historical rounds recorded in `logs/review-rounds.json` (counting rounds where a fix loop was initiated/recorded).
- When a new review round with findings starts:
  - If the cumulative loop count has reached `review.maxLoops`, the run stops with:
    `REVIEW NOT RESOLVED after <maxLoops> fix loop(s): <n> finding(s) still open. This needs you:`
    and lists the open findings and manual recovery commands.
  - Otherwise, the loop counter increments, the round outcome records `fix loop <loops> of <maxLoops>`, and the fix cycle begins.
- Resuming a run that stopped inside a fix loop continues that existing fix loop without incrementing the loop count.

### 3.5. Reset and Archiving on Restart and Discard

- **Restart from Spec or Plan** (`--from spec` or `--from plan`):
  - In `runPipeline` / `stages`, when starting with `fromN <= 2`, `review-rounds.json` is archived to `logs/previous/<timestamp>/` via `setAside(ctx, [`${ctx.log}/review-rounds.json`])`.
  - When the pipeline reaches Review later in the run, `review-rounds.json` begins with an empty history, resetting the loop count to 0.
- **Discard** (`ai-sdlc-helper discard`):
  - Discarding removes the worktree and run state. A subsequent run begins with no existing logs, starting the count from 0.

### 3.6. Diagnosis and Recovery Hints (`src/pipeline/hints.ts`)

- In `stageRecoveryHint`, detect fix-loop red-gate failures from the run output (e.g. matching `RED GATE FAILED: ...` in the context of a fix loop, or specific fix-loop red-gate stop messages).
- **Diagnosis**:
  - Explicitly states that a fix-loop test was rejected or a blocker lacked a failing test, identifying the rejected tests and open findings.
- **Actions**:
  - `autoAction`: `{ label: 'Resume at Red tests', command: resumeCommand(ctx.slug, 'red-tests') }`
  - `manualAction`: Points to `logs/tests.log` and instructs fixing the test assertions for the specific findings.
  - `escapeHatch`: **Omitted**. The recovery hint must never offer Plan, Spec, or "Resume at Implement" for a fix-loop stop.

### 3.7. Preservation of Initial Red Tests Stage & Other Stages

- The initial Red tests stage (when `fixing` is false) must remain unchanged:
  - Checks `hasImplSince(ctx, firstRedSha) && !fixing`.
  - Strips implementation commits via `testsPassAt` if resumes occurred.
  - Detects vacuous tests against `baseSha` (`firstRedSha^` or HEAD) and outputs `red-passing.md` pointing to Plan.
  - Suggests Plan/Spec upon failure.
- Implement, Test repair, CI checks, Finalise, and Conflict resolution stages operate unchanged, except for skipping Implement when all findings are missing tests and all tests pass on the current tree.

---

## 4. Inputs & Outputs

### 4.1. File Inputs
- `logs/review-rounds.json`: Read on pipeline startup and within `reviewLoop` to inspect prior rounds, open findings, and past fix loop counts.
- `logs/tests.json`: Read to extract per-test outcomes (`TestCase.name`, `TestCase.file`, `TestCase.status`) on the current tree and at `origRedSha`.
- `logs/tests.log`: Detailed test runner output.

### 4.2. File Outputs
- `logs/review-rounds.json`:
  - Appended/updated on each Review round.
  - When Implement is skipped, the round record is saved with outcome `implement-skipped` and the list of accepted test files:
    ```json
    {
      "round": 1,
      "verdict": "changes",
      "findings": [ ... ],
      "outcome": "implement-skipped",
      "acceptedFiles": [ "test/example.test.ts" ]
    }
    ```
- `logs/red.json`: Snapshot of test results at `origRedSha` when running Implement or when needed.
- `docs/PLAN.md`: Updated to describe the Review fix loop and gate behavior.
- `CHANGELOG.md`: Updated with entry under `[Unreleased]`.
- `decisions.md`: **Not written or modified by this feature**.

### 4.3. Command Line & Console Outputs
- On Implement skipped:
  ```text
  Implement skipped: no new test fails on the current tree; every accepted test covers a missing-test finding
  ```
- On Vacuous Test Stop in Fix Loop:
  ```text
  RED GATE FAILED: test(s) already pass at base commit and on current code:
    <file> :: <test name>
  Open findings:
    [missing-test] <file>: <criterion>: <reason>
  ```
- On Blocker Lacking Failing Test:
  ```text
  RED GATE FAILED: blocker finding has no failing test on current code.
  Open blocker findings:
    [blocker] <file>: <criterion>: <reason>
  ```
- On Review Loop Limit Reached:
  ```text
  REVIEW NOT RESOLVED after <maxLoops> fix loop(s): <n> finding(s) still open. This needs you:
    [<kind>] <file>: <criterion>: <reason>
  Fix them by hand, then resume at Review: ai-sdlc-helper pipeline <slug> --from review (or at Implement: ai-sdlc-helper pipeline <slug> --from implement)
  ```

---

## 5. Error Cases & Edge Cases

1. **Test passes on current tree and passes at `origRedSha`**:
   - Result: Test rejected as vacuous. Run stops with fix-loop red-gate error naming the test and finding.
2. **Round has blocker findings, but all tests pass on current tree**:
   - Result: Stop with message that blocker has no failing test.
3. **Round has mixed blocker and missing-test findings**:
   - Blocker tests fail on current tree; missing-test tests pass on current tree and fail at `origRedSha`.
   - Result: Both accepted. At least one test is failing on current tree, so `implementStage` runs.
4. **Resumed run at Red tests (`--from red-tests`) with active review findings**:
   - Result: Restores `promptExtra.REVIEW_FINDINGS`. Does not strip implementation commits. Evaluates using fix-loop red gate.
5. **Resumed run at Red tests without prior review findings**:
   - Result: Treats run as standard initial Red tests stage.
6. **Max loops reached across multiple process starts**:
   - Given `maxLoops = 2`, run performs 1 loop in process 1, stops. Resumed in process 2, performs loop 2, Review reports changes again.
   - Result: Process 2 detects 2 prior fix loops from `review-rounds.json` and halts with `REVIEW NOT RESOLVED`.
7. **Restart from Spec/Plan**:
   - User restarts with `ai-sdlc-helper restart <slug> --from spec` or `--from plan`.
   - Result: `review-rounds.json` is set aside to `logs/previous/`. The loop count resets to 0.

---

## 6. Acceptance Criteria

1. **Missing-Test Round**:
   - A Review round with only `missing-test` findings has tests written that pass on the current tree and fail at `origRedSha`.
   - Red tests accepts the tests, commits and locks them.
   - `implementStage` is skipped with the message logged to run output.
   - `logs/review-rounds.json` records outcome `implement-skipped` with accepted test files.
   - The pipeline proceeds directly to Review.
2. **Vacuous Missing-Test Rejected**:
   - A `missing-test` test that passes on current tree AND passes at `origRedSha` is rejected.
   - Run stops, naming the test and finding.
   - Recovery hint provides `Resume at Red tests` and does not suggest Plan.
3. **Blocker Round Accepted**:
   - A Review round with a `blocker` finding has a test that fails on the current tree.
   - Test is accepted, and `implementStage` runs to resolve it.
4. **Blocker Lacking Failing Test**:
   - A Review round with a `blocker` finding where all new tests pass on the current tree stops with an error indicating the blocker has no failing test.
5. **Mixed Round**:
   - A round with one `blocker` test (fails on current tree) and one `missing-test` test (passes on current tree, fails at `origRedSha`) accepts both tests and proceeds to `implementStage`.
6. **Persistent Loop Limit**:
   - With `maxLoops = 1`, running 1 fix loop, stopping, and resuming leads to `REVIEW NOT RESOLVED` on the next Review failure rather than allowing a second fix loop.
7. **Restart Reset**:
   - Restarting from Spec resets the fix loop counter to 0.
8. **Initial Red Tests Preserved**:
   - In a non-fix-loop Red tests stage, passing tests before implementation still trigger the `red-passing.md` stop and suggest Plan.
9. **Documentation**:
   - `docs/PLAN.md` includes the Review fix loop section.
   - `CHANGELOG.md` reflects the fix-loop red gate and loop count improvements.
