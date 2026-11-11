# Decisions for ci-full-suite-gate

## Round 1 (2026-11-09)

### Q1: Name, values and precedence of the setting
The brief asks for a project setting, a personal setting and an environment override, but does not name any of them. Personal config today only accepts agent settings (`harness`, `model`, `effort`, `stages`) and the overrides `worktreeBase` and `maxParallel`. The new key has to be added somewhere, and the order of precedence has to be fixed.
**Suggested:** `tests.fullSuite: "local" | "ci"` in `sdlc.config.json` (default `"local"`, which is today's behaviour). The personal setting is a new override `fullSuite` next to `worktreeBase`/`maxParallel`. The environment override is `SDLC_FULL_SUITE=local|ci`. Precedence: environment, then personal, then project. An invalid value is a config error in the same style as the other enum settings.
**Answer:** accept

### Q2: When exactly the branch is pushed and the draft PR opened
The brief says to push and open the draft PR "when Red tests starts", so that CI "begins on the red tests at once". At the start of Red tests the branch has no tests yet (they are committed only after the red gate), so a push at that point gives CI only the spec and plan docs.
**Suggested:** Push and open the draft PR right after the red-tests commit (red gate passed, tests locked), before Implement starts. If the red gate fails, nothing is pushed.
**Answer:** accept

### Q3: Implement must commit and push for CI to see its work
Today nothing from Implement is committed until Finalise, which makes a single `feat(<slug>)` commit of the files that changed since the baseline. CI only sees pushed commits, so Implement has to commit and push before it can wait for CI. This changes the commit history Finalise produces.
**Suggested:** With the setting on, an Implement attempt whose local scoped tests pass commits the changed files. It uses Finalise's rules (baseline-filtered, with secrets, generated and large files skipped) and the message `feat(<slug>): implement (attempt N)`. It then pushes. Finalise commits only what is left (for example Review's changes), pushes, and marks the PR ready. No squashing.
**Answer:** accept

### Q4: What "CI is green" means
Is the gate all checks reported for the PR head commit, only required checks, or specific workflows? The answer also decides how skipped or neutral checks count and how "no workflow" is detected.
**Suggested:** Green means every check run and status reported for the exact pushed head commit has finished, each as success, skipped or neutral. Pending or queued checks keep the wait going. If no check is registered for the head commit within 3 minutes of the push, CI is treated as unavailable (no workflow) and the run falls back as in Q8.
**Answer:** Green means every check run and status reported for the exact pushed head commit has finished, each as success, skipped or neutral. Pending or queued checks keep the wait going. If no check is registered for the head commit within 3 minutes of the push, CI is treated as unavailable (no workflow) and the run falls back as in Q8. Add a project level config to allow certain tests or entire test files to fail to accommodate known flaky tests

### Q5: How a CI failure is classified as side effect, pre-existing, flaky or infrastructure
The brief puts the classification at test level: "a test that passed on main and fails on the branch". CI reports at check (job) level, and test names in CI logs depend on the runner. The brief also does not say how "failing on the base commit" is learned: from CI's result on main, or by running the tests on the base commit. Nor does it say how flaky or infrastructure failures are recognised.
**Suggested:** The base is `git.base` (default `main`), and its commit is the merge-base of the branch with it. Each failed check is classified as follows:
- **Infrastructure:** its conclusion is cancelled, timed_out or startup_failure, or its log has no test output.
- **Pre-existing:** the check with the same name also failed on CI's latest completed run for the base commit.
- **Flaky:** otherwise the failed jobs are re-run once, and the check passes on that re-run.
- **Side effect:** what is left.

Implement is given the failed-log output of side-effect checks only. If CI has no result for the base commit, the failure counts as a side effect.
**Answer:** accept

