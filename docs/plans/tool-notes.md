# Tool notes: stage-specific prompt notes, loaded only for the tools a project uses

Status: plan, not implemented. Worked example: Vitest's "Timeout calling onTaskUpdate" (background for this repo's developers: `docs/investigations/vitest-ontaskupdate-timeout.md`; that file does not ship and no note may refer to it).

## Requirements check

| Requirement | Before this update | Now met by |
|---|---|---|
| A note works when ai-sdlc-helper is installed as a package in another project; nothing in it depends on files of this repo | Partly: notes were under `assets/` (which ships), but nothing required their text to be self-contained and no test ran from an installed package | "Portability" (shipped-note checklist, `npm pack` listing) and the packaged-install test in slice 3 |
| The Vitest note reaches only its stages, and only when a suite runs Vitest | Met | "Matching" (`match: runner=vitest`), "Triggers" (`when:` for Implement, Test repair, Test audit), slices 3 and 4 |
| Custom notes for a stage plus a tool combination (e.g. Python + Behave), loaded only for that combination | Not met: one facet per note (`<facet>/<value>/` folders), project notes out of scope, and the settings could not say "python" or "behave" | "Matching" (AND across keys, per suite), the `tools` setting, "Project notes", "Failure modes", slice 5 |

## Goal

A short note about a tool (today: a test runner; later any tool the resolved settings name) reaches a stage agent only when the project uses that tool, and holds different text per stage:

| Stage | What the Vitest note must make the agent do |
|---|---|
| Red tests | write tests that cannot trigger it (async setup, short synchronous stretches) |
| Implement | recognise it (all tests pass, the run still fails), claim it in `test-issues.md` instead of changing source |
| Test repair | verify the claim, apply the allowed test-file fix |
| Test audit | accept that fix as an isolation repair, not as weakening |

## What the code does today (verified)

### The gate fails the run, but the agents cannot see why

The blocking file (8 tests, each `spawnSync('sleep', ['9'])`, `testTimeout: 60000`) run through the pipeline's own runner, `node dist/bin.js run <dir> --out trace-result.json`:

```
trace (vitest): 8 passed, 0 failed, 0 skipped, 0 file errors
exit=1
```

and the result file: `"ok": false, "exitCode": 1, "suiteErrors": []`, 8 tests `passed`.

- `src/runners/run.ts:73`: `ok = exitCode === 0 && !suiteErrors.length && !tests.some(failed)`, so the run fails the gate.
- `src/runners/vitest.ts:5-12`: the adapter keeps only the JSON report and the exit code. Vitest prints the unhandled error to its console output, which is dropped once a report exists (only `noReport`, `src/runners/types.ts:120-123`, keeps output).
- The JSON report has no unhandled-error field: `success` counts only failed suites and tests (`node_modules/vitest/dist/chunks/index.VByaPkjc.js:1711`), so it is `true` here.
- `src/pipeline/gates.ts:16-26` (`resultText`, what agents read in `tests.log`) prints the summary, `ERROR <file>` for suite errors and `FAIL` for failed tests. Here that is one line: "8 passed, 0 failed, 0 skipped, 0 file errors".
- Vitest's own message does not name the file (reproduction log: `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` with only Vitest-internal frames). The JSON report does give each file's `startTime`/`endTime` (`index.VByaPkjc.js:1714-1716`, written per file at `:1740-1741`).
- With `tests.retry` on, a failed run runs once more (`src/runners/run.ts:80-99`): the whole suite when a failure names no file, else only the failed files (`:84-86`). The first run's suite errors on re-run files are dropped (`:90`, `:94`), so a lighter second run that passes hides the error without a trace. Slice 2 deals with this.

So no note can help Implement until the run's error reaches `tests.log`. This is slice 1.

### A file-level claim cannot be written today

