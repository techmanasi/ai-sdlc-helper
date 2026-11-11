# Spec: ci-full-suite-gate

Sources: `brief.md` and `decisions.md` (Round 1 and Round 2). Where a Round 2 answer refines a Round 1 answer, Round 2 wins.

## 1. Summary

A new setting, `tests.fullSuite`, chooses where the full test suite runs. With `"local"` (the default) nothing changes. With `"ci"`:

- local gates run only the task's red test files (plus any CI side-effect test files, see 7.3);
- once Red tests passes its gate, the branch is pushed and a draft PR is opened;
- Implement commits and pushes each locally green attempt, then waits for GitHub Actions CI on the pushed head commit;
- CI failures are classified. Only side-effect failures go back to Implement. Pre-existing, flaky, infrastructure and allowed failures are reported and do not block;
- if CI can't be reached, the run says so and runs the full suite locally for the rest of the run.

Out of scope: CI providers other than GitHub Actions through `gh`, changes to how Test repair or Review work (apart from the local gate scope in 6), and making CI faster.

## 2. Configuration

### 2.1 `tests.fullSuite`

| Source | Key | Values |
|---|---|---|
| Project (`sdlc.config.json`) | `tests.fullSuite` | `"local"` \| `"ci"` |
| Personal override (next to `worktreeBase` / `maxParallel`) | `fullSuite` | `"local"` \| `"ci"` |
| Environment | `SDLC_FULL_SUITE` | `local` \| `ci` |

- Default: `"local"` (today's behaviour).
- Precedence: environment, then personal, then project, then default.
- An invalid value in any source is a config error, reported in the same style as the other enum settings (it names the source, the key, the bad value and the allowed values). An empty `SDLC_FULL_SUITE` counts as unset.

### 2.2 `ci.waitMinutes`

| Source | Key |
|---|---|
| Project | `ci.waitMinutes` |
| Personal override | `ciWaitMinutes` |
| Environment | `SDLC_CI_WAIT_MINUTES` |

- Default: 60. Same precedence as 2.1.
- The value must be a whole number of 1 or more. Anything else is a config error in the style of the other numeric settings (e.g. `SDLC_MAX_PARALLEL`).

### 2.3 `tests.allowFailures`

- `tests.allowFailures: string[]` in `sdlc.config.json`. Project config only: no personal or environment override.
- Each entry is one of:
  - a test file path from the project root, globs allowed (e.g. `test/e2e/*.test.ts`), which allows every test in the matching files;
  - `<file> > <test name>`, which allows one test. `<test name>` is the full name the runner reports.
- An entry that is not a string, or is empty, is a config error in the style of the other settings. If the key is present but is not an array, that is also a config error.
- Reach: CI results and every local gate (see 8.4).
- Red tests from the task's Red tests commit can never be allowed. An entry that matches one is ignored for that test, and the run prints a WARNING naming the entry and the test.

### 2.4 Documentation

The README documents `tests.fullSuite`, `ci.waitMinutes`, `tests.allowFailures`, their overrides and precedence, the draft PR, what Implement waits for, and the workflow step that uploads the `sdlc-test-report` artifact (4.4). `docs/web-ui.md` documents the CI line and per-round output on the run page (section 10).

## 3. Behaviour with the setting off

With `tests.fullSuite` resolved to `"local"`:

- no push and no draft PR at the end of Red tests;
- Implement doesn't commit per attempt and doesn't wait for CI;
- the local gates run what they run today;
- the run page shows no CI line and no CI round blocks;
- `tests.allowFailures` still applies to local gates (8.4).

Everything else behaves exactly as before this feature.

## 4. CI availability, draft PR and the CI step

### 4.1 When the draft PR is opened

- The push and draft PR happen right after the red-tests commit (red gate passed, tests locked) and before Implement starts.
- If the red gate fails, nothing is pushed and no PR is opened.
- Red tests never waits for CI. CI failing on the red-tests commit is expected and isn't a gate.

### 4.2 Opening the PR

- The branch is pushed to `origin` with upstream tracking.
- The draft PR is opened against the run's base (`git.base`, default `main`, or the run's recorded base).
- The draft PR is always opened when the setting is on, whatever `createPr` / `SDLC_CREATE_PR` says.
- If the branch already has an **open** PR (draft or ready), it is reused as it is and not converted to draft.
- If the branch's only PR is **closed or merged**, CI counts as unavailable (4.3) with reason `PR is closed` or `PR is merged`.
- The PR link is recorded in `brief.md` the same way Finalise records it today.
- The PR is created once per run. Finalise reuses it (section 9).

