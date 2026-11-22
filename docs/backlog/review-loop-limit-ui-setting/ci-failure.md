# CI failure of the pull request

Pull request: https://github.com/techmanasi/ai-sdlc-helper/pull/187
Failing checks: check (18), check (20), check (22), check (24)

### Run 44881488286

```
[UNKNOWN STEP]
[command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules --depth=1 origin +8520f5065660e5444d100d4209c1bdc7309916e3:refs/remotes/pull/187/merge
^[[33m^[[2m✓^[[22m^[[39m start^[[2m > ^[[22mrecords failing and paused exit codes; copies a brief not committed yet ^[[33m 500^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m start^[[2m > ^[[22msuite setup commands run once in a new worktree; a failed setup is recorded and runs again on the next start ^[[33m 453^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m tests.retry and tests.maxWorkers^[[2m > ^[[22mrun: the settings are the defaults, --retry, --no-retry and --max-workers <n|auto> override them ^[[33m 1282^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m session failures^[[2m > ^[[22mbad items.json (not JSON, or missing): error names the file, done 1 ^[[33m 301^[[2mms^[[22m^[[39m
WARNING: 7 PR status check(s) of shop failed at start-up (see /tmp/web-completed-6NOVnh/shop/.git/sdlc-runs/errors.log)
^[[33m^[[2m✓^[[22m^[[39m a full run^[[2m > ^[[22mthe red gate refuses a new test that already passes even when other new tests fail, naming it ^[[33m 470^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m a full run^[[2m > ^[[22mthe red gate accepts new tests that all fail, and does not count a skipped new test as passing ^[[33m 1251^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m a full run^[[2m > ^[[22ma failure that passes on the retry is reported as flaky and does not fail the gate ^[[33m 919^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m Resolve conflicts stage^[[2m > ^[[22manswering no says again what the last attempt found, that nothing changed, and how to retry; the run is paused, not failed ^[[33m 601^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m resuming^[[2m > ^[[22ma resumed Implement reads a fresh tests.log, and tests the developer committed meanwhile are not a guard failure ^[[33m 1123^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m a re-attempt^[[2m > ^[[22ma start from Spec sets aside an earlier pull request's CI failure, merge failure and review comments; a resume at Implement keeps them ^[[33m 1186^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m Test repair^[[2m > ^[[22ma failed repair agent says how to resume; the resumed run locks the tests at the branch head and finalises ^[[33m 1472^[[2mms^[[22m^[[39m
^[[32m✓^[[39m test/agent-failure-and-limits.test.ts ^[[2m(^[[22m^[[2m13 tests^[[22m^[[2m)^[[22m^[[32m 29^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m Sync PR commits its files on the run's branch^[[2m > ^[[22ma push that failed is retried by the next sync with the same text ^[[33m 313^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m Sync PR commits its files on the run's branch^[[2m > ^[[22mci-failure.md is committed while the CI fails, and its removal is committed once the CI is green ^[[33m 307^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m through a real pipeline run^[[2m > ^[[22ma rejected repair leaves a failed status with no step (the banner does not stay on a dead run) ^[[33m 860^[[2mms^[[22m^[[39m
^[[31m❯^[[39m web/test/review-loop-limit.test.ts ^[[2m(^[[22m^[[2m12 tests^[[22m^[[2m | ^[[22m^[[31m12 failed^[[39m^[[2m)^[[22m^[[33m 4619^[[2mms^[[22m^[[39m
^[[31m   ^[[31m×^[[31m project Review loop limit^[[2m > ^[[22mround-trips valid settings and refuses -1 without writing^[[39m^[[32m 190^[[2mms^[[22m^[[39m
^[[31m     → expected 'sdlc.config.json: review.maxLoops: mu…' to match /review\.maxLoops.*whole number.*0 or…/i^[[39m
^[[31m   ^[[31m×^[[31m project Review loop limit^[[2m > ^[[22mround-trips valid settings and refuses 0.5 without writing^[[39m^[[32m 92^[[2mms^[[22m^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22mrejects override -1 before creating the run^[[39m^[[32m 80^[[2mms^[[22m^[[39m
^[[31m     → expected 200 to be 400 // Object.is equality^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22mrejects override '0.5' before creating the run^[[39m^[[32m 87^[[2mms^[[22m^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22mrejects override null before creating the run^[[39m^[[32m 76^[[2mms^[[22m^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22mrejects override '' before creating the run^[[39m^[[32m 92^[[2mms^[[22m^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22mrejects override false before creating the run^[[39m^[[32m 76^[[2mms^[[22m^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22mrejects override [ +0 ] before creating the run^[[39m^[[32m 71^[[2mms^[[22m^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22mrejects override 'nope' before creating the run^[[39m^[[32m 80^[[2mms^[[22m^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22mstops on the first finding at zero, then inherits one fix on another run^[[39m^[[33m 1540^[[2mms^[[22m^[[39m
^[[31m     → expected [ 'review', 'red-tests', …(2) ] to deeply equal [ 'review' ]^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22muses two fixes when the current project removed its tracked zero^[[39m^[[33m 709^[[2mms^[[22m^[[39m
^[[31m     → expected [ 'review' ] to deeply equal [ 'review', 'red-tests', …(5) ]^[[39m
^[[31m   ^[[31m×^[[31m web-launched Review^[[2m > ^[[22maccepts numeric overrides and completes when Review passes on the last allowed round^[[39m^[[33m 1526^[[2mms^[[22m^[[39m
^[[22m^[[39mUsing an object as a third argument is deprecated. Vitest 4 will throw an error if the third argument is not a timeout number. Please use the second argument for options. See more at https://vitest.dev/guide/migration
^[[33m^[[2m✓^[[22m^[[39m the integration suite^[[2m > ^[[22mruns after the unit tests; a failure fails the green gate with its log ^[[33m 832^[[2mms^[[22m^[[39m
^[[32m✓^[[39m web/test/no-gh.test.ts ^[[2m(^[[22m^[[2m1 test^[[22m^[[2m)^[[22m^[[32m 84^[[2mms^[[22m^[[39m
^[[32m✓^[[39m test/stage-no-artifact.test.ts ^[[2m(^[[22m^[[2m3 tests^[[22m^[[2m)^[[22m^[[33m 354^[[2mms^[[22m^[[39m
^[[31m⎯⎯⎯⎯⎯⎯^[[39m^[[1m^[[41m Failed Tests 12 ^[[49m^[[22m^[[31m⎯⎯⎯⎯⎯⎯⎯^[[39m
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mproject Review loop limit^[[2m > ^[[22mround-trips valid settings and refuses -1 without writing
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mproject Review loop limit^[[2m > ^[[22mround-trips valid settings and refuses 0.5 without writing
^[[31m^[[1mAssertionError^[[22m: expected 'sdlc.config.json: review.maxLoops: mu…' to match /review\.maxLoops.*whole number.*0 or…/i^[[39m
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22mrejects override -1 before creating the run
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22mrejects override '0.5' before creating the run
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22mrejects override null before creating the run
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22mrejects override '' before creating the run
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22mrejects override false before creating the run
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22mrejects override [ +0 ] before creating the run
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22mrejects override 'nope' before creating the run
^[[31m^[[1mAssertionError^[[22m: expected 200 to be 400 // Object.is equality^[[39m
^[[90m132| ^[[39m    expect(response.data.error).toMatch(/SDLC_REVIEW_MAX_LOOPS.*whole …
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22mstops on the first finding at zero, then inherits one fix on another run
^[[31m^[[1mAssertionError^[[22m: expected [ 'review', 'red-tests', …(2) ] to deeply equal [ 'review' ]^[[39m
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22muses two fixes when the current project removed its tracked zero
^[[31m^[[1mAssertionError^[[22m: expected [ 'review' ] to deeply equal [ 'review', 'red-tests', …(5) ]^[[39m
^[[41m^[[1m FAIL ^[[22m^[[49m web/test/review-loop-limit.test.ts^[[2m > ^[[22mweb-launched Review^[[2m > ^[[22maccepts numeric overrides and completes when Review passes on the last allowed round
^[[2m Test Files ^[[22m ^[[1m^[[31m1 failed^[[39m^[[22m^[[2m | ^[[22m^[[1m^[[32m113 passed^[[39m^[[22m^[[90m (114)^[[39m
^[[2m      Tests ^[[22m ^[[1m^[[31m12 failed^[[39m^[[22m^[[2m | ^[[22m^[[1m^[[32m1495 passed^[[39m^[[22m^[[90m (1507)^[[39m
AssertionError: expected 'sdlc.config.json: review.maxLoops: mu…' to match /review\.maxLoops.*whole number.*0 or…/i
AssertionError: expected 200 to be 400 // Object.is equality
AssertionError: expected [ 'review', 'red-tests', …(2) ] to deeply equal [ 'review' ]
AssertionError: expected [ 'review' ] to deeply equal [ 'review', 'red-tests', …(5) ]
Process completed with exit code 1.
[command]/usr/bin/tar xz --strip 1 --warning=no-unknown-keyword --overwrite -C /home/runner/work/_temp/33ae0879-830d-4f6a-b73d-2928ecb39ac2 -f /home/runner/work/_temp/b8ea01d1-186c-4b67-8d6a-bf055b67b21d
^[[33m^[[2m✓^[[22m^[[39m start^[[2m > ^[[22mrecords failing and paused exit codes; copies a brief not committed yet ^[[33m 606^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m start^[[2m > ^[[22msuite setup commands run once in a new worktree; a failed setup is recorded and runs again on the next start ^[[33m 486^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m flaky-suite guard^[[2m > ^[[22mwithout retry a flaky failure is reported; with retry only the failed file runs again and the test is listed as flaky ^[[33m 358^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m tests.retry and tests.maxWorkers^[[2m > ^[[22mrun: the settings are the defaults, --retry, --no-retry and --max-workers <n|auto> override them ^[[33m 2893^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m session failures^[[2m > ^[[22ma non-zero exit: error and done with that code; resume continues and can finish ^[[33m 314^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m session failures^[[2m > ^[[22mbad items.json (not JSON, or missing): error names the file, done 1 ^[[33m 414^[[2mms^[[22m^[[39m
WARNING: 7 PR status check(s) of shop failed at start-up (see /tmp/web-completed-6bmT92/shop/.git/sdlc-runs/errors.log)
^[[33m^[[2m✓^[[22m^[[39m a full run^[[2m > ^[[22mthe red gate fails when the new tests pass before implementation, and runs only the new tests: an unrelated failing test does not hide it ^[[33m 310^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m a full run^[[2m > ^[[22mthe red gate refuses a new test that already passes even when other new tests fail, naming it ^[[33m 670^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m a full run^[[2m > ^[[22mthe red gate accepts new tests that all fail, and does not count a skipped new test as passing ^[[33m 1973^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m a full run^[[2m > ^[[22ma failure that passes on the retry is reported as flaky and does not fail the gate ^[[33m 1194^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m Resolve conflicts stage^[[2m > ^[[22manswering no says again what the last attempt found, that nothing changed, and how to retry; the run is paused, not failed ^[[33m 627^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m resuming^[[2m > ^[[22ma resumed Implement reads a fresh tests.log, and tests the developer committed meanwhile are not a guard failure ^[[33m 1640^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m a re-attempt^[[2m > ^[[22ma start from Spec sets aside an earlier pull request's CI failure, merge failure and review comments; a resume at Implement keeps them ^[[33m 1601^[[2mms^[[22m^[[39m
^[[33m^[[2m✓^[[22m^[[39m Test repair^[[2m > ^[[22ma failed repair agent says how to resume; the resumed run locks the tests at the branch head and finalises ^[[33m 1948^[[2mms^[[22m^[[39m
```
