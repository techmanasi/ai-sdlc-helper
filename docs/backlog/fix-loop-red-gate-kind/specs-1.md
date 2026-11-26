# Specification: fix-loop-red-gate-kind

## 1. Overview & Objectives

In the Review fix loop (`src/pipeline/review-gate.ts`, `reviewLoop` and `fixCycle`), unresolved review findings are returned to the Red tests stage to author regression tests or missing tests before code modifications are made in the Implement stage. Currently:
1. The red gate applies a blanket requirement demanding that every new test fail on the current working tree. While appropriate for `blocker` findings, this causes all `missing-test` findings (which assert already built behaviour that passes on current code) to fail the red gate.
2. The diagnostic hint falls back to a generic syntax or test-runner error, and recovery incorrectly suggests returning to Plan or resuming at Implement.
3. Resuming at Red tests via `ai-sdlc-helper start <slug> --from red-tests` loses the fix-loop context because review findings are not restored in the execution context.
4. The review loop limit (`review.maxLoops`) resets to 0 on every pipeline process invocation instead of tracking cumulative loops across starts for the run.

This specification defines the behavior for:
- Evaluating new tests individually based on test execution results (at the current tree and at the original test commit before implementation), accommodating both `blocker` and `missing-test` findings.
- Skipping the Implement stage and advancing directly to Review when every accepted test covers `missing-test` findings and no test fails on the current tree.
- Restoring fix-loop context and review findings when resuming at Red tests.
- Tracking fix loop iterations persistently across resumes via `logs/review-rounds.json`, and resetting loop counts on a restart from Spec/Plan or discard.
- Providing targeted diagnoses and recovery options for fix-loop red-gate stops.
- Preserving existing behavior for initial (non-fix-loop) Red tests stages and all other pipeline stages.

---

## 2. Scope & Affected Components

- **`src/pipeline/stages.ts`**:
  - `redTestsStage`: Branch logic for `fixing` (when review findings are present in context). Per-test evaluation against the current tree and original test baseline (`origRedSha`), validation that blocker findings have at least one failing test, rejection of vacuous tests, skipping Implement if no test fails, and locking and committing tests.
- **`src/pipeline/review-gate.ts`**:
  - `findingsText`: Updated prompt guidance tailored per finding kind (`blocker` vs `missing-test`).
  - `fixCycle`: Handling of skipped Implement (bypassing the Implement and Test repair stages), recording outcome and accepted test files in `logs/review-rounds.json`.
  - `reviewLoop`: Tracking loop count across process starts using historical rounds in `logs/review-rounds.json`.
- **`src/pipeline/run.ts`**:
  - Pipeline startup helper on `--from red-tests` to detect open review findings in the latest round of `logs/review-rounds.json` and restore review findings to the context.
  - Setting aside and archiving `review-rounds.json` when restarting from Spec or Plan.
- **`src/pipeline/hints.ts`**:
  - `stageRecoveryHint`: Dedicated diagnosis and recovery hint for fix-loop red-gate failures. Recommends "Resume at Red tests"; strictly omits Plan, Spec, and "Resume at Implement".
- **`docs/PLAN.md` & `CHANGELOG.md`**:
  - Documentation updates describing the Review fix loop, gate behavior per finding kind, and persistent loop counting.

---

## 3. Detailed Behaviour

### 3.1. Findings Prompt for Red Tests
When constructing the prompt for the Red tests agent in a fix loop, findings must be categorized and instructed by kind:
- **For `blocker` findings**: The agent is instructed to write tests verifying the required behavior that currently **fail** against the codebase for the stated reason. If a blocker finding is already satisfied by the codebase, it requires no test but should be reported as a wrong finding.
- **For `missing-test` findings**: The agent is instructed to write tests verifying the already built behavior that currently **pass** against the codebase (asserting behavior added during implementation).

### 3.2. Fix-Loop Red Gate Evaluation
In a fix loop (`fixing` is true), the red gate evaluates each new or modified test individually based on test execution results:
1. **Execution on Current Tree**:
   - Run the new or modified test files against the current working tree (which contains the current implementation commits).
   - Record per-test status (pass or fail) from the test runner output.
2. **Execution at Baseline (`origRedSha`)**:
   - For each new test that **passes** on the current tree, verify whether it fails when executed against `origRedSha` (the test commit prior to any implementation commits on the task branch) with the new test files overlaid on top of it.
3. **Acceptance Criteria per Test**:
   - **Accepted as a blocker test**: The test **fails** on the current tree.
   - **Accepted as a missing-test test**: The test **passes** on the current tree AND **fails** at `origRedSha` (demonstrating that it exercises behavior introduced by implementation commits).
   - **Rejected (vacuous test)**: The test **passes** on the current tree AND **passes** at `origRedSha`. It asserts pre-existing baseline behavior and proves nothing about the task or findings.
