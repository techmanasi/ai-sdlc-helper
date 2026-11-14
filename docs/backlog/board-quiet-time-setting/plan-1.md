# Plan: board-quiet-time-setting

Source: `specs-1.md` and `decisions.md` (all four answers accepted). No open questions.

## Dependencies

- none

## Key finding

`createBoardWatch(host, timings)` (`web/server/board-watch.ts:L102`) keeps the `timings` object it was given and reads
`timings.silenceMs` each time `armSilence` runs. `boardFeed` (`web/server/index.ts:L477`) builds that object as a fresh
spread (`{ ...BOARD_WATCH_TIMINGS, ...silenceFrom(env), ...opts.boardWatch }`). If the feed keeps a reference to it,
changing `timings.silenceMs` takes effect at the next `armSilence` with no change to `board-watch.ts`.

## Steps (in order)

### 1. Schema and validation (`src/registry/projects.ts`, `src/config/edit.ts`)
- `ProjectOverrides` (`src/registry/projects.ts:L7`): add `/** Seconds of quiet before the board watcher checks its files. */ boardSilenceSeconds?: number;`.
- `overrideErrors` (`src/config/edit.ts:L78`): add a branch before the `agent` one:
  `else if (k === 'boardSilenceSeconds') { if (!(Number.isInteger(v) && (v as number) >= 1)) errors.push('boardSilenceSeconds: must be a whole number of seconds, 1 or more'); }`
  Strings, objects, `NaN`, `Infinity`, `0` and `1.5` all fail `Number.isInteger`. `editOverrides` needs no change:
  `applyPatch` already deletes a key on `null`, and the key is validated and written like the others.

### 2. Server: precedence and dynamic update (`web/server/index.ts`)
- Add a helper next to `silenceFrom` (`L21`): `savedSilenceMs(p: Project): number | undefined`. It does
  `readRegistry(env).find(e => e.name === p.name)?.overrides?.boardSilenceSeconds` inside `try/catch` (a corrupt
  registry means "no override"). It returns the value times 1000 when it is an integer >= 1, otherwise `undefined`.
  `readRegistry`, `env` and `p` are already in scope inside `startServer`, so define it inside `startServer`
  near `boardFeed`.
- Add `silenceMsFor(p)` in `startServer`, implementing the cascade:
  `opts.boardWatch?.silenceMs ?? silenceFrom(env).silenceMs ?? savedSilenceMs(p) ?? BOARD_WATCH_TIMINGS.silenceMs`.
- `BoardFeed` interface (`L473`): add `timings: BoardWatchTimings`.
- In `boardFeed(p)` (`L477`): build `const timings: BoardWatchTimings = { ...BOARD_WATCH_TIMINGS, ...opts.boardWatch, silenceMs: silenceMsFor(p) }`.
  Pass `timings` to `createBoardWatch` and store it as `feed.timings`. (`opts.boardWatch` can carry other timing
  fields, so spread it first and then set `silenceMs` from the cascade, which puts `opts.boardWatch.silenceMs` first
  in priority.)
- `POST /overrides` handler (`L272-L279`): after `editOverrides` returns `r.ok`, if
  `'boardSilenceSeconds' in body.patch`, then `const feed = feeds.get(p.name); if (feed) feed.timings.silenceMs = silenceMsFor(p);`.
  The new value applies from the next `armSilence` (after the next audit or file event). The SSE clients stay connected.
  `feeds` is declared at `L474`, below `api`, but is only used at request time, so it is initialised by then.
- `GET /settings` handler (`L232-L248`): add `boardSilenceEnvSeconds: silenceFrom(env).silenceMs ? Math.round(silenceFrom(env).silenceMs! / 1000) : null`
  to the sent object. `overrides` already carries `boardSilenceSeconds`.

