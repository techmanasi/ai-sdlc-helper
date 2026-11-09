# Review 1: ci-full-suite-gate

Diff reviewed: `git diff 6a78f4a` against `specs-1.md`.

## Blockers

None left. No test reads or asserts on documentation text. Every behaviour the spec describes has code, except the
minor items listed under "Not fixed" below.

## Fixed in this review

1. **Draft label on the run page was always "ready"** (10.2, AC 24). `CiStatus` had no `prDraft`, so the view always
   reported `false`. Now `checkCiAvailability` returns the PR's `isDraft`, `openCi` records it, and Finalise sets it to
   false after `gh pr ready` succeeds (`status.ts`, `ci.ts`, `stages.ts`).
2. **Finalise lost the draft PR on a resumed run** (9, AC 7). It took the PR only from `ctx.status.ci`, which a new
   process (FROM=review or FROM=finalise) doesn't have. So `gh pr ready` never ran, and with `createPr` off no PR was
   marked ready. It now falls back to the link in `brief.md`, read before `finalise()` runs.
3. **Resume waited on CI for heads that were never paused** (5.4). Any FROM=implement on a pushed head waited first,
   including a red-tests commit (red by design) or a run that had failed. Now it waits only when a CI pause saved
   `ci-attempts.json`.
4. **A later "no workflow" fell back to local** (4.3). The spec says `no workflow` is only found on the first wait, and
   CI problems after that pause the run. `awaitCi` now turns a later `unavailable` into a pause.
5. **Only the first failing workflow run was re-run** (8.2 step 4, 8.3). Failures in a second workflow run could never
   be flaky. Every failing run now gets its failed jobs re-run once. A test is flaky only when the re-run report shows
   it passing. If the re-run report doesn't have the test, the job's conclusion decides. Before, a test missing from
   that report counted as flaky.
6. **The red gate could be passed by `tests.allowFailures`.** `testsPass` applied the allow list in the red gate, and
   `isRedTest` can't recognise new tests before the red commit exists. So an entry such as `test/e2e/*.test.ts`
   turned a new failing red test into a pass, and the run stopped with `RED GATE FAILED`. The red gate now passes
   `noAllowFailures`.
7. **Allowed local failures weren't in the local test log** (8.4). They are now appended to `tests.log`. The fast
   path also no longer writes `tests.log` twice, which would have dropped that list.
8. **The run page had no per-round blocks, failing checks or warnings** (10.1, 10.2). `Run.tsx` now shows the failing
   checks for `red`, lists the non-blocking warnings, and has an "Implement rounds" panel that groups each
   `Round <n>: implement` block of the run log.
9. **No docs** (2.4, AC 25). The README now covers `tests.fullSuite`, `ci.waitMinutes`, `tests.allowFailures`, the
   overrides and precedence, the draft PR, what Implement waits for, fallback, and the `sdlc-test-report` upload step.
   `docs/web-ui.md` covers the CI line and the round blocks.

## Not fixed (minor)

- Review doesn't push its changes itself (6). Finalise pushes right after, so the PR still gets them.
- With a test report, every failed test is attributed to the first failing check that has a report. With several
  failing jobs in one run, the check names in the status line and in `ci-failures.md` can be wrong. Classification
  itself is unaffected.
- `isRedTest` matches whole files. If the red commit added a test to an existing file, no test in that file can be
  allowed. This is safe but stricter than the spec.
- A whitespace-only `tests.allowFailures` entry passes validation.
- `ciView` resolves the full config on every run-page load while a CI status exists.

## Acceptance criteria coverage

AC 1–3: `test/config/ci-full-suite.test.ts`. AC 4–11, 18–23: `test/pipeline/ci-stages.test.ts`,
`ci-gates.test.ts`, `ci-pr-status.test.ts`. AC 12–17, 20–21: `test/pipeline/ci-step.test.ts`,
`allow-failures.test.ts`. AC 24: `web/test/runs/ci-view.test.ts` (the payload; the new round-block panel has no test).
AC 25 is documentation. All of these tests run the real code.
