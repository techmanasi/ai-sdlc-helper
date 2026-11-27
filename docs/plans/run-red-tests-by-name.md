# Run only the task's red tests, by name

Status: final. Decisions agreed 2026-11-28. Implemented.

## Request

These steps run only the specific tests that are expected to fail, not every test in the files Red tests created or changed:

- Implement: "Running the tests to see where things stand"
- Implement: "Running the unit tests"
- Test repair: "Running the unit tests"

## Today

| Step | `tests.fullSuite: "ci"` | `"local"` (default) |
|---|---|---|
| Baseline | whole target files, with retry | whole target files (`preliminary: "full"`: not scoped) |
| Unit tests (Implement, Test repair) | whole target files; Implement adds files CI failed | whole target files first, then the full suite |

"Target files" are the files that failed in `red.json` or the previous `tests.json`, plus the test files the red-tests and repair commits changed (`targetTestFiles`, `src/pipeline/gates.ts`).

The runners already filter by name (`RunOptions.names`, `src/runners/run.ts`) for Vitest, Jest and Mocha. `retryUnclaimed` uses it, one file per run. `node:test` and `generic-junit` ignore names.

## Design

### 1. The test list

One record per run, `<log>/test-list.json`, of the tests the local gates run. Stages add to it; the three steps read it.

Each entry has:

| Field | Values |
|---|---|
| test | `{ file, name }`, or `{ file, whole: true }` |
| added by | `red`: failed at "Checking the new tests fail", including Review fix rounds. `repair`: claimed by Test repair. `ci`: CI reported it failing during Implement. |
| state | `active` (runs), `already-failing` (shown, does not run), `dropped` (no longer exists, does not run) |
| reason | why it has that state |

Rules:

- One entry per test. A second stage adding the same test adds its flag to the entry. A `repair` or `ci` flag makes an `already-failing` entry `active`.
- Entries are never deleted. A Red tests run that starts the stage afresh replaces the whole list. A Review fix round adds to it.
- "Checking the new tests fail" writes its entries once the gate is accepted, from the failed tests of the accepted run. Tests in `tests.allowFailures` are left out. That gate still runs whole files.
- The list is not derived from `red.json`. `red.json` runs the current test files against the *original* pre-implementation source. A test added in a Review fix round for something Implement broke can pass there, so it would be missed.
- A claim of `<suite failed to run>` adds its file as a whole-file entry.
- A CI failure without a test name adds its file as a whole-file entry.
- Without the file (a run started before this change), the list is built from the `failed` entries of `red.json`. The already-broken check below cannot be applied to such a run, and the output says so.

#### Already-broken tests

A test that was failing before the run is not one that is supposed to fail now. "Base" is the commit before the run's first red-tests commit. For each test that failed at the gate:

1. Its name is not in the file at base: `red`, `active`.
2. Its name is in the file at base: run the **base version** of that file against the base source, copying no current files in.
   - It passed there: `red`, `active`.
   - It failed there: `red`, `already-failing`. The output names it.

The base run happens only when an existing name fails. Base is fixed for the whole run, so in a Review fix round an old test that Implement broke is still `active`: it passed before the run.

Limit: if Red tests deliberately updates a test that was already broken, it is also marked `already-failing`. The names are in the output so this can be checked.

#### Files that fail to load

A file that fails to load has no test names (common when a test imports a module that does not exist yet). It is stored as a whole-file entry and **stays whole** for the run. Replacing it with names later could miss an existing test that Red tests changed. This is an exception to "only the failing tests": an older test in that file can fail the gate, unless it is in `tests.allowFailures`.

#### Removed or renamed tests

- A Review fix round marks an entry `dropped` when its commit removed or renamed the test. Only files the round changed are checked.
- Resolve conflicts can also edit tests. If an entry's test is not found and a Resolve conflicts commit changed that file after the entry was added, the whole file runs. If it passes, the entry is marked `dropped`; if not, the gate fails.
- Test repair cannot remove or rename a test: its existing check forbids it.

Every dropped entry is named in the output. A test that is only skipped is never dropped.

### 2. Running the set

One function, used by all three steps:

1. Take the `active` entries. Group them by file and run one invocation per file with that file's names. `-t` applies to every file in an invocation, so a combined run would also run same-named tests in other files.
2. Run whole-file entries without a name filter. They pass when at least one test ran and none failed.
3. Merge the results into one `tests.log` and `tests.json`.

One process per file adds runner startup time for each file. Red tests usually touches few files.

### 3. Guard against a false green (required)

The list says which tests should run, not that they did. A name filter that matches nothing skips every test and can still exit 0. After each by-name run, every expected `(file, name)` must be in the report with status `passed` or `failed`.

If one is missing or `skipped`, that file runs again **whole**, and the output says which test was not matched and why the whole file ran. The whole-file result is then judged, and the expected test must appear in it as `passed`. If it still does not, the gate fails.

The only exception is the Resolve conflicts case in section 1.

This covers a report name that `norm()` changed (titles with ` > `, `›` or repeated spaces), a renamed or removed test, a test marked `skip`, and Vitest 5's ` > ` separator.

The fallback is also recorded with `keepError`, so it shows in `errors.log` and the run output.

