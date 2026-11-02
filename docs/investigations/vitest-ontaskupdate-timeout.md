# Vitest "Timeout calling onTaskUpdate" unhandled error

Status: cause found and fixed. `test/setupBranch.test.ts` never returns to the event loop, so Vitest's RPC replies go unread until the file ends; under four-worker load the file takes 67 to 69s, past the 60s RPC timeout. Fix: `test/setup.ts` (registered in `vitest.config.ts`) turns the event loop once before each test. See "Mechanism" and "Fix".

## Symptom

```
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
```

- Printed at the end of `npm run check` as "Vitest caught 1 unhandled error", with `Errors  1 error`.
- All 38 files and 492 tests pass. Full runs take 584 to 720s.
- Seen on an idle machine, and again after a reboot (632s run).
- Vitest 3.2.x, 4 workers (`vitest.config.ts` caps `maxWorkers` at `min(4, cpus - 1)`).

## What the error is

- Vitest's worker-to-main RPC has a default timeout of 60s (`DEFAULT_TIMEOUT = 6e4` in `node_modules/vitest/dist/chunks/index.*.js`).
- The worker starts a timer for each call. If `onTaskUpdate` gets no reply in 60s, the worker throws, and the error is reported as unhandled.
- On the main side, the handler awaits `ctx._testRun.updated(...)`, which awaits each reporter event one after another (`updated()` in `cli-api.*.js`). A slow reporter or main process delays the reply.
- Either side being slow would produce the same message. It is not a failing test.

## Probes

Three temporary probes, wired through `vitest.probe.config.ts` (untracked, repo root):

| Probe | What it logs |
|---|---|
| `loop.ts` (setup file, every worker) | event-loop gaps over 3s, with the running test |
| `main.ts` (globalSetup, main process) | main-process event-loop gaps over 2s |
| `rep.mjs` (reporter) | start and end of each test file, and a poll for the unhandled error |

Results:
- No main-process stall over 2s in any run.
- No worker stall over 21s. Stalls of 8 to 21s appear in `runs.test.ts`, `pipeline-units.test.ts` and `runners.test.ts` (synchronous git and `spawnSync`, and the nested real `vitest` in `runners.test.ts`).
- The reporter's poll never logged the error before the end of the run, so I don't know when during a run it is raised.
- In the unprobed baseline run, one test (`pipeline-resume`, "a failed repair agent says how to resume...") took 62s and passed against a 60s `testTimeout`. That is a sign of timers being starved in that worker.
- Neither a 60s main stall nor a 60s worker stall was observed, so "something froze for a minute" does not explain it. Hypothesis only: the delay is in message delivery or in a main-side handler.

## Runs

Every row is a single run unless stated. The error is intermittent, so a clean single run is weak evidence.

