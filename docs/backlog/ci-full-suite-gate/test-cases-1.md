# CI full-suite gate — test matrix

Sources: `specs-1.md` and `plan-1.md`. This is the Red tests deliverable; source code is unchanged. IDs below are included in Vitest test titles; parameterized rows expand into individual cases.

## Test approach

Tests import the real configuration resolver/editors, gates, PR helpers, pipeline stages and run-view builder. New modules are imported at test execution time using the APIs proposed by the plan (`allow-failures.ts`, `ci.ts`); their absence is a failure, never a skip or a passing existence check. Stage tests mock the reusable CI step to isolate orchestration; CI-step tests exercise the actual step with mocked external command results. `vi.fn` and `vi.mock` isolate subprocesses, agent execution and runner results. Filesystem fixtures use temporary directories and asynchronous setup/cleanup; small synchronous report writes simulate a synchronous artifact-download command. Timed waits use fake timers, without changing production timeouts or worker configuration.

No test inspects test-file contents or documentation. JSON configuration, status and runner reports, and runtime `.log` output are behavioral inputs/outputs. Paths such as `test/red.test.ts` are test identities in fixture reports, not files read by tests. Markdown output and documentation are reviewed separately.

## Automated matrix

### Configuration — `test/config/ci-full-suite.test.ts`

| ID | Spec | Input / action | Expected behavior |
| --- | --- | --- | --- |
| C01 | 2.1–2.3, AC1 | No new settings | Local mode, 60 minutes, empty allow list; no config error. |
| C02 | 2.1–2.2, AC2 | Project only; personal over project; env over both; empty env; explicit env local | Correct independent mode/wait precedence; empty env is unset. |
| C03 | 2.1, AC3 | Environment mode `remote`, `CI`, whitespace, `0` | Reject; error includes variable, bad value and allowed values. |
| C04 | 2.2, AC3 | Environment wait zero, negative, fraction, non-number, Infinity | Reject; error names variable and bad value. |
| C05 | 2, AC3 | Invalid project enums/numbers; allow list wrong shape, null, empty entry or non-string | Reject with config source and key; bad values identified where applicable, even if environment overrides them. |
| C06 | 2, AC3 | Invalid personal mode/wait under valid env overrides | Invalid source still rejected; personal source and key identified. |
| C07 | 2.2–2.3 | Minimum wait 1; file and per-test allow entries; unrelated env allow variable | Project allow entries preserved; no environment allow override. |
| C08 | Plan step 1 | Save valid project settings and personal overrides with real editors | Edits accepted, registry persisted, resolver observes personal precedence. |
| C09 | Plan step 1 | Invalid project and personal editor patch | Edit rejected; existing saved JSON/registry unchanged. |

### Allow matching — `test/pipeline/allow-failures.test.ts`

| ID | Spec | Input / action | Expected behavior |
| --- | --- | --- | --- |
| A01 | 2.3 | Parse file-only and file-plus-full-name syntax, including another ` > ` in the name | File pattern and optional full name retained. |
| A02 | 2.3, 8.2–8.4 | Exact file, glob, recursive glob, mismatched file, exact/mismatched/missing name, regex characters in name | Root-relative glob semantics; literal, exact full-name matching; per-test entry cannot match without a name. |
| A03 | 8.4 | One allowed and one unrelated failure | Correct allowed/blocked partition. |
| A04 | 2.3, 8.4, AC16 | Red failure matches whole-file or per-test entry | Remains blocked; WARNING names entry, file and test. |

### Local gates — `test/pipeline/ci-gates.test.ts`

| ID | Spec | Input / action | Expected behavior |
| --- | --- | --- | --- |
| G01 | 6 | CI available, scoped red targets pass | Only targeted runner call; no full-suite follow-up. |
| G02 | 3, 4.3, 6 | Local mode or CI fallback | Existing target-first/full-suite gate behavior retained. |
| G03 | 8.4, AC16 | Every failure allowed, in both modes | Gate passes, WARNING visible, failure listed in runtime test log. |
| G04 | 8.4 | Allowed plus unallowed failures | Gate remains red. |
| G05 | 2.3, 8.4 | Red report identifies a failure matched by allow list | Gate red with protection WARNING. |
| G06 | 8.4 | Runner/file-load error with broad allow glob | Remains blocking; process errors are not allowed tests. |
| G07 | 6–7 | Implement has prior CI side-effect file | Scoped gate includes red and side-effect files in one run. |
| G08 | 6–7 | Unit gate passes, integration command exits 0 or 1 | Real successCheck still invokes integration locally and honors its result. |

### PR lookup and lifecycle — `test/pipeline/ci-pr-status.test.ts`