4. **Round-Level Gate Conditions**:
   - **Vacuous Tests Stop**: If any new test passes both on the current tree and at `origRedSha`, the run stops. The stop message lists the rejected test(s) (file and test name) and the round's open findings.
   - **Blocker Test Requirement**: If the round contains at least one `blocker` finding, at least one new test must fail on the current tree. If no new test fails on the current tree while a blocker finding remains open, the run stops stating that the blocker has no failing test, naming the open blocker findings.
   - **No Tests Added**: If no new or modified test files were produced, the run stops as in standard red tests.

### 3.3. Implement Skipping Logic
- If every open finding was `missing-test` and all new tests are accepted (every new test passes on the current tree, fails at `origRedSha`, and no test fails on the current tree):
  - The tests are staged, committed, and locked.
  - The pipeline outputs a single line to standard output / run output:
    `Implement skipped: no new test fails on the current tree; every accepted test covers a missing-test finding`
  - The round entry in `logs/review-rounds.json` is updated with outcome `implement-skipped` along with the list of accepted test files.
  - The Implement and Test repair stages are bypassed; execution proceeds directly to the Review stage.
  - Per Decision 1, `decisions.md` is **not** modified.
- If at least one test fails on the current tree:
  - The tests are staged, committed, and locked.
  - The Implement stage executes normally so the implement agent can make the failing tests pass.

### 3.4. Pipeline Resumption & Context Restoration (`--from red-tests`)
When the pipeline starts at Red tests (via `ai-sdlc-helper start <slug> --from red-tests` or the "Resume at Red tests" recovery action):
- Before executing the Red tests stage, the pipeline checks `logs/review-rounds.json`.
- If `logs/review-rounds.json` exists and the latest round contains open findings whose outcome is not final (neither passed nor stopped due to reaching `maxLoops`):
  - Reconstruct the review findings prompt text using the round's findings.
  - Set `fixing` to true in the execution context, matching the fix-loop environment.
  - This ensures the Red tests agent receives the review findings in its prompt, prevents stripping implementation commits, and routes gate checks through the fix-loop gate rather than the initial red gate.
- If there are no open review rounds, or the last round was already resolved/passed, Red tests runs as a fresh initial stage.

### 3.5. Review Loop Counting Across Starts
- Fix loops are counted over the entire run by inspecting historical entries in `logs/review-rounds.json` rather than initializing a local counter to 0 on each process start.
- When a review round with findings begins:
  - If the cumulative count of prior fix loops has reached `review.maxLoops`, the run halts immediately with:
    `REVIEW NOT RESOLVED after <maxLoops> fix loop(s): <n> finding(s) still open. This needs you:`
    listing the open findings and manual recovery commands.
  - Otherwise, the loop count increments, the round outcome records `fix loop <loops> of <maxLoops>`, and the fix cycle begins.
- Resuming a run that stopped within a fix loop continues that existing fix loop without incrementing the loop count again.

### 3.6. Reset and Archiving on Restart and Discard
- **Restart from Spec or Plan**:
  - When restarting the pipeline from Spec or Plan (`--from spec` or `--from plan`), `logs/review-rounds.json` is archived to `logs/previous/<timestamp>/` using the file set-aside mechanism.
  - When the pipeline reaches Review later in the run, `review-rounds.json` begins fresh, resetting the loop count to 0.
- **Discard**:
  - Discarding removes the run state and worktree. A subsequent run starts with clean logs, resetting the loop count to 0.

### 3.7. Diagnosis and Recovery Hints
- In `src/pipeline/hints.ts`, detect fix-loop red-gate failures from the run output (matching fix-loop red-gate failure markers).
- **Diagnosis**:
  - Explicitly states that a fix-loop test was rejected or a blocker lacked a failing test, identifying the rejected tests and open findings.
- **Recovery Actions**:
  - Automatic Action: "Resume at Red tests" (`ai-sdlc-helper start <slug> --from red-tests`).
  - Manual Action: Directs the developer to `logs/tests.log` and instructs fixing the test assertions for the specific findings.
  - Escape Hatch: None. The recovery hint must never offer Plan, Spec, or "Resume at Implement" for a fix-loop stop.

### 3.8. Preservation of Initial Red Tests Stage & Other Stages
- **Initial Red tests stage** (when `fixing` is false) remains strictly unchanged:
  - Strips implementation commits if resuming an initial run.
  - Demands that all new tests fail on baseline.
  - Flags vacuous tests against base commit and stops with `red-passing.md` pointing to Plan.
- **Implement, Test repair, Review rounds, Finalise, and CI checks**:
  - Operate unchanged, except for skipping Implement and Test repair when all accepted tests cover missing-test findings.

---

## 4. Inputs & Outputs

### 4.1. File Inputs
- `logs/review-rounds.json`: Read on pipeline startup and within the review loop to inspect previous rounds, open findings, and past loop counts.
- `logs/tests.json`: Read to extract per-test outcomes (test name, test file path, and pass/fail status) on the current tree and at `origRedSha`.
- `logs/tests.log`: Test execution log from running the test runner.