| Files | Duration | Error |
|---|---|---|
| all 38, JSON reporter, no probe (first baseline run; duration not recorded here) | not recorded | no (the log had no error text) |
| all 38 (user's runs, idle machine, then after reboot) | 720s, 632s | yes, yes |
| all 38 with probe | 584s, 584s, 585s | yes (3 of 3) |
| `web/test/triage.test.ts` alone | 122s | no |
| the three long files: `web/test/triage`, `test/runs`, `web/test/server` | 251s | no |
| the other 35 files (all except those three) | 239s | yes |
| the six `pipeline*` files | 135s | no |
| group A: `changes`, `setupBranch`, `testcheck`, `edit-settings`, `runners`, both triage files, `backlog`, `view`, `projects` | 206s | yes |
| `changes`, `setupBranch`, `testcheck`, `edit-settings` | 59s | no |
| `runners`, `backlog`, `view`, `projects` | 25s | no |
| both triage files | 135s | no |
| group A without `runners.test.ts` (9 files) | 203s | yes |
| minimal set from the minimisation: both triage files + `setupBranch`, `edit-settings`, `backlog`, `view`, `projects` | 169s | no |

Notes:
- The filter `test/triage.test.ts` matches both `test/triage.test.ts` and `web/test/triage.test.ts`, so it always ran both. An absolute-path filter also ran both.
- Greedy minimisation (7 rounds, from `min.summary`), starting from the 9-file set and dropping one of seven candidates per round:

```
02:54:39 without test/changes.test.ts: ERROR REPRODUCED -> dropped
02:57:39 without test/setupBranch.test.ts: no error -> kept
03:00:33 without test/testcheck.test.ts: ERROR REPRODUCED -> dropped
03:03:16 without test/edit-settings.test.ts: no error -> kept
03:06:04 without test/backlog.test.ts: no error -> kept
03:08:52 without test/view.test.ts: no error -> kept
03:11:45 without test/projects.test.ts: no error -> kept
FINAL: test/triage.test.ts  test/setupBranch.test.ts test/edit-settings.test.ts test/backlog.test.ts test/view.test.ts test/projects.test.ts
```

- The final set did not reproduce the error when run alone (169s, clean). So the minimisation is unreliable: a "kept" result may be luck, and so may a "dropped" one. Do not treat that file list as the cause.

## Pattern (not a proof)

- Runs of about 200s or more with 4 workers busy showed the error: 203s, 206s, 239s, 584s, 632s, 720s.
- Shorter runs were clean: 25s, 59s, 122s, 135s, 135s, 169s.
- The one clean run over 200s, the 251s three-file run, only ever had 3 workers busy.
- This points at run length and how many files start and stop (a new forked worker per file), not at any one test file. Hypothesis only.

## Cross-test shared-state audit

Question: does any test change the state or outcome of another test, so they only fail together? No evidence of it.

- Each test file runs in its own forked process, so in-memory state does not leak between files.
- The only process env var a test writes is `SDLC_ALLOWED` in `test/permissions.test.ts`, and it restores it.
- Run registries live in each test's own temp repo (`.git/sdlc-runs`). Temp folders come from `mkdtemp`, and servers use port 0. No fixed paths or ports, and no `git config --global`.
- Eight files call the CLI or server without setting `AI_SDLC_HELPER_CONFIG_DIR`: `test/triage.test.ts`, `test/models.test.ts`, `test/pipeline-cli.test.ts`, `test/finalise-and-completed.test.ts`, `test/node.test.ts`, `test/fetch.test.ts`, `test/testcheck.test.ts`, `test/ui-command.test.ts`. The real `~/.config/ai-sdlc-helper/projects.json` still has its Oct 30 modification time, so nothing wrote to it.
- `test/runners.test.ts` runs a real nested `vitest` through a symlink to the project's `node_modules` and blocks its worker for about 13s. It is not needed to reproduce the error: group A without it still errors.
- Fixed pids are used as "dead" or fake: `42` (`test/pipeline-units.test.ts`) and `999999` (`web/test/triage.test.ts`). `web/server/triage.ts` sends SIGKILL to a recorded pid 5s later (`KILL_AFTER_MS`). A reused pid could be killed by mistake. That would crash a worker, not time out an RPC, so it is unlikely to be this error.
- The `node_modules/.vite/deps_temp_*` folders pre-date these runs (last changed Nov 1, before the probes).

## Mistakes to avoid next time

- Treating a single run as proof for an intermittent failure. Repeat each configuration several times.
- The first aborted run left stray `vitest` workers. Check `pgrep -fl vitest` before a timing run. `run.sh` refuses to start if one is alive.
- Probe files in `/tmp` vanished after the reboot. The probe files now live in the scratchpad folder below.

## Next steps

1. ~~The repeat experiment~~ Done, see "Repeat experiment result".
2. ~~Find the mechanism~~ Done, see "Mechanism".
3. ~~Fix~~ Done, see "Fix". The worker cap in `vitest.config.ts` stays as it was; lowering it would only have hidden this.

## Repeat experiment result

The 9-file set (group A without `runners.test.ts`), three runs at the default worker count (four) and three with `--maxWorkers=2`, alternating. Exact text from `repeat.summary` (the blank duration is a parsing bug in `repeat.sh`, not a missing run):

```
03:22:57 default run 1: ERROR duration=
03:26:14 workers2 run 1: clean duration=
03:29:27 default run 2: ERROR duration=
03:32:37 workers2 run 2: clean duration=
03:35:49 default run 3: ERROR duration=
03:38:56 workers2 run 3: clean duration=
```

- Default workers: error in 3 of 3 runs. `maxWorkers=2`: error in 0 of 3 runs, and the runs took about the same time (workers2 run 3 took 186.65s, against about 203s at the default).
- Together with the earlier runs this makes concurrency the trigger: at four busy workers the error appears, at two it does not. This is the first controlled comparison; every earlier conclusion came from single runs.
- It is still three runs each. It shows the trigger, not the mechanism: why four workers delay the reply is unknown.
- Candidate mitigation to test (not applied): lower the worker cap in `vitest.config.ts` (currently `min(4, cpus - 1)`). Check the cost on the full suite first, since that cap was chosen on purpose.

## Mechanism

Found with a second probe that timestamped every RPC call on both sides (worker: call sent, reply read, promise settled; main: request received, task result, `catchError`). Three runs of the 9-file set at the default four workers, all with the error (190s, 189s, 188s).

- In all three runs the failing task is the worker running `test/setupBranch.test.ts`. The main process receives that worker's task result with the error 67 to 69s after the file starts.
- That worker's event loop never turns while the file runs. The probe's 250ms interval fires once, at the end, with a gap of 67331ms, 68181ms and 69311ms in the three runs. No other worker in these runs had a gap over 5s.
- The file's `onTaskUpdate` calls are all sent on time (the main logs each request within a millisecond of the worker sending it, 3 to 10s apart as tests finish), but the replies are all read in one burst at the end of the file. The main side was never slow: no `_testRun.updated()` call took over 500ms, and no main-process stall over 1s.
- When the loop finally turns, timers run before I/O. The 60s timer of the first `onTaskUpdate` (sent when the file started, 67 to 69s earlier) has expired, so birpc rejects it even though its reply is already waiting in the IPC socket. In one run the second call (60135ms old) was rejected too. Every later call resolved in that same burst, 56s and younger.
- The rejection surfaces through `@vitest/runner`'s `finishSendTasksUpdate()`, which awaits the pending `onTaskUpdate` promises at the end of the file: the file's run throws, tinypool returns the error as the task result, and `Vitest.runFiles()` records it with `state.catchError(err, "Unhandled Error")`. That is why it was only ever visible at the end of the run and never failed a test.

Why the loop never turns: every test in `test/setupBranch.test.ts` does only synchronous work (`spawnSync` git, sync `fs`), and the `async` tests await `main()` whose `ask` stub and spawns resolve within microtasks. Nothing in the file waits on a timer or on I/O, so from the first `onTaskUpdate` (sent right after collection) to the last test, the worker never reaches the event loop's poll phase. The file is new and uncommitted (added with `src/registry/setupBranch.ts`), which is when the error first appeared.

Why concurrency was the trigger: the file blocks for as long as its roughly 250 git spawns take. Alone or at two workers that is under 60s and the first reply is read in time; with four workers busy on this machine it takes 67 to 69s. Every observation in "Runs" and "Pattern" fits: the error needed `setupBranch.test.ts` in the set (the minimisation kept it) and enough load to push the file past 60s (the final 7-file set alone was too light to reproduce).

## Fix

`test/setup.ts`, registered as `setupFiles` in `vitest.config.ts`, registers one `beforeEach` that awaits a real `setImmediate` (captured at load so a test's fake timers cannot replace it). One turn of the loop before each test reads the pending replies, so a synchronous file can no longer starve its own RPC for over 60s. It costs one `setImmediate` per test, and guards every file rather than just this one. Not done, on purpose: raising `testTimeout`, raising the RPC timeout, `dangerouslyIgnoreUnhandledErrors`, or lowering the worker cap, all of which would hide the mechanism rather than remove it.

Verification, same 9-file set, default four workers, probe still attached, three runs: clean in 3 of 3 (191s, 189s, 188s; 159 tests passed each time, no unhandled error), against 3 of 3 with the error before the fix (190s, 189s, 188s). `setupBranch.test.ts` still takes about 69s in these runs, but its worker's longest loop gap is now 10.4 to 10.9s (one test) instead of 67 to 69s (the whole file), its slowest `onTaskUpdate` reply 10.5s instead of 69s, and no call was rejected. Wall time is unchanged.

## Cleanup

- Delete `/Volumes/Work/Projects/trials/ai-sdlc-helper/vitest.probe.config.ts` (untracked, repo root) before any commit.
- Probe scripts, first probe: `/private/tmp/claude-501/-Volumes-Work-Projects-trials-ai-sdlc-helper/ea8d3674-89a0-4c90-8c4b-ada1eb7f2599/scratchpad/probe/` (`loop.ts`, `main.ts`, `rep.mjs`, `run.sh`, `minimize.sh`, `repeat.sh`). Second probe: `/private/tmp/claude-501/-Volumes-Work-Projects-trials-ai-sdlc-helper/6998d9e1-78d2-4af9-aef2-0d7c8b6745f1/scratchpad/probe2/` (`worker.ts`, `main.ts`, `rep.mjs`, `run.sh`, `repeat.sh`, and the logs under `def-*/` and `fix-*/`). Both are session folders and will vanish.
- Unrelated, finished, and uncommitted in the working tree: the Config modal change in `web/ui/src/Projects.tsx` and `web/ui/src/styles.css`.
