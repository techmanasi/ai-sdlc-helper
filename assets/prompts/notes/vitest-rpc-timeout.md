match: runner=vitest
## red-tests
Vitest note (only when a Vitest run reports 'Timeout calling "onTaskUpdate"', or "Vitest caught N unhandled error" while every test passes):
- Cause: a test file whose tests do only synchronous work (spawnSync, execSync, *Sync fs) never lets its event loop turn, so Vitest's replies go unread; past 60s the worker's call times out, likelier under parallel load.
- Prevent: do slow setup with async spawn or fs.promises; keep synchronous stretches short.
- Fix, in that test file only: make the blocking work async, or add `const tick = setImmediate; beforeEach(() => new Promise(r => tick(r)));` at the top (before any fake timers).
- Never raise testTimeout, set dangerouslyIgnoreUnhandledErrors, lower the worker count or edit the Vitest config.
## implement
when: Timeout calling "onTaskUpdate"
Vitest note (Vitest 3.x): the last test run failed with 'Timeout calling "onTaskUpdate"' although no test failed. A test file that does only synchronous work (spawnSync, execSync, *Sync fs) for 60 seconds or longer blocks its event loop; this is a test defect, not a source defect.
- The test log names that file in an `ERROR <file>: failed to run` line; if it names none, say so in your final message instead of claiming.
- Do not change source. Claim it in test-issues.md as `<file> :: <suite failed to run> :: isolation defect: <why>`, naming that test file.
- Never raise testTimeout, set dangerouslyIgnoreUnhandledErrors, lower the worker count or edit the Vitest config.
## test-repair
when: Timeout calling "onTaskUpdate"
Vitest note (Vitest 3.x): the claim is a test file that blocks its event loop. Confirm that the file ran for over 60s doing only synchronous work (spawnSync, execSync, *Sync fs). Then, in that test file only, either make the slow setup async (async spawn or fs.promises) or add at its top `const tick = setImmediate; beforeEach(() => new Promise(r => tick(r)));` (before any fake timers). Change nothing else: do not raise testTimeout, set dangerouslyIgnoreUnhandledErrors, lower the worker count, edit the Vitest config, or touch assertions.
## test-audit
when: Timeout calling "onTaskUpdate"
Vitest note (Vitest 3.x): a repair that only makes a blocking test file's slow setup async, or adds `beforeEach(() => new Promise(r => tick(r)))` with `const tick = setImmediate` at the top of that file, adds no skip and removes or weakens no assertion. On its own it is an isolation repair, not a weakening. Judge every other change in the diff as usual.
