# Test suite speed: findings and plan

Status: baseline measured, no test changed yet. Date: 2026-11-08.

## Goal

Cut total wall time of `npm test` (root `test/` and `web/test/`) by finding redundant tests and merging tests that share one flow. No test may get slower, no coverage may be lost, and no distinct assertion may be dropped.

## Baseline (run 1)

Measured in a scratch copy of the working tree (not the repo), default `vitest.config.ts` (at most 4 workers), JSON reporter.

- Wall time: 10m52s (user 1m18s, sys 0m53s, so the run is waiting on processes and disk, not CPU).
- 612 tests: 607 passed, 5 failed.
- Only one run so far. The earlier parked investigation saw about 13 minutes and noisy timings, so the spread is not known yet.

### Where the time goes

Summed per-test time, top files:

| File | Tests | Seconds |
|---|---|---|
| `web/test/triage.test.ts` | 29 | 472 |
| `test/runs.test.ts` | 27 | 427 |
| `web/test/server.test.ts` | 22 | 223 |
| `test/pipeline-pauses.test.ts` | 5 | 193 |
| `test/pipeline.test.ts` | 6 | 137 |
| `test/pipeline-cli.test.ts` | 5 | 128 |
| `test/pipeline-resume.test.ts` | 5 | 118 |
| `test/changes.test.ts` | 10 | 100 |
| `test/setupBranch.test.ts` | 12 | 86 |
| `test/testcheck.test.ts` | 27 | 64 |

Slowest single tests are 30 to 58 seconds each, all full pipeline runs or server runs (`pipeline-cli` integration 58s, `pipeline-pauses` Spec questions 50s, `pipeline-resume` 39s, `pipeline.test` full run 38s).

Reading: the cost is per-test setup (fresh git repo, worktree, server, spawned node and git processes), not test count. The longest file (`triage`, 472s of test time) sets a floor for the wall time while workers are capped at 4 (`vitest.config.ts`, kept low on purpose because process start-up contention caused timeouts).

### Known failures in the baseline

All five touch code that has uncommitted changes in the working tree:

- `test/pipeline-resume.test.ts`: failed repair agent says how to resume
- `test/pr-status.test.ts`: cold read answers pending (timeout)
- `test/runs.test.ts`: discard-stage restores uncommitted stage files
- `web/test/completed-gh.test.ts`: another request is served while PR statuses are fetched
- `web/test/trace.test.ts`: one request writes as many spawn:git lines as the counting git sees (timeout)

See "Relevance of the uncommitted changes" below for whether they are caused by the working-tree changes.

## Plan

1. Baseline: repeat the timed run (each takes about 11 minutes, so fewer than five; report spread honestly). Add a V8 coverage run for the before/after comparison.
2. Find merge candidates in the heavy files: tests that build the same expensive fixture (repo, worktree, server, spawned pipeline) and assert on different facets of one flow. Share the setup with `beforeAll` or group the assertions into one flow test.
3. Keep tests separate where they mutate shared state, cover different failure modes, or depend on fake timers.
4. Replace real waits with fake timers or event-driven waits only where safe (`test/wait.ts` polls at 20ms; the fixed `sleepMs` stubs in `web/test/triage.test.ts` are the main candidates).
5. Redundancy check: flag tests whose covered lines are a subset of another test's and which assert nothing distinct; remove only with that evidence.
6. Re-measure after each batch.

## Acceptance criteria

1. Median wall time lower than baseline, outside the noise band.
2. Same set of passing tests apart from listed merges and removals, each justified. Every original assertion survives in the merged test.
3. Statement and branch coverage not lower than baseline.
4. No test slower beyond noise.
5. `npm run check` exits 0 three times in a row.
6. A merged test, with one assertion deliberately broken, fails with a message that names the failing facet, and passes when run alone with `-t`.
7. Repo rules hold: tests exercise real code, none assert on Markdown or comments.
8. Result reviewed by an agent on a different model, with PASS or FAIL per criterion.

## Out of scope

New features or tests for uncovered code, production rewrites (beyond making a test deterministic), CI/Node/lint changes, the parked flaky `web/test/triage.test.ts` "saved and skipped drafts" investigation, and removing tests that cover distinct behaviour.

## Relevance of the uncommitted changes

Checked by running the 5 baseline failures one at a time (no load) on a clean checkout of HEAD (`b8dbba5`) and on a copy of the working tree.

| Test | HEAD | Working tree |
|---|---|---|
| `completed-gh` another request is served | pass | **fail** (`expected 6 to be 3`) |
| `pipeline-resume` failed repair agent says how to resume | pass | **fail** (missing the `agent 'test-repair' failed` line) |
| `runs` discard-stage restores uncommitted files | test does not exist | **fail** (`ready to retry` not in output) |
| `trace` one request writes as many spawn:git lines | pass | **fail** (`eventually` times out) |
| `pr-status` cold read answers pending | pass | pass alone, timed out in the full run (load-sensitive) |

Conclusions:

- Four of the five failures are deterministic and come from the uncommitted changes, not from load or from my copy. The fifth (`pr-status`) is load-sensitive.
- The uncommitted changes fall into two groups:
  1. **Unrelated to test speed**: an agent-lifecycle and codex usage-limit change (`src/pipeline/agent.ts`, `agent-process.ts`, the `harness/*` files, `gates.ts`, `stages.ts`, `run.ts`, `permissions`, `runs`, `web/server`, the web UI, `docs/agent-lifecycle-adapters.md`, `docs/incidents/`) and the tests that go with it (`agent-failure-and-limits`, `pipeline-agents`, `permissions`, `pipeline`, `run-stream`, `runs`, `agent-process`). They are the likely cause of the `pipeline-resume` and `runs` failures, since both assert on agent-failure and discard-stage output.
  2. **Related to test speed**: replacing fixed sleeps with polling (`test/wait.ts` `eventually`, and the edits in `pr-status`, `completed-gh` and `trace`). This is the "replace real waits" item in the plan. As written, the `completed-gh` and `trace` versions fail, so they are not safe to build on yet.
- Consequence for this work: the speed work should start from a green base. Either commit or park the agent-lifecycle change first, or take the speed work from HEAD and bring over only the wait edits once they pass. Edits to `runs.test.ts`, `pipeline.test.ts`, `trace.test.ts` and `pr-status.test.ts` would also conflict with the uncommitted changes in the same files.

## Resuming this work

### Open decision

Which base to work from: (1) commit or park the agent-lifecycle work first, or (2) work from HEAD and bring over only the polling edits once they pass. Recommended: (2). Not decided yet.

### How the work is structured (from the /deepen brief)

One combined prompt, three passes in this order, each with a conflict noted rather than averaged away:

1. **Test-infra engineer (senior)**: measure first (5 timed runs, median and spread, per-file ranking, pool/isolate experiments, count spawns and fixed sleeps). May conclude merging is not worth it.
2. **Vitest maintainer (senior)**: merge only tests that share an expensive setup and assert on facets of one flow; keep isolation where state is mutated or failure modes differ; use fake timers or event-driven waits for safe real waits; confirm each merge with a manual mutation of 3 to 5 lines of the code under test.
3. **New contributor (novice)**: runs last, on the branch. Cold-reads each merged test, breaks one assertion and checks the failure names the facet, runs each merged test alone with `-t`, lists unclear names or hidden ordering.

Open conflict to decide: how aggressively to merge. Recommendation: merge a group only if the measured saving is real and the novice check passes.

The final review must be by an agent on a different model from the one doing the work (an Opus reviewer if the worker is Sonnet), given only the goal, the acceptance criteria and the result, returning PASS or FAIL per criterion with the evidence it checked.

### Working method

- Do not work in the live repo: copy it. `rsync -a --exclude .git --exclude graft --exclude dist <repo>/ <scratch>/work/` then `rsync -a <repo>/node_modules/ <scratch>/work/node_modules/` (the first excludes every `dist`, including the ones inside `node_modules`, so the second step is required; skipping it gives `ERR_MODULE_NOT_FOUND` for vitest).
- Timed run: `npx vitest run --reporter=json --outputFile=<out>.json`, in the background, since a run takes about 11 minutes. Check no other vitest run is going first (`ps aux | grep vitest`), and wait for a quiet machine; load changes the results (see the parked-slow-suite memory).
- Per-file and per-test ranking is computed from the JSON: `testResults[].assertionResults[].duration`, summed per file.
- To check one test alone: `npx vitest run <file> -t "<part of the test name>"`. If every test in the output is `skipped`, the name did not match (that is how the new `discard-stage` test was found to be absent at HEAD).
- A clean HEAD for comparison: `git worktree add --detach <scratch>/head HEAD`, copy `node_modules` into it, remove it with `git worktree remove --force` afterwards.
- Subagents must not wait on runs over 5 minutes (prompt cache). Use a subagent to write code; the parent runs the long timed runs.

### Not done yet

- Only one timed run exists (10m52s); the spread is unknown. Plan: repeat, with fewer than five runs, and say so.
- No coverage baseline yet (`npx vitest run --coverage`, needs the V8 coverage provider; check it is installed).
- No merge candidates chosen. First look: the 29 tests in `web/test/triage.test.ts` and 27 in `test/runs.test.ts` (each builds its own repo, server or worktree in `beforeEach`), then `server.test.ts`, `pipeline-pauses`, `pipeline-resume`, `pipeline-cli`, `changes`. Look for shared fixtures and for tests that start the same pipeline run and assert on different parts of its result.
- The slowest single tests (30 to 58 s each) are the first ones to examine: `pipeline-cli` integration (58 s), `pipeline-pauses` Spec questions (50 s) and Plan questions (39 s), `pipeline-resume` resumed Implement (39 s), `pipeline.test` full run (38 s), `runs` changes and restart (38 s and 36 s), `trace` spawn:git (34 s), `changes` mark (32 s).
- No redundancy analysis has been run (no per-test coverage comparison yet).
- No independent review yet.

### Related

- Memory note `parked-slow-suite-investigation` (earlier diagnosis, flaky `triage` test "saved and skipped drafts", and the worker-cap rationale in `vitest.config.ts`).
- `docs/investigations/vitest-ontaskupdate-timeout.md` (solved; not a cause of slowness).
- Repo rules that apply: `npm run check` before every commit and push; tests exercise real code and never assert on Markdown or comments; work goes through PRs into `main` with a merge confirmed by the user.
