# fix-loop-red-gate-kind

Type: bug
Priority: P1 (high)
Source: User, 2026-11-17, after `review-loop-limit-ui-setting` stopped at the Red tests gate of its Review fix loop: "why red-tests pass before implement? Are you running with the previous stages implement commits? Why is the remove impl commits and run red-tests not working?"

## Problem
The Review fix loop (`src/pipeline/review-gate.ts`, `reviewLoop` and `fixCycle`) sends Review's findings back through Red tests. Red tests applies the same red gate to every finding, whatever its kind. That gate is wrong for `missing-test` findings. When a run stops on it, the diagnosis is wrong too, and the loop limit does not hold across starts.

### 1. The gate does not look at the finding kind
- A `blocker` finding says the code is wrong, so a test for it should fail on the current code. The gate checks exactly that, and is right for this kind.
- A `missing-test` finding says the behaviour is built but has no test, so a correct test for it **passes** on the current code. The gate still demands that it fail, so every `missing-test` finding stops the run.
- How: in a fix loop `fixing` is true (`src/pipeline/stages.ts:286`).
  - The "run the tests without the Implement commits" check, `testsPassAt(ctx, firstRedSha, …)`, is skipped (`stages.ts:303`: `hasImplSince(ctx, firstRedSha) && !fixing`).
  - The tests run on the current tree instead, with the implementation in it.
  - The vacuous-test check uses `baseSha = HEAD` (`stages.ts:287`, `stages.ts:308`), so it rejects the same tests a second time.
- The prompt says the same wrong thing (`review-gate.ts:173`): "a finding that is already satisfied by the code needs no test but is reported as a wrong finding". A `missing-test` finding is satisfied by the code by definition, and asks for a test anyway.
- Evidence (`review-loop-limit-ui-setting`, review round 7): all three findings were `missing-test`. Red tests wrote tests for them, and all 28 passed (`logs/tests.log`). The run stopped with "RED GATE FAILED: new tests pass before implementation", then "a Review finding was wrong or already fixed" (`review-gate.ts:184`).
- Mixed rounds fail as well. Rounds 1, 2, 4, 5 and 6 each had `blocker` and `missing-test` findings together. Whether a round's tests pass depends on the mix, not on whether the tests are right.

### 2. The diagnosis and recovery are wrong
- The plain "RED GATE FAILED: new tests pass before implementation" line matches none of the specific Red tests hints. It falls through to the generic one (`src/pipeline/hints.ts:266-268`): "Test suite failed to run, timed out, or encountered a syntax/runner error". The suite ran fine: 28 passed, 0 failed.
- Recovery offers "Retry Red Tests stage" and "Resume at Implement". A retry hits the same gate. Resuming at Implement drops the tests Review asked for, without any record of dropping them.
- When some, not all, of the new tests already pass, the stop is "already pass before implementation … Fix the spec or plan" and recovery points to Plan (`stages.ts:310-315`, `hints.ts:108`). That is right for the first Red tests stage and wrong in a fix loop: the spec and plan are fine there. The `ui-code-indexer-setup` run stopped this way on 2026-11-17.

### 3. The loop limit resets on every start
- `reviewLoop` reads every recorded round from `logs/review-rounds.json` (`review-gate.ts:206`), but counts fix loops from `let loops = 0` each time it starts (`review-gate.ts:207`). So `review.maxLoops` limits one start, not the run.
- Evidence (`review-loop-limit-ui-setting`, `maxLoops` 2): the recorded outcomes for rounds 1 to 7 are "fix loop 1 of 2", "1 of 2", "2 of 2", "1 of 2", "1 of 2", "2 of 2", "1 of 2". That is five fix loops for one run, across ten starts from the web UI, and the run never reached the "REVIEW NOT RESOLVED" stop that the limit exists for.

## Expected behaviour
- **Gate by test, not by round.** In a fix loop, the red gate accepts each new test that either:
  - **fails on the current tree** (it covers a `blocker`, and Implement must make it pass), or
  - **passes on the current tree and fails at `origRedSha`**, the tests commit before any Implement commit, with the new test files laid over it. This is the existing `testsPassAt` check, used the other way round: it proves the test covers behaviour that Implement added.
