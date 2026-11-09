---
name: monitor-pipeline-run
description: How to observe, monitor and debug an ai-sdlc-helper pipeline run (spec, plan, red-tests, implement, test-repair, review, finalise) that is running or has failed. Use when asked to watch a run, check its status, find out why a round or stage failed, or when a run "keeps failing the same way".
---

# Monitor and debug a pipeline run

A run is detached: it keeps going while you wait. Waiting for the stage or state to change is not monitoring. Check **what each agent round did**, every round, before you wait again.

Drive the run only through the web UI (start, stop, resume, discard, permissions, answers). Reading files and logs is always fine.

## Where the evidence is

Worktree: `../ai-sdlc-helper-sdlc/<slug>` (branch `sdlc/<slug>`). Logs: `<worktree>/docs/backlog/<slug>/logs/`.

| File | Tells you |
|---|---|
| `attempts.jsonl` | One line per agent round and per gate result: duration, turns, tokens, files changed, refused tools, warnings. **Read this first.** |
| `run.out` | The run's narration, including `!! observed in '<agent>': …` and `!! observed after attempt N: …` lines |
| `status.json` | state, stage, agent, model, `agent_started`, `updated`, pid |
| `impl-N.json` / `spec-N.json` … | The agent's result: `response`, `num_turns`, `usage`, `denied_actions` / `permission_denials`, error status |
| `impl-N.err`, `impl-N.log` | stderr and the agent's own log |
| `tests.log`, `tests.json`, `baseline.json` | Gate output and the failing checks |
| `permissions.json` | `pending` (the run is paused on these), `allow`, `denied` |
| `.git/sdlc-runs/<slug>.json` (main checkout) | The run record, including its `base` |

The run page shows the same rounds in the "Agent rounds" panel (running row, duration, turns, files, failing count, warnings).

## The check, every round (not every few minutes)

1. **Read the diff, not the stat.** `git -C <worktree> diff HEAD` and `git status`. `--stat` hides debug code, writes to `/tmp`, edits outside the task. Look for `console.*('DEBUG`, `writeFileSync('/tmp/…`, changes to files the task does not mention.
2. **Read the round's result file** (`impl-N.json`): is `response` empty, how many turns, anything in `denied_actions`?
3. **Read the last lines of `attempts.jsonl`**: warnings on the round (`refused …`, `empty answer`, `no files changed`, `debug code left in the source`).
4. **Compare with the previous round.** Same failing checks, same error text in `run.out`, same refused path = the agent is not progressing. Say so after the second identical round. Do not wait for the attempt limit.
5. **CPU and time are weak signals.** An agent at 0.4% CPU is waiting on the model; +135 lines is not progress if the diff is wrong. Judge by the diff and the result file.

Do the check when a round ends and also halfway through a long one. A wait loop must compare consecutive rounds, not only stage and state.

## Pauses and refusals

- A paused run lists its asks in `permissions.json` `pending`. Before pressing Allow, read what is asked. If an ask has no detail (no command, no path), do not allow blindly: find out what was refused first.
- A refusal with no path (agy `denied_actions` carries only the tool name): read `--output-format stream-json` output for the path (`tool_info.error.message`: `permission check failed for read_file "<path>"`). Do not read agy's conversation database: agy versions differ per user.
- A read or write outside the project is refused in headless accept-edits mode. If the agent keeps retrying the same path, the cause is usually something it left in the source (a log written under `/tmp` that it then tries to read), not a missing permission. Remove the cause; do not widen permissions to cover it.

## Failure patterns

| Seen | Likely cause | Do |
|---|---|---|
| Rounds 2..N fail with identical text | Agent stuck on something it cannot do (refused path, empty answer) | Read `impl-N.json` and the diff; fix the cause, then resume |
| Empty `response`, exit 0 | Turn ended on a refused tool or max turns (`error_max_turns`) | Look at `denied_actions`, `num_turns` |
| Gate fails the same checks every attempt | Test defect (the test itself is wrong) or a missed requirement | Read the failing test; the agent should claim a test defect, not loop |
| 5xx / 503 "No capacity" (`retryable`) | Provider capacity | Retry from the UI |
| Quota exhausted | Account limit on that model | Pick another model for the stage in the UI (per-run `MODEL_<STAGE>`) |
| Run base is the wrong branch | Base follows the main checkout's current branch | Set `SDLC_BASE=main` in "Environment for this run" |
| UI shows signed out after a server restart | Token changed | Sign in with the `?t=` URL the server printed |

## Debugging rules

- Find the root cause before changing anything. Do not patch a symptom (hint text, a retry) while the cause is unread.
- Never write the agent's deliverables yourself (for example the defect claim in `test-issues.md`). Find why the agent did not produce it.
- Do not rebuild `dist/` while a pipeline is running.
- Code fixes go in the main checkout on a branch with tests; the run picks them up on the next start.
- Run `npm run check` with output redirected to a log (about 15 minutes); do not wait on it in a subagent.

## Status report

After each check, report: stage and agent, round number and age, files changed and whether the diff is clean, warnings, whether the last two rounds differ, and what you will check next.
