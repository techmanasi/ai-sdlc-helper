# Decisions for fix-loop-red-gate-kind

## Round 1 (2026-11-18)


### Q1: Recording Implement skipped in decisions.md
The brief states (line 36): "If no new test fails on the current tree (every finding was `missing-test` and every test is accepted), the run commits and locks the tests and goes straight to Review. Implement does not run, because there is nothing for it to make green. The run output and `decisions.md` say so."

In `ai-sdlc-helper`, `decisions.md` is used exclusively for developer answers recorded during Spec question rounds (`recordAnswers` in `src/pipeline/stages.ts`), formatted with `# Decisions for <slug>` and `## Round <n>`. No pipeline execution stage currently writes to `decisions.md`. Writing arbitrary status notes to `decisions.md` could interfere with `recordAnswers` or `specStage` parsing. Should the pipeline write a note to `decisions.md` (and if so, what section/format should it use), or should it only report it to the run output (`run.out` / stdout) and `logs/review-rounds.json`?
**Suggested:** Do not modify `decisions.md`. Report that Implement was skipped in the run output (`run.out` / stdout) and record it in `logs/review-rounds.json` outcome/details.
**Answer:** Agree: do not write decisions.md. specStage counts its '## Round' headings and only recordAnswers writes it. Report the skip in the run output (one line: 'Implement skipped: no new test fails on the current tree; every accepted test covers a missing-test finding') and record it in logs/review-rounds.json on that round (an outcome such as 'implement-skipped' with the accepted test files), so the run page's Review rounds panel shows it. Update the brief's wording in the spec accordingly.

### Q2: Preserving fix-loop state when resuming at Red tests
The brief states (line 38): "Diagnosis. A red-gate stop in a fix loop gets its own hint naming the rejected tests and their findings. Recovery offers 'Resume at Red tests'. It never offers Plan, Spec or 'Resume at Implement' for a fix-loop stop."

When the developer runs the suggested recovery command `ai-sdlc-helper start <slug> --from red-tests`, a fresh process starts at `redTestsStage`. Currently, `fixing` is only true when `ctx.promptExtra?.REVIEW_FINDINGS` is set in memory by `fixCycle`. In a resumed process with `--from red-tests`, `promptExtra` is empty, so `redTestsStage` would treat the run as an initial Red tests run (stripping Implement commits via `testsPassAt` and suggesting Plan on failure) instead of running the fix-loop red gate, and the agent prompt would not receive the Review findings.
Should `redTestsStage` (or pipeline setup) detect that the latest round in `logs/review-rounds.json` has open findings and automatically restore `promptExtra.REVIEW_FINDINGS` and set `fixing = true`?
**Suggested:** Yes: when starting with `--from red-tests` (or during pipeline setup), if `logs/review-rounds.json` contains an active review round with open findings, restore `promptExtra.REVIEW_FINDINGS` from those findings so `fixing` is true and the Red tests agent receives the review findings in its prompt.
**Answer:** Yes, with limits. On a start at Red tests (--from red-tests or the 'Resume at Red tests' recovery), if the last round in logs/review-rounds.json has open findings and its outcome is not final (not passed, not stopped for the loop limit), rebuild promptExtra.REVIEW_FINDINGS with the same findingsText(round, findings) fixCycle uses, so fixing is true and the prompt matches the fix loop exactly. Do this in one helper called where the run starts at Red tests, not inside redTestsStage's gate logic. A fresh run, or one whose last round passed, starts Red tests as usual. The loop count is read from the same file (problem 3), so a resume does not reset it. Add a test: a fix-loop red-gate stop, then start --from red-tests, runs the fix-loop gate (no strip of Implement commits, no Plan hint) and the agent prompt holds the findings.

## Round 2 (2026-11-27)

### Q3: Cases in a modified test file
When a fix-loop edit adds or changes one test in an existing file, which cases should count toward the gate? The runner reports every case in the file, and the existing title check can recognize an old name but cannot tell whether its assertion changed. Counting every case can reject an untouched passing test as vacuous or let an untouched failure satisfy a blocker.
**Suggested:** Count only newly added or modified cases. Allow additions with unique names in existing files, and require changed assertions to use a new unique runner-visible name so the gate can distinguish them from unchanged cases across supported runners.
**Answer:** accept

### Q4: Original red commit cannot load a test file
Should a passing case count as a missing-test regression when its file cannot load at `origRedSha` because it imports a module introduced by Implement? The existing acceptance fixture uses a top-level import of `src/sum.mjs`, which does not exist at that commit. The runner can report a suite error in that situation without a failed result for the named case. Treating the suite error as proof for every case in the file could also accept cases that exercise unrelated behavior.
**Suggested:** Require a failed result for the same named case at `origRedSha`. Put imports of implementation-only modules inside the affected cases so the runner can report their failures individually, and update the acceptance fixtures to exercise that path.
**Answer:** accept
