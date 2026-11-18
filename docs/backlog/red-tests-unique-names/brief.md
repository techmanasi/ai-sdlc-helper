## Problem

Two new tests in one file can share a name, for example the rows of a parameterised test (`it.each`) whose
title has no `%s`/`$name` placeholder. The pipeline matches test results by file and name, so:

- The retry (`runSuite`, `src/runners/run.ts:95-96`) sees the failing row fail and the passing row "pass on
  retry", and labels the test **flaky**. It isn't flaky.
- The red gate lists the name as "already passes before implementation" and sends the run to Plan, which
  cannot fix a test's name.

Seen in the run `fix-loop-red-gate-kind`: `runs Implement when a blocker test fails, including mixed findings`
had two rows, one passing (existing behaviour) and one failing. Two resumes at Plan changed nothing.

## Options considered

- **Prefix every test name with the task slug.** Rejected. Names are already scoped by file, and two rows in
  the same file would still share the prefix.
- **Read the test source for duplicate titles.** Rejected. It depends on the framework, and a parameterised
  title is only resolved at run time.
- **Check the reported results (chosen).** Every runner reports `file` and `name` for each test, so a repeated
  `file :: name` among the new test files is found the same way for every framework.

## Expected behaviour

1. **Red tests prompt.** A rule: every test, and every row of a parameterised test, has a unique name in its
   file (use the framework's placeholder, such as `%s` or `$name`).
2. **Gate check.** After the new tests run, the red gate looks for repeated `file :: name` among the new or
   changed test files. If it finds any, the Red tests agent gets one retry within the stage, listing the
   repeated names and asking for a unique name for each. If they still repeat, the stage stops with
   `RED GATE FAILED: N test name(s) repeat in the new tests:` and the list. The card offers Resume at Red
   tests, never Plan or Spec.
3. **Retry matching.** `runSuite` matches first-run and re-run results per occurrence (file, name and its index
   among results of that name), so a repeated name is never reported as flaky.
4. Names that repeat only in test files the task did not touch are left alone.

## Tests

- `runSuite` with a fake runner reporting two results under one name (one passing, one failing): no flaky
  entry, and the failure is still counted.
- A pipeline fixture whose fake Red tests agent writes two same-named tests: the retry prompt holds the
  repeated names; a second fake attempt with unique names passes the gate; a second attempt that still
  repeats stops with the message above and a Red tests recovery.

## Notes

- This is built outside the pipeline, on top of the Red tests handoff work (the in-stage retry and the
  `{{HANDOFF}}` prompt note).
