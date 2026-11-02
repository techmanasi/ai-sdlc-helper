# Tool notes: stage-specific prompt notes, loaded only for the tools a project uses

Status: plan, not implemented. Worked example: Vitest's "Timeout calling onTaskUpdate" (see `docs/investigations/vitest-ontaskupdate-timeout.md`).

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
- With `tests.retry` on, a failure that names no file re-runs the whole suite (`src/runners/run.ts:29-31`); a lighter second run may pass, hiding the issue as flaky.

So no note can help Implement until the run's error reaches `tests.log`. This is slice 1.

### A file-level claim cannot be written today

- `src/testcheck/keys.ts:113-120` parses `test-issues.md` lines `<file> :: <name> :: <why>` into the key `<file>::<name>`.
- `src/testcheck/checks.ts:75-86` (`precheck`): every claimed key must exist in the results (`:82`), and every failing key must be claimed (`:83`). The justification must match `/(spec|plan|decision|round|S-R|isolat|mock)/i` (`:84`); "isolation defect" passes.
- `SUITE_FAILED = '<suite failed to run>'` (`src/testcheck/keys.ts:44`) is the file-level name, and the results already turn each `suiteErrors` entry into `<file>::<suite failed to run>` (`keys.ts:81`).
- Today the run has no suite error, so `test/x.test.ts :: <suite failed to run> :: …` fails precheck with "claimed test does not exist".
- Conclusion: no new claim format and no parser change are needed if the runner records the run error as a suite error on the file that caused it (slices 1 and 2). The Implement section of the note then tells the agent to claim `<file> :: <suite failed to run> :: isolation defect: …`.
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

`lint` (`settings.ts:69`) is a free-form command with no tool id, so it is not a facet in v1.

## Design

### Files

`assets/prompts/notes/<facet>/<value>/<issue>.md`, e.g. `assets/prompts/notes/runner/vitest/rpc-timeout.md`. One file per issue, with one `## <stage>` section per stage it speaks to (stage ids from `src/pipeline/context.ts:14`: `red-tests`, `implement`, `test-repair`, `test-audit`, …). A section may start with one line `when: <regex>`; see triggers.

### Selection and order

`toolNotes(stage, config, signals, notesDir)` in a new `src/config/toolNotes.ts`:
1. Facet values in use: runner, language and packageManager from every suite; harness from the stage's own setting, else the project's; codeIndexer by name.
2. For each matching `<facet>/<value>/` folder, each file's `## <stage>` section, kept if it has no `when:` line or its regex matches the stage's signal text.
3. Order: facets in the table's order, then file name. Joined under one heading line, appended after `parts/tools.md`.
4. Mixed projects: a suite-level note (runner, language, packageManager) gets a first line "Applies to <dir>/ (<value>)" when the project has more than one suite.

Unknown stage headings, unknown facets or values, or a bad regex throw `SetupError` (the same failure as a missing prompt file, `prompts.ts:21`), so a broken note fails the first test that renders a prompt.

### Triggers

| Stage | Signal text for `when:` |
|---|---|
| Red tests | none (sections here have no `when:`; prevention applies always) |
| Implement | `<log>/tests.log` of the last gate run |
| Test repair, Test audit | `<docs>/test-issues.md` (the claim must cite the symptom) |
| others | none |

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
| `{{RUNNER_NOTES}}` on branch `feat/vitest-red-tests-note` | do not merge it; slice 3 replaces it and moves `parts/vitest-note.md` into `notes/runner/vitest/rpc-timeout.md` as its `## red-tests` section | merge, then migrate: ships a placeholder, a test and a part file that the next PR removes. The branch's reproduction (3 of 3 runs with the error, 3 of 3 clean with the note's fix) and its Vitest source citations carry over |
| Finding the file to claim | the runner records the run error on the file(s) that ran 60s or longer | a new claim form: changes the parser and every check that keys on test names; asking the agent to guess: precheck would still reject a claim for a key the results do not hold |

## Slices (each its own PR, each shippable alone)

1. **A failing run with no failing test says why** (all runners). In `src/runners/run.ts` (after the adapter returns, near `:69-74`): when `exitCode !== 0`, no test failed and there is no suite error, add a suite error `{ file: null, message: <last 4000 characters of the runner's output> }`, as `noReport` does (`types.ts:120-123`). Adapters return their output for this. `tests.log` then shows `ERROR (unknown file): failed to run` with the message.
   Tests: `test/runners.test.ts`, new test "a run that exits non-zero with every test passed reports the runner's output as a suite error": a stand-in runner command writes a passing report and exits 1 with a message; the result has one suite error holding that message and `ok` false. `test/gates-failfast.test.ts`, new test "tests.log shows the error of a run with no failing test", through `testsPass`.
2. **Vitest names the blocking file.** In `src/runners/vitest.ts` / `parseJestLike` (`src/runners/jest.ts:8`): keep each file's `startTime`/`endTime`; when slice 1's error holds `Timeout calling "`, put it on each file that ran 60000ms or longer (else keep `file: null`). Precheck then finds `<file>::<suite failed to run>`.
   Tests: `test/runners.test.ts`, "a Vitest RPC timeout is put on the file that ran over 60s", with a recorded JSON report and output from the reproduction; `test/testcheck.test.ts`, "a file-level claim on a Vitest RPC timeout passes precheck", running `precheck` on that result and a claim line.
3. **Notes mechanism, Red tests only.** `src/config/toolNotes.ts`; calls in `renderPrompt` (`prompts.ts:19-35`) and `renderSkill` (`skills.ts:21-40`), with the config and signals passed in from `runAgent` (`agent.ts:117-122`) and `stages.ts:327`; `assets/prompts/notes/runner/vitest/rpc-timeout.md` with a `## red-tests` section (the text of `parts/vitest-note.md`). Skills map to stages by name, `tdd-loop` to both red-tests and implement.
   Tests, new `test/tool-notes.test.ts` (each compares against sections read from the note file at test time, never against wording): "a note loads for the stage and runner it names and for no other runner" (all five runners); "a mixed project gets a runner's note once, naming its suite folder"; "the red-tests skill gets the note for a Vitest project only"; "an unknown stage heading, facet or value, or a bad when: regex, is refused"; "a section over 120 words or a stage over 200 words of notes is refused"; and the existing "every shipped stage prompt renders without a placeholder left" (`test/pipeline-units.test.ts:156`) keeps passing.
4. **Symptom-gated sections for Implement, Test repair and Test audit.** Add those three sections to `rpc-timeout.md` with `when: Timeout calling "onTaskUpdate"`. Implement: the run failed with no failing test; claim `<file> :: <suite failed to run> :: isolation defect: …` and do not change source. Test repair: confirm the file blocks over 60s, then make its setup async or add a `beforeEach` that awaits a captured `setImmediate`; nothing else. Test audit: that change adds no skip and drops no assertion, so it is a valid isolation repair.
   Tests: `test/tool-notes.test.ts`, "a when: section loads only when the stage's signal text matches" (Implement with and without the error in `tests.log`; Test repair and Test audit with and without it in `test-issues.md`). `test/pipeline.test.ts` already records every prompt through the fake agent (`r.prompts`, used at `:44-48`): new test "Implement and Test repair get the Vitest note only after a run fails with the RPC timeout", with a Vitest-runner fixture whose test command prints the error and exits 1.

## Not in this plan

Notes supplied by a project or user; tools the settings do not name (Docker, databases); a `lint` facet; triage prompts; per-tool model or harness choices; the pipeline fixing the Vitest error itself; the `red-tests-minimal-case-tests` backlog item.