### 4.3 Availability check and fallback

The availability check happens at the first push and draft PR after Red tests. CI is unavailable when any of these hold. The reason text is in brackets.

| Condition | Reason |
|---|---|
| no `origin` remote | `no remote` |
| `gh` not installed | `gh not installed` |
| `gh` not authenticated | `gh not authenticated` |
| the push fails | `push failed: <first line of git's error>` |
| PR creation or lookup fails | `PR could not be created` |
| the branch's PR is closed or merged | `PR is closed` / `PR is merged` |
| no check is registered for the pushed head commit within 3 minutes of the push | `no workflow` |

The `no workflow` case is found during the first CI wait in Implement (the first push that has a CI wait after it).

On fallback:

- The run prints `CI unavailable (<reason>): running the full suite locally`.
- For the rest of the run it behaves as if the setting were off. That covers Implement, Test repair and Review, which run the full suite locally as today. Implement doesn't commit per attempt after the fallback point.
- The fallback and its reason are recorded in the run status so that the web UI can show them.
- The run never reports CI green without a CI result.

After CI was found reachable, a later push failure or CI query failure doesn't fall back. The run pauses (exit code 2) with a recovery hint, as for a timeout (5.4), and never reports green.

### 4.4 CI test report artifact

- CI may upload the runner's JSON report as a workflow artifact named `sdlc-test-report`. This is the format the pipeline already parses locally for jest, vitest and node:test.
- The pipeline fetches it for the head commit's run with `gh run download`.
- If the artifact is missing or can't be parsed, the pipeline uses check-level classification (8.2). It prints `CI test report not found: classifying by check` once per run.

### 4.5 One reusable CI step

Push, wait and classify form one reusable pipeline step that any stage can call. Its input is the run context and the commit to check. Its output is one of: green, green with warnings, red with side effects, timed out, or unavailable. In this feature only Implement calls it. Test repair and Review don't wait for CI.

## 5. Waiting for CI

### 5.1 Mechanism

- Waiting reuses the PR status lookup in `src/pipeline/finalise.ts`: `gh`, with its existing timeout and cache. There is no second poller.
- CI is polled every 60 seconds, which matches the PR status cache time.

### 5.2 What "green" means

- The wait is on the exact pushed head commit.
- CI is green when every check run and commit status reported for that commit has finished, each with conclusion success, skipped or neutral.
- Pending, queued or in-progress checks keep the wait going.
- If no check is registered for the head commit within 3 minutes of the push, CI is unavailable with reason `no workflow` (4.3).
- When all checks have finished and at least one has another conclusion, the failures are classified (section 8). After classification, CI counts as green when every failure is non-blocking (green with warnings). It counts as red when at least one side-effect failure remains.

### 5.3 Timeout

- The wait ends when `ci.waitMinutes` passes without CI finishing.
- The run pauses rather than failing: exit code 2, with the recovery hint `resume with FROM=implement`.
- The CLI prints `status: Timed out after <N>m (paused)`, and the run status records the timed-out state.

### 5.4 Resume

On resume with `FROM=implement`:

- If the branch head is unchanged since the pause and was already pushed, the run waits for CI on that head before it runs any agent. This wait doesn't use an attempt (7.2).
- If the head changed or was never pushed, Implement starts normally.

## 6. Local test scope with the setting on