- A new test that passes both on the current tree and at `origRedSha` proves nothing. It is rejected, and the stop names the test and the finding.
- If the round has at least one `blocker` finding, at least one new test must fail on the current tree. Otherwise the stop says the blocker has no failing test.
- If no new test fails on the current tree (every finding was `missing-test` and every test is accepted), the run commits and locks the tests and goes straight to Review. Implement does not run, because there is nothing for it to make green. The run output and `decisions.md` say so.
- The findings prompt (`review-gate.ts:172-175`) tells Red tests per kind what to write. For a `blocker`, a test that fails now. For a `missing-test`, a test of the built behaviour that passes now. A `blocker` the code already satisfies is still reported as a wrong finding.
- **Diagnosis.** A red-gate stop in a fix loop gets its own hint naming the rejected tests and their findings. Recovery offers "Resume at Red tests". It never offers Plan, Spec or "Resume at Implement" for a fix-loop stop.
- **Loop limit.** Fix loops are counted over the whole run from `logs/review-rounds.json`, so a resume continues the count. A Restart from Spec or Plan, or Discard, starts the count again. When the count reaches `review.maxLoops`, the run stops with "REVIEW NOT RESOLVED", as it does today within one start.
  - Today nothing in `src/` clears `review-rounds.json` by name; only `review-gate.ts` and `src/runs/view.ts:438` read it. The fix must check how Restart and Discard treat the logs folder, and clear or archive the rounds file there if they leave it in place.

## Must not change (stages that work today)
- **The first Red tests stage** (not in a fix loop) behaves exactly as now. That covers the red gate, `testsPassAt` on resume, `newPassingTests` against `firstRedSha^`, the `red-passing.md` stop pointing to Plan, the test lock and commit, and opening the PR in CI mode. The new behaviour is only on the `fixing` path.
- **Implement, Test repair, Review rounds, Finalise and CI:** no change, apart from Implement being skipped in the one case above.
- **A first start** that never resumes uses the same loop count as today.
- **The hints for other stops** stay the same. The new hint matches only a red-gate stop inside a fix loop.
- The existing tests in `test/pipeline.test.ts`, `test/hints.test.ts`, `test/review-gate.test.ts` and `test/pipeline-resume.test.ts` pass unchanged. Any of them that must change is named in the PR with the reason.

## Decisions
- The gate checks each test's result, not which test belongs to which finding. A test does not have to be mapped to its finding.

## Scope
- In: `redTestsStage` on the `fixing` path (`src/pipeline/stages.ts`); `fixCycle`, `findingsText` and `reviewLoop` (`src/pipeline/review-gate.ts`); the fix-loop hint (`src/pipeline/hints.ts`); skipping Implement when nothing is red.
- Out: how Review decides a finding's kind; the web UI (`ui-orchestration-gaps` covers waiving findings and stage guidance from the UI).

## Tests
These use the pipeline fixture (`test/pipeline-fixture.ts`) with a real git repo, as in `test/pipeline.test.ts`.
- **A `missing-test` round:**
  - The new test passes on the current tree and fails at `origRedSha`.
  - The gate accepts it, Implement is skipped, Review runs next, and the test is committed and locked.
- **A `missing-test` test that also passes at `origRedSha`** is rejected. The stop names the test, and the hint offers Resume at Red tests, not Plan.
- **A `blocker` round** whose test fails on the current tree is accepted, and Implement runs.
- **A `blocker` round** whose tests all pass on the current tree stops: the blocker has no failing test.
- **A mixed round:**
  - One failing `blocker` test and one passing `missing-test` test that fails at `origRedSha` are accepted.
  - Implement runs.
- **Loop count:**
  - With `maxLoops` 1, run one fix loop, stop the run and resume it.
  - The next Review round with findings stops with "REVIEW NOT RESOLVED" instead of starting a second fix loop.
  - After a Restart from Spec, the count starts again.
- **Not in a fix loop:** a first Red tests stage whose new test passes before Implement still stops with the `red-passing.md` message and points to Plan, as in `test/pipeline.test.ts:134`.

## Docs
- No doc describes the Review fix loop yet. Add a short section to `docs/PLAN.md`, next to the stage list, covering: how Review findings come back through Red tests; how the gate treats each finding kind; and that the loop limit covers the whole run.
- `CHANGELOG.md` `[Unreleased]`: the fix-loop red gate and the loop count.

## Open questions
- none
