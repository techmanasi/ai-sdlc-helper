# stabilise-pr-status-tests

Type: bug
Priority: P2 (normal)

## Problem
test/pr-status.test.ts has two timing-sensitive tests: "a cold read answers pending at once, the refresh runs in the background, and the next read has the value and its age" and "a refresh that changes the result tells the listeners; one that does not, does not". During the config-modal-keyboard run they failed and passed on retry in the Implement green gate, and again after Review. Under a loaded machine (the full suite takes 15 to 17 minutes) the first one failed outright with "Error: timed out". The retry hides it, but a flaky gate wastes time and can fail a run. Both tests came from the change that made the PR status tests wait for conditions instead of fixed delays.

## Expected behaviour
- Both tests pass reliably when the machine is loaded: run the file 50 times under CPU load with no failure.
- No test relies on a fixed delay or on a wait shorter than the code's own timeout; each waits for the condition it checks (test/wait.ts eventually) with a limit well above the code's PR_TIMEOUT_MS.
- The retry warning "flaky test failed, then passed on retry" no longer appears for these tests.

## Decisions
- Fix the test's waiting and its fake gh, not the production timeout or the cache TTL.
- If a test only passes by loosening an assertion, stop and say so instead.

## Scope
- In: test/pr-status.test.ts and test/wait.ts.
- Out: src/pipeline/finalise.ts behaviour, other flaky tests, the retry mechanism itself.

## Tests
- The two tests, run repeatedly under load (a script that runs the file in a loop with parallel CPU burners), never fail.

## Docs
-