- `src/testcheck/keys.ts:113-120` parses `test-issues.md` lines `<file> :: <name> :: <why>` into the key `<file>::<name>`.
- `src/testcheck/checks.ts:75-86` (`precheck`): every claimed key must exist in the results (`:82`), and every failing key must be claimed (`:83`). The justification must match `/(spec|plan|decision|round|S-R|isolat|mock)/i` (`:84`); "isolation defect" passes.
- `SUITE_FAILED = '<suite failed to run>'` (`src/testcheck/keys.ts:44`) is the file-level name. `Keys.collect` turns each suite error into `<file>::<suite failed to run>`, but adds it only to `failed`, never to `all` (`keys.ts:81` for a RunResult, `:95` for a Jest-style report); only test keys reach `all` (`:85`, `:98`).
- So a file-level claim fails precheck with "claimed test does not exist" even when the run has a suite error on that file. Verified by the plan's reviewer: `precheck` from `dist/testcheck` on a result with one passed test and a suite error on `test/a.test.mjs`, with the claim `test/a.test.mjs :: <suite failed to run> :: isolation defect: blocks`, returned `['claimed test does not exist: test/a.test.mjs::<suite failed to run>']`. The existing test at `test/testcheck.test.ts:268` covers only the other direction (an unclaimed suite failure is rejected).
- Conclusion: the claim format and the line parser stay as they are, but `Keys.collect` must also add each suite-failed key to `all` (slice 2), and the runner must record the run error as a suite error on the file that caused it (slices 1 and 2). The Implement section of the note then tells the agent to claim `<file> :: <suite failed to run> :: isolation defect: …`.
- Side effect of that change: a claim on any suite failure (an import error, say) now passes the "exists" check. It still needs a spec, plan, decision or isolation justification (`checks.ts:84`), the diff check, the red check and the auditor, so this widens what can be claimed, not what can be accepted.
- `redcheck` (`checks.ts:117-124`) only checks claimed keys that failed at red, so a file-level key that did not fail at red passes. `diffcheck` (`checks.ts:89`) allows changes to claimed files only, which covers adding a `beforeEach` there.

## Where prompts are built

| Agent | Built at | Gets `parts/tools.md` | Notes go in via |
|---|---|---|---|
| Spec, Plan, Red tests, Implement, Test repair, Review | `src/pipeline/agent.ts:119` (`runAgent` → `renderPrompt`), then manual input and PR comments appended at `:121-122` | yes, `src/pipeline/prompts.ts:23-24` | `renderPrompt` |
| Test audit | `src/pipeline/stages.ts:327` (`renderPrompt` directly, then `runAudit`) | yes | `renderPrompt` |
| Skills (plugin, `ai-sdlc-helper skill <name>`) | `src/config/skills.ts:21-40` (`renderSkill`), called from `src/cli/main.ts:241` | no | `renderSkill` |
| Triage | `src/triage.ts:65` (triage skill) and `:160` (`triage-*.md` read directly) | no | not in v1: triage is not one of the stages the notes key on |

Stages are called at `stages.ts:130` (Spec), `:159` (Plan), `:181` (Red tests), `:226` (Implement), `:310` (Test repair), `:327` (Test audit), `:349` (Review).

Rendered size today (words, all placeholders filled with one word; parts included): Spec 279, Plan 473, Red tests 313, Implement 370, Test repair 226, Test audit 248, Review 169. Skills: red-tests 139, implement 106, tdd-loop 33, review 49.

## Settings a note can key on

| Facet | Values | Source |
|---|---|---|
| `runner` | jest, vitest, mocha, node-test, generic-junit | `Suite.runner`, `src/config/settings.ts:50`; values `src/config/detect.ts:5` |
| `language` | javascript, typescript | `Suite.language`, `settings.ts:51`; `detect.ts:8` |
| `packageManager` | npm, pnpm, yarn, bun | `Suite.packageManager`, `settings.ts:52`; `detect.ts:7` |
| `harness` | claude, agy, codex | `Config.agent.harness`, `settings.ts:72`; `settings.ts:16` (per-stage override in `agent.stages`) |
| `codeIndexer` | the indexer's name | `Config.agent.codeIndexer`, `settings.ts:72`; `src/config/codeSearch.ts:12` |
| `tools` (new, slice 5) | free-form labels, lower-cased, e.g. `python`, `behave`, `playwright` | `tools: string[]` in `sdlc.config.json`, per suite and at the top level; the top-level list applies to every suite |