### Q6: What happens to failures that "do not block"
Pre-existing, flaky and infrastructure failures are "reported and do not block". Does Implement then count CI as green, and where is the report kept?
**Suggested:** Yes. When only non-blocking failures remain, Implement ends green with a WARNING line for each one. They are listed in `<docs>/logs/ci-failures.md`, which gives the check name, the classification and a link to the run. The web run page shows them too.
**Answer:** Yes. When only non-blocking failures remain, Implement ends green with a WARNING line for each one. They are listed in `<docs>/logs/ci-failures.md`, which gives the check name, the classification and a link to the run. The web run page shows them too Add a project level config to allow certain tests or entire test files to fail to accommodate known flaky tests

### Q7: How CI fixes count against the attempt limit
"Within its normal attempt limit" could mean that each CI round uses one Implement attempt, or that CI rounds have a limit of their own.
**Suggested:** Each attempt is: agent run, local scoped check, commit and push, CI wait. A CI round with side-effect failures uses up that attempt, and the next attempt's agent gets the CI failures. When the attempts run out with CI still red from side effects, the stage fails in the same way as when the local tests stay red today.
**Answer:** Implement attempts run only the red tests until all red-tests pass, then push changes, wait for ci to pass, if any failures, pass them on to the implement with the details of failures, where implement run them along with with red-tests in each round

### Q8: When fallback is decided and how long it lasts
CI can be unreachable for several reasons: no remote, gh missing or not authenticated, push or PR creation failing, or no workflow. Does the run decide this once, at Red tests, and then use local full-suite runs for the rest of the run? Or does it check again at each push?
**Suggested:** The check happens at the first push or draft PR after Red tests. If CI is unreachable, the run prints `CI unavailable (<reason>): running the full suite locally` and behaves as if the setting were off for the rest of the run. That covers Implement, Test repair and Review. The fallback is recorded in the run status so the web UI can show it. If a later push or CI query fails after CI was reachable, the run pauses with a recovery hint (as for a timeout) and never reports green.
**Answer:** accept

### Q9: Wait timeout: name, default, polling interval and resume
The brief requires a timeout setting and a pause with a recovery hint, but gives no name, default or polling interval. It also does not say what resuming does.
**Suggested:** `ci.waitMinutes` in project config, with a personal override `ciWaitMinutes` and the environment variable `SDLC_CI_WAIT_MINUTES`. The default is 60. CI is polled every 60 seconds, matching the existing PR status cache time. On timeout the run pauses (exit code 2) with the hint `resume with FROM=implement`. On resume, if the branch head is unchanged and was already pushed, the run waits for CI on that head before running any agent.
**Answer:** accept

### Q10: Which tests run locally in each stage with the setting on
"Only the new or changed test files" run locally. Does that apply only to Implement, or also to the preliminary run, Test repair's checks and Review's post-check? Those three run the full suite locally today. Does the integration suite (`integration.cmd`) still run locally? And does anything wait for CI again after Review?
**Suggested:** With the setting on, every local gate runs only the task's red test files (the red-tests commit, plus the Test repair commit if there is one). That covers the preliminary run, which is forced to scoped, as well as Implement, Test repair and Review. `integration.cmd` still runs locally. Only Implement waits for CI. Review pushes its changes but does not wait, and the PR's CI after that is for the human reviewer.
**Answer:** With the setting on, every local gate runs only the task's red test files (the red-tests commit, plus the Test repair commit if there is one). That covers the preliminary run, which is forced to scoped, as well as Implement, Test repair and Review. `integration.cmd` still runs locally. Only Implement waits for CI. Review pushes its changes but does not wait, and the PR's CI after that is for the human reviewer. Any stage that need full suit run either now or in future can use ci for it.

### Q11: The draft PR and the existing createPr option
Finalise creates a PR only when `SDLC_CREATE_PR=1` or the run's `createPr` option is set. Is the draft PR opened even when createPr is off? Does Finalise then mark it ready anyway? What happens when the branch already has a PR (open, draft or not)?
**Suggested:** With the setting on, the draft PR is always opened (createPr does not matter), and its link is recorded in `brief.md` as today. Finalise reuses it and marks it ready (`gh pr ready`), even when createPr is off. If the branch already has an open PR, it is reused as it is and not converted to draft. If the PR is closed or merged, CI is treated as unavailable (Q8).
**Answer:** accept