With the setting on and CI available:

- Every local gate runs only the task's red test files: those in the red-tests commit, plus the Test repair commit if there is one. That covers the preliminary run (forced to scoped), Implement, Test repair and Review's post-check.
- Implement's local gate also includes the CI side-effect test files from 7.3.
- `integration.cmd` still runs locally where it runs today.
- Only Implement waits for CI. Review pushes its changes but doesn't wait. CI on the PR after that is for the human reviewer.
- After a fallback (4.3), the local gates go back to today's behaviour.

## 7. Implement with the setting on

### 7.1 Round structure

There is one attempt budget, `MAX_ATTEMPTS` (default 4). Each round uses one attempt and runs these steps:

1. **Agent run.** Its input is the usual Implement input, plus any failures from the previous round (7.3).
2. **Local gate.** Run the red test files, plus the test files of every side-effect failure from earlier CI rounds in this run, then `integration.cmd`.
3. **If the local gate fails:** no commit, no push and no CI this round. The next round's agent gets the local failures.
4. **If the local gate passes:**
   - Commit the changed files using Finalise's rules: baseline-filtered, with secrets, generated and large files skipped. The message is `feat(<slug>): implement (attempt N)`, where N is the attempt number.
   - Push.
   - Wait for CI (section 5) on the pushed head.
   - If nothing changed since the last push (no files to commit), the round doesn't create an empty commit. It waits on the current head, provided that head hasn't already had a CI result.

### 7.2 Ending Implement

- **Green:** the local gate passes and CI is green, or CI has only non-blocking failures. A WARNING line is printed for each non-blocking failure.
- **Out of attempts:** the stage fails with `GREEN GATE FAILED after N attempts`. The fail log holds the latest failures: CI side-effect failures if CI ran last, or local failures if it didn't.
- **Timeout or later CI error:** the run pauses (5.3, 4.3). A pause doesn't count as a failed attempt, and the attempt that was waiting resumes as described in 5.4.
- **Fallback mid-Implement** (`no workflow` on the first wait): Implement goes on under the setting-off rules for its remaining attempts. It reruns the local full suite as today for the current attempt's gate.
- The Test repair rules are unchanged.

### 7.3 Feedback to the next round after CI red

The next round's agent gets:

- for each side-effect failure: the check name, the test file, the test name, the failure message and the run link (with a test report); or the failed-log output of the side-effect checks (without one);
- the list of local test files its gate will run (red tests plus the CI side-effect test files).

Without a test report, no CI test files are added to the local gate.

## 8. Classifying CI failures

### 8.1 Base reference

- The base is `git.base` (default `main`).
- The base commit is the merge-base of the branch with the base.
- "Base results" means CI's latest completed run for the base commit.

### 8.2 Check-level classification (no test report)

Each failed check is classified, in this order:

1. **Infrastructure:** its conclusion is cancelled, timed_out or startup_failure, or its log has no test output.
2. **Pre-existing:** the check with the same name also failed in the base results.
3. **Allowed:** a whole-file `tests.allowFailures` entry matches a file named in the check log, and every failing file the log names is allowed. Per-test entries can't match without a report.
4. **Flaky:** the failed jobs are re-run once, and the check passes on that re-run.
5. **Side effect:** what is left. This includes the case where CI has no result for the base commit.

### 8.3 Test-level classification (with a test report)

- Infrastructure is still decided per check, as in 8.2 step 1.
- For the remaining failed checks, each failed test is classified:
  1. **Pre-existing:** the same test (file and name) also failed in the base commit's report.
  2. **Allowed:** the test matches `tests.allowFailures`. Red tests are never allowed.
  3. **Flaky:** the test failed and then passed on the single re-run of the failed jobs.
  4. **Side effect:** the rest. This includes the case where the base has no report or no CI result.
- A failed check is non-blocking when every failed test in it is non-blocking.
- The failed jobs are re-run at most once per pushed head.

### 8.4 Allowed failures in local gates

