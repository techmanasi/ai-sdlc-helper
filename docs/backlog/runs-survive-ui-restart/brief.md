# runs-survive-ui-restart

Type: bug
Priority: P1 (high)
Source: User, 2026-11-17, after `review-loop-limit-ui-setting` stopped during a UI server restart.

## Problem
A run started from the web UI stops when the UI server process that started it stops. On 2026-11-17 the orchestrator stopped the `ai-sdlc-helper ui` server on port 4481 at 21:38:13 to restart it on a new build. Four seconds later, at 21:38:17, the run `review-loop-limit-ui-setting` was marked interrupted with "supervisor 99545 is gone (killed or crashed) during Implement". Its CI had passed and 28 of 28 tests passed locally. Nothing warned that stopping the server would stop the run, and the run was not resumed when the server came back.

## Expected behaviour
- A run started from the UI keeps running when the UI server stops or restarts: its supervisor is detached from the server's process group and session, so a signal to the server does not reach it.
- A restarted server picks up runs that are still alive from `.git/sdlc-runs/*.json` and shows them as running.
- If a run does stop because its supervisor died, the run page says so and when (as today), and the board does not hide it.

## Decisions
-

## Scope
- In: how the server spawns the supervisor (detached, own process group, stdio to the run log, unref); reattaching to live runs on server start.
- Out: runs started from the CLI (already independent of the server).

## Tests
- Start a run through the server API, stop the server process (SIGTERM, and SIGINT to its process group), and check the supervisor pid is still alive and the run record still says running.
- Start a new server on the same project and check the board API reports the run as running.

## Docs
- `docs/web-ui.md`: stopping or restarting the UI does not stop runs.

## Open questions
- none