`lint` (`settings.ts:69`) is a free-form command with no tool id, so it is not a facet in v1.

Why `tools` is needed: the settings cannot say "Python" or "Behave" today. `runner` allows only the five Node runners (`SUITE_SCHEMA`, `settings.ts:117-120`; `detect.ts:5`), and `language` only javascript or typescript (`detect.ts:8`): a Python suite run as `generic-junit` (`behave --junit`, which the schema already allows with `testCmd` and `report`, `settings.ts:204-207`) is detected as `javascript` (`settings.ts:216`). Python support itself is the `non-node-ecosystem-support` backlog item; `tools` lets a project describe its suite now, and a note can switch to `language=python` once that item lands.

## Design

### Files

Two places, same format:
- Shipped notes: `assets/prompts/notes/<name>.md` in the package, e.g. `assets/prompts/notes/vitest-rpc-timeout.md`. Read through `ASSETS_DIR` (`src/util.ts:9`, resolved from the installed `dist/`), so they load wherever the package is installed.
- Project notes: `<project root>/.sdlc/notes/<name>.md`, or the folder named by the new `agent.notesDir` setting (relative to the project root; a path outside the root is refused). See "Project notes".

A note file:

```
match: runner=vitest
## red-tests
<text>
## implement
when: Timeout calling "onTaskUpdate"
<text>
```

- One or more `match:` lines first; a note loads when any of them holds (OR between lines).
- Then one `## <stage>` section per stage it speaks to (stage ids from `src/pipeline/context.ts:14`: `spec`, `plan`, `red-tests`, `implement`, `test-repair`, `test-audit`, `review`). A section may start with one `when: <regex>` line; see "Triggers".
- `match: never` loads nowhere: a project note with that line and a shipped note's name turns the shipped note off.

### Matching

A `match:` line is `key=values` pairs joined by `, ` (AND). `values` is one value, `a|b` (either) or `a+b` (both; only for `tools`, which holds several values). `|` and `+` are not mixed in one value (`tools=python+behave|ruby` is malformed; write two `match:` lines instead). Keys and values are compared case-insensitively.