### Q12: What the web run page shows
The brief asks for "the CI state on the run page" but does not list the states or details to show.
**Suggested:** On the run page, a CI line with the PR link (draft or ready) and one state from: `waiting`, `running`, `green`, `red: side effect` (with the failing checks), `green with warnings` (the non-blocking failures from Q6), `timed out (paused)`, `unavailable: running locally` (with the reason). It is updated through the existing PR status refresh. With the setting off, nothing new is shown.
**Answer:** On the run page, a CI line with the PR link (draft or ready) and one state from: `waiting`, `running`, `green`, `red: side effect` (with the failing checks), `green with warnings` (the non-blocking failures from Q6), `timed out (paused)`, `unavailable: running locally` (with the reason). It is updated through the existing PR status refresh. With the setting off, nothing new is shown. In the UI send outputs to clearly differentiate between the following Round 1: implement - agent {name} is running implement with model {model-name} and effort {effort-level} Preliminary red tests -  running locally Preliminary red-test run failed Round 2: implement - agent {name} is running implement with model {model-name} and effort {effort-level} Preliminary red tests -  running locally Preliminary red-test run failed Running full suite in CI //if enabled in settings start time: Y-m-dTH:i:s end time: Y-m-dTH:i:s status: Red - 3 tests failed in CI // add better summary Round 3: implement - agent {name} is running implement with model {model-name} and effort {effort-level} Preliminary red tests -  running locally Preliminary red-test run failed Running full suite in CI //if enabled in settings start time: Y-m-dTH:i:s end time: Y-m-dTH:i:s status: Green - 50 tests executed in CI in 10 minutes // add better summary

## Round 2 (2026-11-09)

### Q1: Shape and reach of the "allowed to fail" config
The Q4 and Q6 answers add a project-level config listing tests or whole test files that may fail (known flaky). It has no name, no entry format, and no stated reach. It is not clear whether it covers only CI results or also the local gates. Nor is it clear how an allowed failure is reported, or whether a check whose only failures are allowed tests counts as green. Without these the gate can't be built or tested.
**Suggested:** `tests.allowFailures: string[]` in `sdlc.config.json`, project config only (no personal or environment override). Each entry is either a test file path from the project root (globs allowed, e.g. `test/e2e/*.test.ts`) or `<file> > <test name>` for a single test, where the name is the full name the runner reports. An invalid entry (not a string, or empty) is a config error in the same style as the other settings. It applies to both CI results and every local gate. A failure that matches an entry is non-blocking with the classification `allowed`. It gets a WARNING line and is listed in `<docs>/logs/ci-failures.md` (or the local test log) like the other non-blocking failures from Q6. A failed CI check counts as non-blocking when every failed test in it is allowed. The red tests from the Red tests commit can never be allowed: an entry that matches one is ignored, with a WARNING.
**Answer:** accept

### Q2: How test-level results are read from CI
Several answers need per-test CI results, but Q5 classifies failures per check (job):
- Q1's per-test allow list.
- Q7: Implement runs the CI-failing tests locally along with the red tests.
- Q12's summaries ("3 tests failed in CI", "50 tests executed").

`gh` gives only check conclusions and raw job logs, and log formats depend on the runner and the workflow. The pipeline needs a dependable source of test results. It also needs to know what happens when that source is missing.
**Suggested:** CI uploads the runner's JSON report (the format the pipeline already parses locally for jest, vitest and node:test) as a workflow artifact named `sdlc-test-report`. The README documents the workflow step to add. The pipeline fetches it for the head commit's run with `gh run download`. With the report, failures are handled per test:
- **Pre-existing:** the same test (file and name) also failed in the base commit's report.
- **Flaky:** the test failed and passed on the single re-run of the failed jobs.
- **Allowed:** the test matches Q1.
- **Side effect:** the rest.
- Infrastructure is still decided per check, as in Q5.

