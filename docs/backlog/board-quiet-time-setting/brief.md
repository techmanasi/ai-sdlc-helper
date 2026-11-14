# board-quiet-time-setting

Type: improvement
Priority: P3 (low)

## Problem
When no run file changes for a while, the board watcher does its own check: is each run still alive, and is a PR status out of date. That quiet time is `BOARD_WATCH_TIMINGS.silenceMs`, 30 s (`web/server/board-watch.ts`, about line 61). Today it can only be changed with the `SDLC_BOARD_SILENCE_MS` environment variable (1000 ms or more) when the server starts (`silenceFrom` in `web/server/index.ts`). The web UI has no setting for it.

## Goal
The quiet time can be read and changed from the web UI's Config, and the change takes effect without restarting the server.

## Idea
- Keep it with the other settings the Config modal edits, with 30 s as the default and 1 s as the minimum.
- The environment variable still wins when set, and the UI says so.
- Running board feeds pick up the new value at their next quiet-time timer.

## Acceptance criteria
- Changing the value in Config changes when the next quiet-time check runs (a test with short timings).
- A value below 1 s or not a number is refused, with a message on the page.
- With `SDLC_BOARD_SILENCE_MS` set, the UI shows that value and that it comes from the environment.
- `docs/web-ui.md` documents the setting.

## Out of scope
- The other watcher timings (debounce, failure limit, fallback).
- The run page's stream timings.

## Docs
-
