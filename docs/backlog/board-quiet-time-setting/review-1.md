# Review 1: board-quiet-time-setting

Diff reviewed: `git diff 2fffc4d` against `specs-1.md`.

## Verdict

No blockers. One correctness issue fixed in source. One acceptance-criterion gap (UI has no automated test) noted below.

## Fixed

- **`startServer` wrote into the caller's environment object** (`web/server/index.ts`). The implementation changed
  `env` from a copy to `opts.env || { ...process.env }` and then set `env.SDLC_RUN_TRIGGER = 'ui'` on it. `ai-sdlc-helper ui`
  passes `process.env`, so the server process's own `process.env` got the UI run marker, and any caller's `opts.env`
  object was changed. Fix: `liveEnv` is the caller's object and is only read. `env` is again a copy with the marker
  added. `SDLC_BOARD_SILENCE_MS` is read from `liveEnv` each time it is used (settings reply and `silenceMsFor`), so
  the tests that change the environment after start still see the change. `boardSilenceEnvSeconds` now comes from a small
  `envSilenceSeconds()` helper, so the env var is no longer parsed twice.

## Checked, no change needed

- Precedence `opts.boardWatch.silenceMs` > `SDLC_BOARD_SILENCE_MS` > `overrides.boardSilenceSeconds * 1000` > 30 000 ms
  is implemented in `silenceMsFor`. The registry value is re-checked (integer, at least 1), and a broken registry
  falls back to the default.
- Live update: `createBoardWatch` keeps the `timings` object by reference (`board-watch.ts:134`). Because the overrides
  route changes `feed.timings.silenceMs`, the next `armSilence` uses the new value without a restart or SSE reconnect.
- `overrideErrors` rejects `0`, negatives, fractions, strings, objects, `NaN` and `±Infinity` with the message from the spec.
  `null` deletes the key through `applyPatch`.
- On success the overrides route returns `{ ok: true }`. No other caller relied on the old `errors`/`hash` fields.
- UI: the field, placeholder, `min`/`step`, the disabled state when the env var is set, the helper text, and the
  client-side check with the message from the spec are all there. The patch leaves out `boardSilenceSeconds` while the env var is set,
  so the stored value is kept.

## Acceptance criteria and tests

| AC | Test (runs real code) |
|---|---|
| 1 Schema & validation, save/clear | `test/edit-settings.test.ts` "board quiet seconds are validated, persisted and cleared" |
| 2 Settings API (`boardSilenceEnvSeconds`, saved override) | `web/test/server.test.ts` "reports a valid environment quiet time…" and "quiet time override is saved, validated and removed…" |
| 3 Precedence & live update | `web/test/board-feed.test.ts` "a running feed uses the saved quiet time…" and "environment quiet time takes precedence…" |
| 4 Web UI behaviour | **No automated test.** The repo has no component-test setup for `web/ui/src/Projects.tsx`. The code is in place, but the UI checks (disabled state, helper text, client-side rejection of `0`/`1.5`) are untested. Not a blocker. |
| 5 Docs | `docs/web-ui.md` updated. No test reads documentation text. |

No test reads or asserts on documentation, and every documented behaviour has code behind it.

## Verification

- `npx vitest run test/edit-settings.test.ts web/test/server.test.ts web/test/board-feed.test.ts`: 3 files, 64 tests passed.
- `npm run typecheck`: passed.
- `ai-sdlc-helper run --file …` could not be used. The globally installed CLI refuses this repo's `sdlc.config.json`
  (`tests.fullSuite: unknown setting`, `agent.stages: unknown setting`), so it is older than the repo.