### 4. Per step

| Step | Runs |
|---|---|
| Baseline | the `active` entries. `preliminary: "full"` still runs the full suite. |
| Implement unit tests | the `active` entries, including `ci` ones added by earlier rounds |
| Test repair unit tests | the `active` entries, including `repair` ones added from this round's claims |

Failures from the previous local attempt need no separate handling: the gate runs only the list.

`ci` entries are there because a fix attempt for a CI failure must be able to check it before pushing again. Without them, such an attempt turns green locally without running the broken test. Keeping them in the list also means a resumed run still has them.

If a step has no `active` entries, it does what it does today when it has no target files, and says so.

### 5. Runners without a name filter

`node:test` and `generic-junit` run the files as today and are judged as today. The output says so once per step. `node:test` has `--test-name-pattern` and can get support later.

### 6. Unchanged

- Test repair's `now.json`, `after.json`, `repaired-on-red.json`, and `red.json`. The claim pre-check, the removed-or-renamed check and the still-fails-without-implementation check compare whole test lists, so filtering them would break those checks.
- Lint and integration.
- Finalise's local fallback when CI is unavailable: it calls the same `successCheck` and must keep running the full suite. The new behaviour is therefore a parameter set by Implement and Test repair, not a change to what `successCheck` does by default.
- "Checking the new tests fail", and Resolve conflicts' unit tests.

## Trade-off

An older test that Implement breaks, even in a file Red tests touched, is no longer caught by these local gates. CI catches it: in Implement's CI round, or for Test repair changes at Finalise's "Waiting for CI on the changes since Implement". It is found later and costs a CI round.

## Decisions

Agreed 2026-11-28.

| # | Question | Decision |
|---|---|---|
| 1 | With `fullSuite: "local"`, do the unit-test gates still run the full suite? | Yes. They run the `active` entries first as the fail-fast pass, then the full suite. Otherwise nothing runs the full suite before Finalise commits. The baseline is by name in both modes, unless `preliminary` is `"full"`. |
| 2 | Does CI becoming unavailable change this? | No new rule: after the fallback the run is in local mode, so decision 1 applies. |
| 3 | Are CI-reported failures (`ci` entries) in Implement's gate, although they are not red tests? | Yes, those tests only (see section 4). |
| 4 | Does "Checking the new tests fail" also run by name? | Not here. It is a separate follow-up (`docs/good-to-have.md` item 14). That gate creates the list, so it would have to work out names *before* a run. An existing test that Red tests changed has no new name, and Test repair's checks rely on full results in `red.json`. |

## Work

1. **Test list:** write, add to and read `test-list.json`; the already-broken check; dropping entries; the `red.json` fallback. A new module for the list, used by `src/pipeline/gates.ts` and `src/pipeline/stages.ts` (`redTestsStage`, Implement's CI round, Test repair's claims). `resultsAt` skips the run in CI mode when it has no files to copy, so the base run needs a way to name files to run without copying them.
2. **By-name run and guard:** the behaviour in sections 2, 3 and 5. `src/pipeline/gates.ts`.
3. **Wire the steps:** baseline and both unit-test gates. `src/pipeline/stages.ts`. The log line `Red tests: running locally (N files)` and `localCounts` must count the tests that ran, not the ones the filter skipped.
4. **Docs:** `README.md` (`tests.fullSuite`), and a note in `docs/backlog/ci-full-suite-gate/specs-1.md` section 6, which currently describes file-level gates.

One PR is enough. No settings and no web UI change; check that no screen or help text describes these steps as file-level.

## Tests

Real runs on fixture projects, in `test/gates-failfast.test.ts` and `test/pipeline/ci-gates.test.ts` / `ci-stages.test.ts`:

- A test that was already failing at base is marked `already-failing`, named in the output, and does not fail the gate.
- An existing test that passed at base and that Red tests changed to fail is `active`.
- In a Review fix round, an old test that Implement broke is `active`.
- A `repair` or `ci` flag makes an `already-failing` entry `active`.
- The base run happens only when an existing name fails.
- Only the `active` entries execute (a fixture test leaves a marker file when it runs).
- A same-named test in a second file does not run.
- A name that matches nothing: the whole file runs, and the gate is not green unless the expected test passed.
- A skipped or renamed expected test cannot turn the gate green.
- A file that fails to load stays a whole-file entry after it loads.
- A Review fix round adds to the list, including a test that passes on the original source.
- A test that a fix round renames or removes is `dropped`, and the gate can still pass.
- A test that Resolve conflicts renames: the whole file runs, and the gate passes only if the file passes.
- A resumed run keeps its `ci` entries.
- A run without `test-list.json` uses `red.json`.
- Implement includes a test CI reported; Test repair includes a claimed test.
- Local mode still runs the full suite after the `active` entries.
- Finalise's local fallback runs the full suite.
- Jest and Mocha: the adapter receives the names (`test/runners.test.ts`).
- `node:test` and `generic-junit`: files run as today.

## Done when

In a CI-mode run, the three steps run only the `active` entries (whole-file entries in full), and a broken listed test still fails each gate. In a local-mode run, the unit-test gates then run the full suite.