| ID | Spec | Input / action | Expected behavior |
| --- | --- | --- | --- |
| P01 | 5.1, 10.2; plan step 3 | Sync PR response contains draft/check metadata | Metadata preserved; fields requested; same PR URL shares cached response. |
| P02 | 5.1, 10.2 | Async web PR refresh | Draft/check fields survive async parsing. |
| P03 | 5.1 | Read at 0, 59,999 and 60,000 ms | Existing 60-second cache reused and expired at boundary. |
| P04 | 4.2, AC5 | No existing PR; request draft against release base | gh creation includes draft, head and selected base. |
| P05 | 4.2, AC8 | Existing open ready PR | Reused without create or conversion. |
| P06 | 9 | Mark existing PR ready; command succeeds/fails | Calls gh ready and returns success/failure. |

### CI step — `test/pipeline/ci-step.test.ts`

| ID | Spec | Input / action | Expected behavior |
| --- | --- | --- | --- |
| I01 | 4.2 | Available remote/gh/PR | Availability true; push uses origin and upstream tracking. |
| I02 | 4.3, AC20 | No origin | Unavailable: no remote; no push. |
| I03 | 4.3, AC20 | gh installation or auth command fails | Exact missing-gh or auth reason. |
| I04 | 4.2–4.3 | Existing closed or merged PR | Exact PR-is-closed/merged fallback. |
| I05 | 5.2, AC9 | Completed success/skipped/neutral checks and successful commit status | Green with no failures. |
| I06 | 5.1–5.2 | Queued, in-progress or pending work then success | Remains pending before 60 seconds; polls to green. |
| I07 | 4.3, 5.2, AC21 | No checks for three minutes | Unavailable: no workflow; never empty-rollup green. |
| I08 | 5.3, AC19 | Registered work still running at two-minute limit | Timed-out result. |
| I09 | 5.2 | PR success describes another head SHA | Cannot report pushed head green. |
| I10 | 4.4 | Missing or malformed downloaded artifact | Null report and correct named artifact download request. |
| I11 | 4.4 | Jest/Vitest JSON report | Parsed failure file, full name, status and message. |
| I12 | 8.1, 8.3, AC12–14,16 | Native report; base fails, allow match, rerun passes, or persistent new failure | Pre-existing before allowed; allowed; flaky after one failed-job rerun; otherwise side-effect red with file/diagnostics/run link. Non-blocking failures emit WARNING. Rerun at most once. |
| I13 | 8.2–8.3, AC15 | Cancelled, timed_out, startup_failure, also failing base | Infrastructure wins before base comparison; green with warnings. |
| I14 | 8.2, AC17 | No artifact; allowed files, per-test-only entry, mixed allowed/unallowed files, or log without test output | Check classification; per-test entries cannot allow; all failing files must be allowed; no-test-output is infrastructure; no files added to local targets; missing-report message once per invocation. |
| I15 | 4.3 | Initial push error has multiple lines | Fallback reason contains only first error line. |
| I16 | 8.1 | Fetch base results with a distinct branch head and merge-base | Resolve merge-base against configured base, query that commit and parse its failed-test identity. |

### Stage orchestration — `test/pipeline/ci-stages.test.ts`

| ID | Spec | Input / action | Expected behavior |
| --- | --- | --- | --- |
| S01 | 4.1–4.2, AC5,7 | Red gate passes with createPr off | Availability/PR step after commit and test lock; no CI wait in Red tests. |
| S02 | 4.1, AC6 | Red tests unexpectedly pass before implementation | Red gate exits 1; no PR availability step or push. |
| S03 | 3, AC4 | Local Red tests and Implement | No CI interaction or per-attempt commit/push. |
| S04 | 4.3, AC20 | Each initial unavailable reason | Fallback context/status set and exact CLI message. |
| S05 | 7.1, AC11,23 | Locally green attempt | Named attempt commit and push precede CI wait on current SHA; round header emitted. |
| S06 | 7.1, AC10 | Local gate fails twice | Shared attempt budget used; no commit/push/wait. |
| S07 | 7.3, AC12 | First CI red with side effect, second green | Second agent attempt; side-effect file accumulated; two waits. |
| S08 | 7.2, 8.5 | CI green with non-blocking warnings | Finish after one agent attempt. |
| S09 | 5.3, AC19 | CI timeout | Exit 2; timed-out status text and FROM=implement recovery hint. |
| S10 | 4.3, 7.2, AC21 | First wait has no workflow | Switch to fallback and rerun local gate in current attempt without another agent. |
| S11 | 9, AC7 | Finalise with existing CI PR and createPr off | Existing finalise path used; existing PR marked ready. |
| S12 | 5.4, AC19 | Pause then resume unchanged pushed head | Resume waits before any further agent and can finish without another attempt. |
| S13 | 7.2, AC18 | CI side effects persist | Shared attempt limit reached; Implement returns failure to pipeline. |
| S14 | 7.1 | No files to commit | Wait on current SHA; no empty commit. |
| S15 | 4.3, AC22 | Push fails after CI reachable | Pause exit 2 with recovery hint; no fallback. |

### Run-page payload — `web/test/runs/ci-view.test.ts`