- In any local gate, with the setting on or off, a failing test that matches `tests.allowFailures` is non-blocking. It gets a WARNING line and is listed in the local test log.
- If every failing test in the gate is allowed, the gate passes.
- Red tests are never allowed.

### 8.5 Reporting non-blocking failures

- Each non-blocking CI failure gets a WARNING line in the run output.
- Each one is listed in `<docs>/logs/ci-failures.md` with the check name, the test (file and name, when known), the classification (`pre-existing`, `flaky`, `infrastructure` or `allowed`) and a link to the CI run.
- The run page shows them too (section 10).
- Non-blocking failures are never given to the agent to patch.

## 9. Finalise with the setting on

- Finalise commits only what is left (for example Review's changes) using its existing rules, pushes, and marks the existing PR ready with `gh pr ready`. It does this even when `createPr` is off.
- There's no squashing: the per-attempt Implement commits stay in the history.
- Finalise doesn't open a second PR.
- After a fallback, Finalise behaves as today. If a PR was opened before the fallback, Finalise reuses it.

## 10. Output: CLI and web run page

### 10.1 Per-round block

The CLI prints the following lines. The web run page shows the same lines from the run log, with each round set off as its own block:

```
Round <n>: implement
  agent <harness> is running implement with model <model> and effort <effort>
  Red tests: running locally (<k> files)
  Red tests: passed locally (<t> tests)            | Red tests: failed locally (<f> of <t> tests failed)
  Full suite in CI: running (PR #<num>, commit <short sha>)
  start time: <YYYY-MM-DDTHH:mm:ss>  end time: <YYYY-MM-DDTHH:mm:ss>  (<duration>)
  status: <status line>
```

- `<harness>` is the harness name (e.g. `claude`). Model and effort are the resolved values.
- Times are local time in `YYYY-MM-DDTHH:mm:ss`. The duration looks like `10m 28s`.
- The three "Full suite in CI" lines appear only when the setting is on, CI is available, and the local gate passed that round.
- Status lines:
  - `Red - <f> of <t> tests failed in CI: <a> side effect, <b> pre-existing[, <c> flaky][, <d> infrastructure][, <e> allowed] (checks: <names>)`
  - `Green - <t> tests executed in CI in <duration> (<s> skipped, <e> allowed failure[s])`. The parenthesised parts appear only when they apply. Non-blocking failures are listed after the line as WARNINGs.
  - `Timed out after <N>m (paused)`
  - `Unavailable (<reason>): running the full suite locally`
- Without a test report, test counts are replaced by check counts, e.g. `Red - 1 of 3 checks failed in CI`.

### 10.2 CI line on the run page

- With the setting on, the run page shows a CI line with the PR link (labelled draft or ready) and one state:
  - `waiting`
  - `running`
  - `green`
  - `red: side effect`, with the failing checks
  - `green with warnings`, with the non-blocking failures from 8.5
  - `timed out (paused)`
  - `unavailable: running locally`, with the reason
- The line is updated through the existing PR status refresh.
- With the setting off, no CI line and no CI round output are shown.

## 11. Error cases

| Case | Behaviour |
|---|---|
| Invalid `tests.fullSuite`, `fullSuite` or `SDLC_FULL_SUITE` | Config error naming the source and allowed values. The run doesn't start. |
| Invalid `ci.waitMinutes`, `ciWaitMinutes` or `SDLC_CI_WAIT_MINUTES` | Config error. The run doesn't start. |
| Invalid `tests.allowFailures` entry or shape | Config error. The run doesn't start. |
| Allow entry matches a red test | WARNING. The entry is ignored for that test. |
| Red gate fails | No push, no PR. Behaviour as today. |
| No remote, `gh` missing or unauthenticated, push or PR creation fails at first push | Fallback (4.3) with a visible message. |
| PR for the branch is closed or merged | Fallback, with reason `PR is closed` / `PR is merged`. |
| No check within 3 minutes of the push | Fallback, with reason `no workflow`. |
| Push or CI query fails after CI was reachable | Pause (exit 2) with a recovery hint. Never green. |
| CI wait passes `ci.waitMinutes` | Pause (exit 2) with `resume with FROM=implement`. |
| Test report missing or unparsable | `CI test report not found: classifying by check` once. Check-level classification. |
| No CI result for the base commit | Failures count as side effects. |
| Attempts run out with CI red from side effects | `GREEN GATE FAILED after N attempts`. Latest CI failures in the fail log. |

## 12. New packages

None are needed. The feature uses `git` and `gh`, which are already used by the pipeline.

## 13. Acceptance criteria

### Config

1. With no setting anywhere, `tests.fullSuite` resolves to `"local"` and `ci.waitMinutes` to 60.
2. `SDLC_FULL_SUITE` beats the personal `fullSuite`, which beats the project `tests.fullSuite`. The same holds for `SDLC_CI_WAIT_MINUTES` > `ciWaitMinutes` > `ci.waitMinutes`.
3. An invalid value for any of these keys, or an invalid `tests.allowFailures` entry, gives a config error naming the key and the bad value.

### Setting off

4. Red tests opens no PR and pushes nothing. Implement makes no per-attempt commits and doesn't wait for CI. Local gates run as today. The run page shows no CI line.

### Draft PR

5. With the setting on, a passing red gate is followed by a push and a draft PR against the base, before Implement starts. The PR link is written to `brief.md`. Red tests doesn't wait for CI.
6. A failing red gate pushes nothing.
7. With `createPr` off, the draft PR is still opened. Finalise marks it ready with `gh pr ready` and opens no other PR.
8. An existing open PR for the branch is reused without being converted to draft.

### Implement gate

9. With the setting on, Implement doesn't end green until every check for the pushed head commit has finished as success, skipped or neutral, or until all remaining failures are non-blocking.
10. A round whose local gate fails doesn't commit, push or wait for CI. The next round's agent gets the local failures.
11. A round whose local gate passes commits with `feat(<slug>): implement (attempt N)`, pushes and waits.

### Classification

12. A CI test failure that passes in the base commit's results is given to the next Implement round, with check, file, test name, message and run link. Its test file joins the local gate of later rounds.
13. A CI failure that also fails on the base commit is reported (WARNING plus `ci-failures.md` entry) as `pre-existing` and isn't given to the agent.
14. A failure that passes on the single re-run of the failed jobs is reported as `flaky`.
15. A check with conclusion cancelled, timed_out or startup_failure is reported as `infrastructure`.
16. A failure matching `tests.allowFailures` is reported as `allowed` and doesn't block, in CI and in local gates. A matching entry on a red test is ignored with a WARNING.
17. Without the `sdlc-test-report` artifact, the run prints `CI test report not found: classifying by check` once, classifies per check, and shows check counts instead of test counts.

### Attempts, timeout and resume

18. When attempts run out with side-effect failures still present, the stage fails with `GREEN GATE FAILED after N attempts`.
19. When `ci.waitMinutes` passes, the run pauses with exit code 2 and `resume with FROM=implement`. Resuming on an unchanged, pushed head waits for CI before any agent runs.

### Fallback

20. With no remote, or with `gh` missing or unauthenticated, the run prints `CI unavailable (<reason>): running the full suite locally` and runs the full suite locally in Implement, Test repair and Review. The fallback is recorded in the run status.
21. With no check registered within 3 minutes of the push, the run falls back with reason `no workflow`.
22. A push or CI query failure after CI was reachable pauses the run. It never reports green.

### Output and UI

23. Each Implement round prints the round block from 10.1. The "Full suite in CI" lines appear only when the setting is on, CI is available and the local gate passed.
24. The run page shows the CI line with the PR link and the current state, and the per-round blocks, updated through the existing PR status refresh.

### Docs

25. The README and `docs/web-ui.md` describe the settings, the draft PR, the CI artifact step, and what Implement waits for.