Without the artifact (or if it can't be parsed), the pipeline uses Q5's check-level classification. It prints `CI test report not found: classifying by check` once. Test counts are shown as unknown, per-test allow entries can't match (whole-file entries match only if the check log names the file), and no CI test files are added to the local gate. The agent gets the failed-log output instead.
**Answer:** accept

### Q3: Attempt budget and local gate in the Implement CI loop
Q7's answer: Implement runs only the red tests until they pass, then pushes and waits for CI. Failures go back to Implement, which runs them along with the red tests in later rounds. Some details are still open:
- Does a CI round use up an attempt, or do CI rounds have a limit of their own?
- Which tests make up the local gate after a CI round?
- What happens when the attempts run out while CI is red?
**Suggested:** One budget, `MAX_ATTEMPTS` (default 4). Each round is one attempt:
1. Agent run.
2. Local gate: the red test files plus the test files of every side-effect failure from earlier CI rounds, then `integration.cmd`.
3. Only if the local gate passes: commit (Q3, round 1), push, and wait for CI.

If the local gate fails, CI is not run that round, and the next round's agent gets the local failures. If CI has side-effect failures, the next round's agent gets those failures (check, file, test name, message, run link) and the local test files above. Implement ends green only when the local gate and CI are both green, or CI has only non-blocking failures. When the attempts run out, the stage fails with `GREEN GATE FAILED after N attempts`, and the latest CI failures are in the fail log. Test repair rules stay the same.
**Answer:** accept

### Q4: Exact per-round output in the CLI and web UI
The Q12 answer sketches per-round output and asks for "a better summary", but leaves these points open:
- Is "agent {name}" the harness (`claude`) or the agent run name (`impl-2`)?
- Are times local or UTC?
- Does the CI block appear after a failed local run? The sketch shows CI after "Preliminary red-test run failed", which conflicts with Q7.
- What goes into the summary?
- Is the output shown only in the web UI, or also in the CLI log the UI shows?
**Suggested:** The CLI prints these lines, and the web run page shows the same lines from the run log, with each round set off as its own block:
```
Round 2: implement
  agent claude is running implement with model opus and effort high
  Red tests: running locally (5 files)
  Red tests: passed locally (12 tests)            | Red tests: failed locally (2 of 12 tests failed)
  Full suite in CI: running (PR #12, commit abc1234)
  start time: 2026-11-09T14:03:12  end time: 2026-11-09T14:13:40  (10m 28s)
  status: Red - 3 of 50 tests failed in CI: 2 side effect, 1 pre-existing (checks: test, e2e)
  status: Green - 50 tests executed in CI in 10m 28s (2 skipped, 1 allowed failure)
```
- The agent name is the harness, with the resolved model and effort.
- Times are local time, in `YYYY-MM-DDTHH:mm:ss`.
- The "Full suite in CI" lines appear only when the setting is on, CI is available, and the local gate passed that round.
- Without a test report (Q2), the counts are replaced by check counts, e.g. `Red - 1 of 3 checks failed in CI`.
- The other statuses use the same pattern: `Timed out after 60m (paused)` and `Unavailable (<reason>): running the full suite locally`.
**Answer:** accept

### Q5: "Any stage that needs a full-suite run can use CI"
The Q10 answer adds: "Any stage that needs a full-suite run, now or in the future, can use CI for it." It also accepts that only Implement waits for CI and Review does not. This could mean one of two things:
- **Design rule:** build the push, wait and classify steps as one reusable step, used only by Implement for now.
- **Behaviour change:** other stages (for example Review's post-check, or Test repair) must also wait for CI now.
**Suggested:** A design rule. The push, wait and classify steps are one reusable pipeline step that any stage can call. In this feature only Implement calls it. Test repair and Review run their scoped local gates and do not wait. Review pushes its changes as Q10 says.
**Answer:** accept