| ID | Spec | Input / action | Expected behavior |
| --- | --- | --- | --- |
| V01 | 10.2, AC24 | Each of seven CI states in status JSON | Real runView exposes state, PR and applicable failures/warnings/fallback reason. |
| V02 | 10.2 | Draft or ready PR metadata | Draft flag preserved for label. |
| V03 | 3, 10.2, AC4 | Local run without CI state | No CI payload. |
| V04 | 10.2 | Status changes running to green between reads | Refreshed view observes green. |

## Review items — no automated document or test-source assertions

| ID | Requirement | Review procedure / expected evidence |
| --- | --- | --- |
| R01 | 2.4, AC25 | Review README for all three settings, defaults, overrides/precedence, draft creation, Implement waiting and example `sdlc-test-report` upload step. |
| R02 | 2.4, 10, AC25 | Review docs/web-ui.md for CI line and per-round output. |
| R03 | 4.2, 8.5 | Inspect generated brief PR link and ci-failures.md from a fixture/real run; each non-blocking failure has check, identity when known, category and run link. Automated tests deliberately do not read Markdown. |
| R04 | Task constraints | Review diff: only allowed test files and this backlog directory changed; every test imports/runs real code; no test scans tests or documentation; no self-referential checks, skipped feature checks or duplicate production algorithm. |
| R05 | 5.1, 12 | Review implementation for reuse of existing PR poller/cache and no new packages. |

## Additional end-to-end acceptance checks

These checks require the implemented feature and/or a disposable GitHub repository. They are **manual coverage**, not claims of automated coverage in the files above.

| ID | Spec | Scenario and expected evidence |
| --- | --- | --- |
| E01 | 4, 9 | Run from Red tests through Finalise with createPr off; one draft PR only, correct recorded base, link persisted, then ready; existing open draft/ready PR reused; no squashing. |
| E02 | 7.1, 9 | Dirty baseline, secret/generated/oversized files and Review edits: attempt/final commits use existing filtering; only eligible new changes committed; unchanged already-classified head does not trigger duplicate CI work. |
| E03 | 6–7 | Preliminary=full forced scoped in CI mode; repaired red files scoped in Implement/Test repair/Review; only Implement includes historical side-effect files and waits for CI; Review pushes without waiting. |
| E04 | 4.3, 7.2 | Initial fallback and no-workflow fallback keep full local gating for remaining Implement attempts, Test repair and Review; no per-attempt commits after fallback; Finalise reuses an already-opened PR. |
| E05 | 5.4 | Resume from a new process: unchanged pushed head waits without consuming an attempt; changed/unpushed head starts agent normally; timeout attempt budget preserved. |
| E06 | 7.2–7.3, 8.5 | Exhaust CI and local failures in alternating order: top-level GREEN GATE FAILED after N attempts, latest failure log correct; agent receives only side effects with check/file/name/message/run URL and accumulated targets. |
| E07 | 8 | Multiple checks/tests, missing base results/report, same-name test in a different file, a red test matching CI allows, flaky rerun still failing, and base/latest-completed merge-base selection: conservative side-effect handling and classification order. |
| E08 | 4.4, 8.2 | Missing/unparseable artifact across multiple rounds warns once for the whole run; check-level counts replace test counts; node:test report also supported. |
| E09 | 4.3, 5.3 | Later CI-query failure pauses exit 2 without reporting green; persisted status and recovery hint survive restart. |
| E10 | 10, AC23–24 | Browser verification: seven CI states, PR link and draft/ready badges; streaming/poll updates; individual round blocks; local timestamps/duration and optional count clauses; no CI block for local failure/local mode/fallback; no CI line for setting off. |

## Execution

Run each file separately from the project root with `ai-sdlc-helper run --file <path>` using the seven paths listed above. Do not run the full suite for this Red tests deliverable. Missing planned modules/exports and missing feature assertions are expected red failures; configuration/collection failures unrelated to the feature must be distinguished from them. No production implementation is added to make these tests pass.

### Observed baseline — 2026-11-09

Every file was executed with the command above. Vitest initially needed permission to write its temporary config cache through the shared node_modules directory; the authorized reruns started normally.

| Test file | Passed | Failed | File errors |
| --- | ---: | ---: | ---: |
| test/config/ci-full-suite.test.ts | 4 | 26 | 0 |
| test/pipeline/allow-failures.test.ts | 0 | 13 | 0 |
| test/pipeline/ci-gates.test.ts | 6 | 5 | 0 |
| test/pipeline/ci-pr-status.test.ts | 2 | 5 | 0 |
| test/pipeline/ci-stages.test.ts | 3 | 18 | 0 |
| test/pipeline/ci-step.test.ts | 0 | 30 | 0 |
| web/test/runs/ci-view.test.ts | 1 | 10 | 0 |
| **Total** | **16** | **107** | **0** |

No tests were skipped. Existing behavior/control cases pass; feature cases fail because configuration, CI modules/exports and pipeline/view behavior have not been implemented. Missing-module failures are inside individual tests, not collection errors. Whitespace checks on all eight added files were clean. Source code and existing test files were not changed.
