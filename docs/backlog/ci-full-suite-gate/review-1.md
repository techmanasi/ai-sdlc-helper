# Review 1: ci-full-suite-gate

Diff reviewed: `git diff 2976769` (uncommitted changes) against `specs-1.md`. The changes fix the CI build failure
in `ci-failure.md` (`TS2345` in `src/pipeline/gates.ts`).

## Blockers

None. No test reads or asserts on documentation text. The `.md` files tests write or read
(`brief.md`, `ci-failure.md`, `pr-comments.md`, `plan-1.md`) are pipeline artifacts, not docs. Every behaviour the
spec describes has code.

## The diff

1. `src/pipeline/gates.ts` (`passesWithAllowed`, 8.4 / AC 16): a failed test with no file used to go to
   `checkAllowedFailures` with `file: null`, which broke the build. Now any failure the runner can't tie to a file
   blocks the gate, because no `tests.allowFailures` entry can match it. This is correct and errs on the safe side:
   an unknown failure is never waived. The CI path (`classify` in `ci.ts`) already drops file-less failed tests from
   test-level classification. Their check then falls back to check-level classification, so CI doesn't waive them
   either.
2. `src/config/settings.ts`: `testRunDefaults` now takes only `retry` / `maxWorkers`. This widens the type, and all
   callers (`cli/main.ts`, `cli/runners.ts`, `gates.ts`, `test/config.test.ts`) still match it.
3. `src/pipeline/stages.ts`: `let used` becomes `const used`, which is never reassigned (lint fix).

No correctness, edge-case or security problems found in these changes. No fixes were needed.

## Checks run

`ai-sdlc-helper run --file` passed for `test/pipeline/ci-gates.test.ts`, `test/pipeline/allow-failures.test.ts` and
`test/config.test.ts`. The typecheck (`npm run check`) wasn't run in this review. The parent should run it before
pushing, since the CI failure was a type error.

## Still open (minor, from the earlier review)

- Review doesn't push its own changes (6). Finalise pushes right after.
- With a test report, failed tests are attributed to the first failing check with a report. Check names can be wrong
  when several jobs fail in one run.
- `isRedTest` matches whole files, which is stricter than the spec.
- A whitespace-only `tests.allowFailures` entry passes validation.
- No test covers a local gate with a file-less failed test while `tests.allowFailures` is set (the new branch in
  item 1).

## Acceptance criteria coverage

AC 1–3: `test/config/ci-full-suite.test.ts`. AC 4–11, 18–23: `test/pipeline/ci-stages.test.ts`, `ci-gates.test.ts`,
`ci-pr-status.test.ts`. AC 12–17, 20–21: `test/pipeline/ci-step.test.ts`, `allow-failures.test.ts`. AC 24:
`web/test/runs/ci-view.test.ts` (the payload only; the round-block panel has no test). AC 25 is documentation (README,
`docs/web-ui.md`). All of these tests run the real code.