### 4.2. File Outputs
- `logs/review-rounds.json`:
  - Appended and updated on each Review round.
  - When Implement is skipped, records outcome `implement-skipped` and the list of accepted test files.
- `logs/red.json`: Snapshot of test results recording failing tests when entering Implement.
- `docs/PLAN.md`: Updated with a dedicated section on the Review fix loop and gate behavior.
- `CHANGELOG.md`: Updated under `[Unreleased]` with details of the fix-loop red gate and loop limit persistence.
- `decisions.md`: Not modified by this feature.

### 4.3. Console & Log Messages
- When Implement is skipped:
  ```text
  Implement skipped: no new test fails on the current tree; every accepted test covers a missing-test finding
  ```
- When a vacuous test is rejected in a fix loop:
  ```text
  RED GATE FAILED: test(s) already pass at base commit and on current code:
    <file> :: <test name>
  Open findings:
    [missing-test] <file>: <criterion>: <reason>
  ```
- When a blocker finding lacks a failing test:
  ```text
  RED GATE FAILED: blocker finding has no failing test on current code.
  Open blocker findings:
    [blocker] <file>: <criterion>: <reason>
  ```
- When review loop limit is reached:
  ```text
  REVIEW NOT RESOLVED after <maxLoops> fix loop(s): <n> finding(s) still open. This needs you:
    [<kind>] <file>: <criterion>: <reason>
  Fix them by hand, then resume at Review: ai-sdlc-helper pipeline <slug> --from review (or at Implement: ai-sdlc-helper pipeline <slug> --from implement)
  ```

---

## 5. Error Cases & Edge Cases

1. **Test passes on current tree and passes at baseline (`origRedSha`)**:
   - The test is rejected as vacuous.
   - Run stops with fix-loop red-gate error naming the test and finding.
   - Hint offers "Resume at Red tests" and does not offer Plan.
2. **Round has blocker findings, but all tests pass on current tree**:
   - Run stops with message stating the blocker has no failing test.
   - Hint offers "Resume at Red tests".
3. **Round has mixed blocker and missing-test findings**:
   - Blocker tests fail on current tree; missing-test tests pass on current tree and fail at `origRedSha`.
   - Both tests are accepted. Because at least one test is failing on current tree, the Implement stage executes.
4. **Resumed run at Red tests (`--from red-tests`) with active review findings**:
   - Detects open review findings in `logs/review-rounds.json`.
   - Restores findings in context and sets `fixing` to true.
   - Evaluates tests using fix-loop red gate without stripping implementation commits.
5. **Resumed run at Red tests without prior review findings**:
   - Evaluates tests as a standard initial Red tests stage.
6. **Cumulative max loops reached across multiple process starts**:
   - Loops are counted across starts from `logs/review-rounds.json`.
   - If cumulative count reaches `review.maxLoops`, the run halts with `REVIEW NOT RESOLVED`.
7. **Restart from Spec or Plan**:
   - `logs/review-rounds.json` is archived to `logs/previous/<timestamp>/`.
   - The review loop counter resets to 0.

---

## 6. Acceptance Criteria

1. **Missing-Test Round**:
   - In a Review round with only `missing-test` findings, tests that pass on current tree and fail at `origRedSha` are accepted.
   - Tests are committed and locked.
   - Implement stage is skipped; the skip message is printed to run output.
   - `logs/review-rounds.json` records outcome `implement-skipped` and lists accepted files.
   - The pipeline proceeds directly to Review.
2. **Vacuous Missing-Test Rejected**:
   - A `missing-test` test that passes on current tree and also passes at `origRedSha` is rejected.
   - Run stops, naming the test and finding.
   - Recovery hint provides "Resume at Red tests" and never suggests Plan or Spec.
3. **Blocker Round Accepted**:
   - In a Review round with a `blocker` finding, a test that fails on the current tree is accepted.
   - Implement stage runs to make the test pass.
4. **Blocker Lacking Failing Test**:
   - In a Review round with a `blocker` finding, if all new tests pass on the current tree, the run stops stating the blocker has no failing test.
5. **Mixed Round**:
   - A round with one `blocker` test (fails on current tree) and one `missing-test` test (passes on current tree, fails at `origRedSha`) accepts both tests and proceeds to Implement.
6. **Persistent Loop Limit**:
   - With `maxLoops` set to 1, running 1 fix loop, stopping, and resuming leads to `REVIEW NOT RESOLVED` upon subsequent Review failure rather than starting an extra fix loop.
7. **Restart Reset**:
   - Restarting from Spec or Plan archives `logs/review-rounds.json` and resets the fix loop counter to 0.
8. **Initial Red Tests Preserved**:
   - In a non-fix-loop Red tests stage, passing tests before implementation still trigger the `red-passing.md` stop and suggest Plan.
9. **Documentation**:
   - `docs/PLAN.md` includes the Review fix loop section.
   - `CHANGELOG.md` reflects the fix-loop red gate and loop count improvements.

---

## 7. Dependencies

No new external packages or dependencies are required for this feature.