| Key | Scope | Where the value comes from |
|---|---|---|
| `runner`, `language`, `packageManager`, `tools` | per suite | the suite (`tools`: the suite's list plus the top-level list) |
| `harness` | project, per stage | the stage's `agent.stages.<stage>.harness`, else `agent.harness` |
| `codeIndexer` | project | `agent.codeIndexer.name` |

A line holds when one suite satisfies all its per-suite keys and the project-level keys hold too. Keys are never combined across suites, so a project with a Python suite and a Vitest suite does not match `tools=python, runner=vitest`.

Truth table. Project: suite `web/` (runner vitest, language typescript, tools none) and suite `features/` (runner generic-junit, detected language javascript, tools `python`, `behave`); harness claude.

| `match:` line | Loads? | Why |
|---|---|---|
| `runner=vitest` | yes, "Applies to web/" | suite `web/` |
| `tools=python+behave` | yes, "Applies to features/" | suite `features/` has both |
| `tools=python+behave, runner=vitest` | no | no one suite has all three |
| `tools=python\|ruby` | yes, for `features/` | either value |
| `tools=behave+pytest` | no | `pytest` not listed |
| `runner=jest\|vitest` | yes, for `web/` | either value |
| `runner=vitest, harness=codex` | no | harness is claude |
| `language=python` | no | detected `javascript` until Python support lands |
| `runner=vitest` and `tools=behave` (two lines) | yes, once, naming both suites | OR between lines; a note is added once per stage |
| `never` | no | turned off |

### Selection and order

`toolNotes(stage, config, signals)` in a new `src/config/toolNotes.ts`:
1. Load shipped notes, then project notes; a project note with the same `<name>` replaces the shipped one.
2. Keep the notes whose `match:` holds, then their `## <stage>` section, kept if it has no `when:` line or its regex matches the stage's signal text.
3. Order: shipped notes by name, then project notes by name. Joined under one heading line, appended after `parts/tools.md`.
4. When the project has more than one suite, a note matched through per-suite keys starts with "Applies to <dir>/" for the suites it matched.

### Project notes

- Committed in the project's repository. The pipeline reads them from the root it runs in (`src/pipeline/run.ts:140`), which is the run's worktree, so an uncommitted note is not there unless its folder is listed in `worktree.link` (`settings.ts:291`). `doctor` warns about untracked files in the notes folder.
- Same format, matching, triggers and word caps as shipped notes; they can name any `tools` value the project lists.
- Problems never stop a run: they become warnings from `resolve()` (`settings.ts:227`), which the pipeline prints at run start (`run.ts:144-146`) and `doctor` counts (`src/registry/doctor.ts:70`, `:99`).

### Failure modes

| Case | Shipped note | Project note |
|---|---|---|
| Malformed: no `match:` line, unknown key, unknown stage heading, bad `when:` regex, `+` on a one-value key | `SetupError` (as for a missing prompt file, `prompts.ts:21`): fails this repo's tests | skipped, with a warning naming the file and the problem |
| Unknown value (`runner=behave`, `tools=anything`) | allowed; never matches | allowed; never matches |
| Notes folder missing | not possible (the package ships it) | nothing loads; a warning only when `agent.notesDir` was set |
| Same name as a shipped note | n/a | replaces it; `match: never` turns it off |
| Section over 120 words, or a stage over 200 words of notes | `SetupError` | the project note is skipped with a warning (shipped notes are counted first) |
| Note not committed, run in a worktree | n/a | not loaded; `doctor` warns; commit it or add the folder to `worktree.link` |
| `agent.notesDir` outside the project root | n/a | refused by `resolve()` as a settings error |

### Portability

- `npm pack --dry-run` today lists all of `assets/prompts/` in the tarball (`package.json` `files`: `dist`, `assets`, `CHANGELOG.md`), e.g. `assets/prompts/parts/tools.md`, `assets/prompts/prompt-red-tests.md`, `assets/prompts/triage-split.md` (173 files, 247.6 kB). `assets/prompts/notes/` ships the same way, with no change to `files`.
- The release workflow already installs the packed tarball and runs it (`.github/workflows/release.yml:80-89`, including `skill plan`); slice 3 adds `skill red-tests` there.
- Shipped-note checklist, checked in review of every PR that adds or changes a shipped note (not a test: this repo's tests never assert on Markdown): the text names no file of this repo (no `docs/`, `test/setup.ts`, `vitest.config.ts` of ai-sdlc-helper); every fix it prescribes is something the stage's agent may do in the target project (Red tests, Test repair: test files only; Implement: source and `test-issues.md`); it says which tool and version range it is about; it stays under the caps.

### Triggers

| Stage | Signal text for `when:` |
|---|---|
| Red tests | none (sections here have no `when:`; prevention applies always) |
| Implement | `<log>/tests.log` of the last gate run |
| Test repair, Test audit | `<docs>/test-issues.md` (the claim must cite the symptom) |
| others | none |
| Skills (`renderSkill`, no run in progress) | none: a `when:` section is included with its condition turned into a leading sentence, "If the test output shows `<regex>`:", since the interactive agent reads the output itself |

Sections without `when:` load whenever the tool is in use. The Vitest note's Implement, Test repair and Test audit sections carry `when: Timeout calling "onTaskUpdate"` so they cost nothing in the common case.

### Budget

At most 120 words per section and 200 words of notes per stage prompt (Implement today is 370 words; 200 more is the most a failure case should add). `toolNotes` enforces both and throws `SetupError` past either, so a growing note fails a test, not a run.

### Decisions

| Choice | Picked | Rejected, and why |
|---|---|---|
| How notes enter a prompt | appended by `renderPrompt` and `renderSkill`, after `parts/tools.md` | a `{{…}}` placeholder per tool in each prompt: every new tool or stage means editing every prompt, and a forgotten placeholder silently drops the note |
| Per-stage text | one file per issue, `## <stage>` sections | one file per stage and issue: the four texts about one issue drift apart; a file per tool: unrelated issues share a file and a budget |
| When to load | tool in use, plus an optional symptom regex per section | tool in use only: Implement pays ~120 words on every Vitest run for a rare failure; symptom only: Red tests' prevention would never load |
| `parts/code-search.<indexer>.md` | keep as is | fold into notes: it replaces `{{CODE_SEARCH}}` with one guide (and a project can supply its own `guide`/`guideFile`, `codeSearch.ts:117-123`), which is substitution, not an added note |
| Layout | `<name>.md` with `match:` lines | `<facet>/<value>/` folders (the earlier version of this plan): a combination such as Python + Behave has no folder, and one note about two tools would need copies |
| Describing Python + Behave | a free-form `tools` list per suite and project | wait for Python support: nothing can match until then; widen `runner`/`language` now: that is the `non-node-ecosystem-support` work, not a notes feature |
| Combination scope | per suite | per project: a mixed project would load a note for a combination no suite has |
| Broken project note | skipped with a warning | stop the run: one bad note in someone's repo would block their pipeline; ignore silently: the author never learns why it does not load |
| `{{RUNNER_NOTES}}` work in the worktree `../ai-sdlc-helper-sdlc/vitest-red-tests-note` (branch `feat/vitest-red-tests-note`; the change is uncommitted there, so the branch ref itself holds none of it) | do not merge it; slice 3 replaces it, using the note text quoted in "Vitest note: Red tests text" below, so the plan does not depend on that worktree | merge, then migrate: ships a placeholder, a test and a part file that the next PR removes. Its reproduction (a scratch Vitest 3.2.7 project, one file of 8 tests each `spawnSync('sleep', ['9'])`: the error in 3 of 3 runs, 0 of 3 with the note's fix in that test file) is to be re-run and recorded in slice 3's PR, since its logs live in a session scratch folder |

### Vitest note: Red tests text

The `## red-tests` section of `assets/prompts/notes/vitest-rpc-timeout.md` (118 words; it names no file of this repo):

```
Vitest note (only when a Vitest run reports 'Timeout calling "onTaskUpdate"', or "Vitest caught N unhandled error" while every test passes):
- Cause: a test file whose tests do only synchronous work (spawnSync, execSync, *Sync fs) never lets its event loop turn, so Vitest's replies go unread; past 60s the worker's call times out, likelier under parallel load.
- Prevent: do slow setup with async spawn or fs.promises; keep synchronous stretches short.
- Fix, in that test file only: make the blocking work async, or add `const tick = setImmediate; beforeEach(() => new Promise(r => tick(r)));` at the top (before any fake timers).
- Never raise testTimeout, set dangerouslyIgnoreUnhandledErrors, lower the worker count or edit the Vitest config.
```

Sources for its claims (Vitest 3.2.7): the 60s limit, `DEFAULT_TIMEOUT = 6e4` (`node_modules/vitest/dist/chunks/index.B521nVV-.js:3`); the error text (`rpc.-pEldfrD.js:49`); the "unhandled error" banner (`cli-api.DVe0nWUx.js:5582`); fake timers replace `setImmediate` by default, hence capturing it first (`vi.bdSIJ99Y.js:3655`).
| Finding the file to claim | the runner records the run error on the file(s) that ran 60s or longer | a new claim form: changes the parser and every check that keys on test names; asking the agent to guess: precheck would still reject a claim for a key the results do not hold |

## Slices (each its own PR, each shippable alone)

"Alone" means each PR leaves `main` working and useful once the slices it builds on have merged. Order: slice 2 builds on 1 (it places slice 1's error on a file); slice 3 stands alone; slice 4 builds on 1, 2 and 3 (Implement must see the error, the claim must pass precheck, and the notes mechanism must exist); slice 5 builds on 3. So 1 and 3 can go in parallel, then 2, then 4 and 5.

1. **A failing run with no failing test says why** (all runners). In `src/runners/run.ts` (after the adapter returns, `:69-73`): when `exitCode !== 0`, no test failed and there is no suite error, add a suite error `{ file: null, message: <last 4000 characters of the runner's output> }`, as `noReport` does (`types.ts:120-123`). Adapters return their output for this. `tests.log` then shows `ERROR (unknown file): failed to run` with the message.
   Tests: `test/runners.test.ts`, new test "a run that exits non-zero with every test passed reports the runner's output as a suite error": a stand-in runner command writes a passing report and exits 1 with a message; the result has one suite error holding that message and `ok` false. `test/gates-failfast.test.ts`, new test "tests.log shows the error of a run with no failing test", through `testsPass`.
2. **Vitest names the blocking file.** In `src/runners/vitest.ts` / `parseJestLike` (`src/runners/jest.ts:8`): keep each file's `startTime`/`endTime`; when slice 1's error holds `Timeout calling "`, put it on each file that ran 60000ms or longer (else keep `file: null`). In `Keys.collect` (`src/testcheck/keys.ts:81`, `:95`) also add each `<file>::<suite failed to run>` key to `all`, so precheck accepts a claim on it. In `runSuite` (`src/runners/run.ts:80-99`), when a re-run drops a first-run suite error that names a file (`:94`), report it the way a flaky test is reported (a `FLAKY <file> :: <suite failed to run>` line in `tests.log` and `flaky-tests.md`) instead of losing it.
   Tests: `test/runners.test.ts`, "a Vitest RPC timeout is put on the file that ran over 60s", with a recorded JSON report and output from the reproduction; `test/runners.test.ts`, "a suite error that clears on re-run is reported as flaky, not dropped"; `test/testcheck.test.ts`, "a file-level claim on a suite error passes precheck", running `precheck` on that result and a claim line (it fails today, so it is red before this slice).
3. **Notes mechanism with shipped notes, Red tests only.** `src/config/toolNotes.ts` (parsing, matching on the built-in keys, selection, caps); calls in `renderPrompt` (`prompts.ts:19-35`) and `renderSkill` (`skills.ts:21-40`), with the config and signals passed in from `runAgent` (`agent.ts:117-122`) and `stages.ts:327`; `assets/prompts/notes/vitest-rpc-timeout.md` with `match: runner=vitest` and a `## red-tests` section (the text in "Vitest note: Red tests text"). Skills map to stages by name, `tdd-loop` to both red-tests and implement. Add `"$bin" skill red-tests . > /dev/null` to the packed-package smoke test (`release.yml:80-89`).
   Tests, new `test/tool-notes.test.ts` (each compares against sections read from the note file at test time, never against wording): "a note loads for the stage and runner it names and for no other runner" (all five runners); "match lines follow the truth table" (each row of the table in "Matching" except the `tools` rows, on a two-suite config); "a mixed project gets a runner's note once, naming its suite folder"; "the red-tests skill gets the note for a Vitest project only"; "a malformed shipped note is refused" (no `match:`, unknown key, unknown stage heading, bad `when:` regex); "a section over 120 words or a stage over 200 words of notes is refused"; and the existing "every shipped stage prompt renders without a placeholder left" (`test/pipeline-units.test.ts:156`) keeps passing.
   Packaged-install test, new case `{ name: 'packed-notes', mode: 'packed' }` in `e2e/run.mjs` (the cases are `{ name, project, mode }`, `e2e/run.mjs:39-43`; the new `packed` mode has no single project and skips the pipeline: it runs the steps below and fails the case on any mismatch) (run by `npm run e2e` and the e2e workflow, `.github/workflows/e2e.yml:26`): `npm pack` into a temp folder, `npm install -g --prefix <temp>` of the tarball, copy `e2e/projects/vitest-ts` and `e2e/projects/jest-cjs` to temp folders outside the repo, run the installed `ai-sdlc-helper skill red-tests <copy>` for each. The expected text is the `red-tests` section read by the installed package's own `dist/config/toolNotes.js` from its own `assets/prompts/notes/vitest-rpc-timeout.md`: it appears for the Vitest copy and not for the Jest copy.
4. **Symptom-gated sections for Implement, Test repair and Test audit.** Add those three sections to `vitest-rpc-timeout.md` with `when: Timeout calling "onTaskUpdate"`. Implement: the run failed with no failing test; claim `<file> :: <suite failed to run> :: isolation defect: …` and do not change source. Test repair: confirm the file blocks over 60s, then make its setup async or add a `beforeEach` that awaits a captured `setImmediate`; nothing else. Test audit: that change adds no skip and drops no assertion, so it is a valid isolation repair.
   Tests: `test/tool-notes.test.ts`, "a when: section loads only when the stage's signal text matches" (Implement with and without the error in `tests.log`; Test repair and Test audit with and without it in `test-issues.md`). `test/pipeline.test.ts` already records every prompt through the fake agent (`r.prompts`, used at `:44-48`): new test "Implement and Test repair get the Vitest note only after a run fails with the RPC timeout", with a Vitest-runner fixture whose test command prints the error and exits 1.
5. **Project notes and the `tools` setting.** Schema: add `tools: 'string[]'` to `SUITE_SCHEMA` (`settings.ts:117-120`) and to the top level of `SCHEMA` (`settings.ts:121-138`), and `notesDir: 'string'` to `SCHEMA.agent` (`settings.ts:130-133`). Types: `tools: string[]` on `Suite` (`settings.ts:47-61`) and `notesDir: string` on `Config.agent` (`settings.ts:72`). Values: `completeSuite` (`settings.ts:191`, returned object ending `:222`) gets a fifth parameter, the top-level `tools` list, and sets `tools` to the suite's list plus that list, lower-cased; both callers pass it, the configured-suites path (`settings.ts:252`) and the auto-detected path (`settings.ts:263`, whose suites have no list of their own, so they get only the top-level one); `resolve()` (`settings.ts:227`, `agent` built at `:298-305`) sets `notesDir` (default `.sdlc/notes`), refuses one outside the root, and adds the project-note warnings of "Failure modes" to its warnings. `toolNotes` loads the project folder after the shipped one. `doctor` warns about untracked files in the notes folder. `notesDir` is a project setting only: personal settings already refuse any agent key outside `PERSONAL_KEYS` (`src/config/personal.ts:11`, checked at `settings.ts:142`), so it needs no change there.
   Worked example, Python + Behave (runs today as a `generic-junit` suite):

   `sdlc.config.json`:
   ```json
   { "suites": [{ "name": "features", "dir": "features", "runner": "generic-junit",
       "testCmd": "behave --junit --junit-directory reports features/login.feature", "report": "reports/TESTS-login.xml",
       "tools": ["python", "behave"] }] }
   ```
   Behave writes one `TESTS-<feature>.xml` per feature file, and the `generic-junit` adapter reads the single `report` file (`src/runners/junit.ts:41-47`), so this example runs one feature file. Several feature files need their reports merged into one first; that belongs to the `non-node-ecosystem-support` item, not to notes.
   `.sdlc/notes/behave-steps.md`:
   ```
   match: tools=python+behave
   ## red-tests
   Write each scenario's steps in features/steps/; reuse an existing step whose wording matches instead of adding a near-duplicate, since Behave refuses ambiguous steps.
   ## implement
   when: AmbiguousStep
   An AmbiguousStep error is a test defect: claim it in test-issues.md naming the step file; do not rename steps in source.
   ```
   Tests: `test/tool-notes.test.ts`: "a project note for tools=python+behave loads for a suite listing both, at the stages it names, and for no other suite" (plus the `tools` rows of the truth table); "a project note replaces a shipped note of the same name, and match: never turns it off"; "a malformed project note is skipped and reported as a resolve() warning"; "a project note over the caps is skipped with a warning". `test/config.test.ts`: "tools (suite and top level) and agent.notesDir are read from sdlc.config.json; a notesDir outside the root is refused". `test/pipeline.test.ts`: "a committed project note reaches the stage prompt it names", with a note matching the fixture's runner committed under `.sdlc/notes/`. `test/projects.test.ts` (which calls `doctor`): "doctor warns about an untracked project note".

## Not in this plan

Python or Behave runner support (the `non-node-ecosystem-support` backlog item); notes per user (outside the project repo); notes fetched from a URL; a UI for writing notes; tools the settings do not name (Docker, databases); a `lint` facet; triage prompts; per-tool model or harness choices; the pipeline fixing the Vitest error itself; the `red-tests-minimal-case-tests` backlog item.
