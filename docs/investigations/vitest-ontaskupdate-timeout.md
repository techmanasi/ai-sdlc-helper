# Vitest "Timeout calling onTaskUpdate" unhandled error

Status: cause not found. Nothing in `src/` or `test/` was changed for this. Written while the repeat experiment (see "Next steps") was still running.

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

1. The repeat experiment: the 9-file set (group A without `runners.test.ts`), 3 runs at the default worker count and 3 with `--maxWorkers=2` (script `repeat.sh`). If the error disappears at 2 workers, concurrency is the trigger.
2. Profile process spawns per heavy test.
3. Try `maxWorkers` 2, 4 and 6 across the full suite, several runs each.
4. Only fix once the cause is known. Do not raise `testTimeout`, do not raise Vitest's RPC timeout, and do not use `dangerouslyIgnoreUnhandledErrors`.

Partial results of the repeat experiment so far, exact text from `repeat.summary` (the experiment was still running when this was written; the blank duration is a parsing bug in the script, not a missing run):

```
03:22:57 default run 1: ERROR duration=
```

## Cleanup

- Delete `/Volumes/Work/Projects/trials/ai-sdlc-helper/vitest.probe.config.ts` (untracked, repo root) before any commit.
- Probe scripts, in `/private/tmp/claude-501/-Volumes-Work-Projects-trials-ai-sdlc-helper/ea8d3674-89a0-4c90-8c4b-ada1eb7f2599/scratchpad/probe/`: `loop.ts`, `main.ts`, `rep.mjs`, `run.sh`, `minimize.sh`, `repeat.sh`.
- Unrelated, finished, and uncommitted in the working tree: the Config modal change in `web/ui/src/Projects.tsx` and `web/ui/src/styles.css`.