### 3. UI types and form (`web/ui/src/api.ts`, `web/ui/src/Projects.tsx`)
- `SettingsView` (`api.ts:L10`): `overrides` gains `boardSilenceSeconds?: number`; add `boardSilenceEnvSeconds?: number | null`.
- `EditSetup` (`Projects.tsx:L93`):
  - State: `const [silence, setSilence] = useState('')`. In `load`, set
    `setSilence(d.overrides.boardSilenceSeconds ? String(d.overrides.boardSilenceSeconds) : '')`.
  - Validation in `save`, before any request, inside `if (data.registered)` and skipped when
    `data.boardSilenceEnvSeconds != null`: `const s = silence.trim(); const secs = s ? Number(s) : null;`.
    If `s` is non-empty and `!(Number.isInteger(secs) && secs >= 1)`, then `setErrors(['Board quiet time must be a whole number of seconds, at least 1']); setBusy(false); return;`.
    This runs before the first `api.editOverrides`/`editSettings` call, so nothing is sent on bad input. To make that
    true, put the check at the top of `save`, before the scope branch.
  - Send `boardSilenceSeconds: secs` in the existing `api.editOverrides(name, { worktreeBase, maxParallel, ... })`
    call at `L160`, only when the env var is not set (otherwise omit the key so the env-locked field is never written).
  - Render after the "Runs in parallel" input (`L257`): label `Board quiet time in seconds (personal)`, input
    `type="number" min="1" step="1" placeholder="30"`. When `data.boardSilenceEnvSeconds != null`, the value is
    `String(data.boardSilenceEnvSeconds)` and the input is `disabled`, with a `<p class="small muted">` below it:
    `Set by SDLC_BOARD_SILENCE_MS in server environment (overrides config)`.

### 4. Tests (real code only, no documentation assertions)
- `test/edit-settings.test.ts` (next to the `editOverrides('shop', ...)` cases at `L110-L120`): `editOverrides` stores
  `boardSilenceSeconds: 5` and the registry reads back 5; `null` removes it; `0`, `1.5`, `'5'`, `{}` and `NaN` return
  `errors` equal to `['boardSilenceSeconds: must be a whole number of seconds, 1 or more']`. Also call `overrideErrors`
  directly if it is exported, otherwise go through `editOverrides`.
- `web/test/server.test.ts` (near `L259-L330`, where `shop` is registered and `settingsUrl` is defined):
  - `GET /settings` returns `boardSilenceEnvSeconds: null` without the env var, and `5` when the server is started
    with `env.SDLC_BOARD_SILENCE_MS = '5000'`. It returns `null` for `'500'` and for `'abc'`.
  - After `POST /overrides { patch: { boardSilenceSeconds: 7 } }`, `GET /settings` shows `overrides.boardSilenceSeconds === 7`.
    `0` and `1.5` answer 400 with the error above. `null` clears the key.
- `web/test/board-feed.test.ts` (`start()` and the existing short-silence test at `L155-L169` give the pattern, using
  the gh stand-in counter):
  - Precedence: with no `boardWatch` option and no env var, a saved `boardSilenceSeconds: 1` makes the gh stand-in
    get asked again about every second. This needs the project registered in the temp config dir (write
    `projects.json` through `editOverrides`/`writeRegistry` in the test setup).
  - Dynamic update: start the server with a registered `shop` and `SDLC_PR_POLL_MS: '300'`, so the first audit is
    slow (a saved 60 s override) and few calls are made. Open a page, then `POST /overrides` with
    `boardSilenceSeconds: 1`. Prove the running feed picked up the new value by `eventually(() => asked() >= first + 2, 15_000)`.
    This needs one audit to complete after the POST, since the old 60 s timer is already armed. To avoid waiting
    60 s, set the starting override to 2 and then change it to 1, and assert that the call rate rises. If that proves
    flaky, instead trigger a file event (touch the brief) after the POST so `armSilence` re-arms with the new value.
  - Env wins: with `SDLC_BOARD_SILENCE_MS=60000` and a saved 1, there are no repeat calls within a few seconds.
  - Server option wins: `boardWatch: { silenceMs: 100 }` beats a saved 60 (the existing test already shows `100` works).
- Run each touched file with `ai-sdlc-helper run --file <file>`. The full suite runs in GitHub Actions.

### 5. Documentation (separate step, no test)
- `docs/web-ui.md`: in the Config modal section, document `Board quiet time in seconds (personal)`, stored in
  `projects.json` under `overrides.boardSilenceSeconds`, default 30 s, minimum 1 s (whole seconds), applied at the next
  quiet-time timer cycle without a server restart, and that `SDLC_BOARD_SILENCE_MS` wins when set (the field is then
  disabled and says so). Markdown-only checks: `npm run lint`.

### 6. Finish
- `npx tsc`/`npm run lint` on touched files via `npm run check` into a log (the full run is left to CI). Refresh the
  graph with `graft build`.

## Risks
- The `timings.silenceMs` change only affects timers armed after the POST. This matches the spec ("next quiet-time
  timer cycle").
- `boardFeed` previously let `silenceFrom(env)` be overridden by `opts.boardWatch`. The new cascade keeps that order.
- The UI skips the personal value in the PATCH when the env var is set, so an env-locked field cannot erase a saved override.
