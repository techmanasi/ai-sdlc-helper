# Spec: board-quiet-time-setting

Type: improvement · Priority: P3 (low) · Sources: `docs/backlog/board-quiet-time-setting/brief.md` and `docs/backlog/board-quiet-time-setting/decisions.md`

## 1. Summary

When no files change in a watched project, the web server's board watcher runs a periodic quiet-time check (`silenceMs`, default 30 seconds) to verify if running processes are still alive and if PR statuses require updating. Previously, this duration could only be adjusted at server launch using the `SDLC_BOARD_SILENCE_MS` environment variable.

This feature enables the board quiet time to be inspected and configured directly from the web UI's Config modal as a personal setting per project. Updates take effect dynamically at the next quiet-time timer cycle without requiring a server restart. If `SDLC_BOARD_SILENCE_MS` is set in the server's environment, it continues to take precedence, and the UI displays this active environment override in a disabled state with an explanatory notice.

## 2. Current Behaviour (Verified)

- In `web/server/board-watch.ts`, `BOARD_WATCH_TIMINGS.silenceMs` defaults to `30_000` ms (30 seconds).
- In `web/server/index.ts`, `silenceFrom(env)` reads `process.env.SDLC_BOARD_SILENCE_MS` (accepting numeric values >= 1000 ms).
- Each project's board feed (`boardFeed(p)` in `web/server/index.ts`) creates a `BoardWatch` instance with static timings computed once at feed instantiation: `{ ...BOARD_WATCH_TIMINGS, ...silenceFrom(env), ...opts.boardWatch }`.
- In `web/ui/src/Projects.tsx`, the `EditSetup` modal provides project-level configuration (`sdlc.config.json`) and personal overrides (`projects.json` for registered projects: `worktreeBase` and `maxParallel`), but offers no control for the board quiet-time interval.
- `src/config/edit.ts` validates personal overrides via `overrideErrors(o: Json)`, rejecting any unknown keys with `<key>: unknown override`.

## 3. Configuration & Precedence

### 3.1 Storage Location & Schema

- **Key:** `boardSilenceSeconds`
- **Location:** Stored in the personal registry (`~/.config/ai-sdlc-helper/projects.json`) under the project's `overrides` object (e.g., `projects[name].overrides.boardSilenceSeconds`).
- **Data Type:** Integer (whole seconds, minimum 1).
- **Default:** 30 seconds when unset or cleared.
- **Unset/Reset:** Setting the field to an empty string in the UI sends `null` to the backend, removing the `boardSilenceSeconds` property from `overrides` and restoring the default 30-second interval.

### 3.2 Timing Precedence Cascade

The effective board quiet time in milliseconds for a project's watcher is resolved in the following priority order:

1. **Server Option (`opts.boardWatch.silenceMs`):** Used during programmatic server creation and automated tests.
2. **Environment Variable (`SDLC_BOARD_SILENCE_MS`):** When present in the server's environment and parsed as a finite number >= 1000 ms.
3. **Personal Override (`overrides.boardSilenceSeconds`):** When defined in `projects.json` for the project (converted to milliseconds: `boardSilenceSeconds * 1000`).
4. **Default (`BOARD_WATCH_TIMINGS.silenceMs`):** 30,000 ms (30 seconds).

## 4. Behaviour

### 4.1 Server API

- **`GET /api/projects/:project/settings`:**
  - In addition to existing metadata, the response includes an indicator of active environment overrides: `boardSilenceEnvSeconds` (number | null).
  - When `SDLC_BOARD_SILENCE_MS` is set in the server's environment and >= 1000 ms, `boardSilenceEnvSeconds` is the environment value converted to integer seconds (e.g. `Math.round(ms / 1000)`). When unset or invalid (< 1000 ms), `boardSilenceEnvSeconds` is `null`.
  - The project's existing `overrides` object in the response includes `boardSilenceSeconds` if configured.
- **`POST /api/projects/:project/overrides`:**
  - Accepts `{ boardSilenceSeconds: number | null }` in the patch body alongside existing personal overrides (`worktreeBase`, `maxParallel`).
  - Validates `boardSilenceSeconds` using `overrideErrors`.
  - If valid, updates the registry entry and responds with `{ ok: true }`.
  - If invalid, returns HTTP 400 with validation error messages.

### 4.2 Dynamic Feed Update (No Server Restart)

- When `POST /api/projects/:project/overrides` succeeds:
  - If an active `BoardFeed` exists for the project, its quiet-time interval is updated.
  - The watcher picks up the new value at its next quiet-time timer cycle (when `armSilence` is executed upon completion of an audit or after a file event).
  - The change takes effect immediately for subsequent timers without restarting the server process or disconnecting SSE clients.

### 4.3 Web UI (Config Modal)

- **Placement:**
  - Located in `web/ui/src/Projects.tsx` inside the `EditSetup` modal under the personal overrides section (`{data.registered && (...)}`), positioned alongside "Worktree folder (personal, this machine only)" and "Runs in parallel (personal)".
- **Label & Input Element:**
  - Label: `Board quiet time in seconds (personal)`
  - Input field attributes: `type="number"`, `min="1"`, `step="1"`, placeholder `30`.
- **State when `SDLC_BOARD_SILENCE_MS` is set:**
  - If `data.boardSilenceEnvSeconds` is not null:
    - The input displays the environment value in seconds.
    - The input is marked `disabled` (read-only).
    - Helper text is displayed directly underneath the input: `Set by SDLC_BOARD_SILENCE_MS in server environment (overrides config)`.
- **State when `SDLC_BOARD_SILENCE_MS` is not set:**
  - The input is enabled and editable.
  - Initialised with `data.overrides.boardSilenceSeconds ? String(data.overrides.boardSilenceSeconds) : ''`.
  - If left blank, the placeholder `30` is visible.
- **Client-Side Validation & Submission:**
  - Before saving personal overrides, the value is checked:
    - If empty or whitespace, it resolves to `null` (deletes the override).
    - If non-empty, must parse as an integer >= 1.
    - Values less than 1, non-integers (fractional/decimals like `1.5`), or non-numeric strings are rejected on the page with an error message: `Board quiet time must be a whole number of seconds, at least 1`.
  - On save, submits `{ boardSilenceSeconds }` via `api.editOverrides`.

## 5. Inputs and Outputs

### 5.1 Data Models & Types

- **`ProjectOverrides` (in `src/registry/projects.ts`):**
  - Adds optional field `boardSilenceSeconds?: number;`.
- **`SettingsView` (in `web/ui/src/api.ts`):**
  - Adds `boardSilenceEnvSeconds?: number | null;`.
- **Backend Validation (`overrideErrors` in `src/config/edit.ts`):**
  - Adds rule for `boardSilenceSeconds`: must satisfy `Number.isInteger(v) && v >= 1`.
  - Rejection message: `boardSilenceSeconds: must be a whole number of seconds, 1 or more`.

### 5.2 API Payloads

- **`GET /api/projects/:name/settings` Response:**
  - Includes `boardSilenceEnvSeconds: number | null` (e.g. `5` or `null`).
  - Includes `overrides: { ..., boardSilenceSeconds?: number }`.
- **`POST /api/projects/:name/overrides` Request Body:**
  - `{ patch: { boardSilenceSeconds?: number | null, ... } }`.
- **`POST /api/projects/:name/overrides` Response:**
  - Success: HTTP 200 `{ ok: true }`.
  - Failure: HTTP 400 `{ ok: false, errors: string[] }`.

## 6. Error Cases

1. **Value below minimum (< 1):**
   - Entering `0` or `-5` in the UI or submitting via API is refused.
   - UI reports: `Board quiet time must be a whole number of seconds, at least 1`.
   - API reports: `boardSilenceSeconds: must be a whole number of seconds, 1 or more`.
2. **Fractional / Decimal value:**
   - Entering `1.5` or `2.2` is refused. Same error messages as above.
3. **Non-numeric value:**
   - Entering text or submitting non-numbers via API is refused. Same error messages as above.
4. **Environment variable invalid (< 1000 ms or non-numeric):**
   - `silenceFrom(env)` ignores values < 1000 ms or non-finite numbers; `boardSilenceEnvSeconds` returns `null`; UI input remains editable and uses config/default.
5. **Project not registered:**
   - Personal overrides section in `EditSetup` is omitted for unregistered projects, identical to `worktreeBase` and `maxParallel`.

## 7. Out of Scope

- Configuring other watcher timings (debounce duration, failure limit, fallback poll interval).
- Configuring run page stream timings (`web/server/watch.ts`).
- Global / repository-level quiet time setting in `sdlc.config.json` (per decisions in Round 1, this is strictly a personal workstation setting).

## 8. Dependencies

- None new. Uses existing Node 18 built-ins and Preact UI controls.

## 9. Documentation

- `docs/web-ui.md` is updated to describe the Config modal setting:
  - Label: `Board quiet time in seconds (personal)`.
  - Stored in `projects.json` under `overrides.boardSilenceSeconds`.
  - Default: 30 seconds; minimum: 1 second.
  - Takes effect at the next quiet-time timer cycle without server restart.
  - Explains precedence of `SDLC_BOARD_SILENCE_MS`.

## 10. Acceptance Criteria

1. **Schema & Validation:**
   - `ProjectOverrides` type definition in `src/registry/projects.ts` includes `boardSilenceSeconds?: number`.
   - `overrideErrors` in `src/config/edit.ts` accepts valid integer seconds >= 1 under `boardSilenceSeconds`.
   - `overrideErrors` rejects `boardSilenceSeconds` values < 1, fractional numbers, strings, objects, or non-finite numbers with `boardSilenceSeconds: must be a whole number of seconds, 1 or more`.
   - `editOverrides` in `src/config/edit.ts` saves valid `boardSilenceSeconds` to `projects.json` and deletes the key when `null` is passed.

2. **Server Settings API:**
   - `GET /api/projects/:name/settings` returns `boardSilenceEnvSeconds` as an integer number of seconds when `SDLC_BOARD_SILENCE_MS` >= 1000 is present in the server's environment, or `null` otherwise.
   - `GET /api/projects/:name/settings` returns the saved `overrides.boardSilenceSeconds` when set.

3. **Runtime Feed Timing & Dynamic Update:**
   - `boardFeed` evaluates the project's quiet-time silence interval respecting the precedence cascade: server options (`opts.boardWatch.silenceMs`) > environment variable (`SDLC_BOARD_SILENCE_MS`) > personal override (`boardSilenceSeconds * 1000`) > default (30,000 ms).
   - In a test with short timings, changing `boardSilenceSeconds` via `POST /api/projects/:name/overrides` updates the running `boardFeed` so that its next quiet-time audit timer uses the newly specified duration without restarting the server.

4. **Web UI Behaviour:**
   - The Config modal (`EditSetup`) displays the input `Board quiet time in seconds (personal)` with placeholder `30` in the personal overrides section for registered projects.
   - When `SDLC_BOARD_SILENCE_MS` is set in the server environment, the input displays that value in seconds, is disabled (read-only), and renders helper text `Set by SDLC_BOARD_SILENCE_MS in server environment (overrides config)`.
   - When `SDLC_BOARD_SILENCE_MS` is not set, the input is editable and populated with the saved override value (or blank if unset).
   - Submitting an invalid value (< 1 or decimal) displays an error message on the page without updating the server.
   - Saving a valid value persists it to `projects.json`. Clearing the input and saving removes the override.

5. **Documentation:**
   - `docs/web-ui.md` accurately documents the board quiet time setting, default, minimum, personal override storage, and environment variable override behaviour.

6. **Quality & Verification:**
   - Targeted automated tests in `web/test/` verify:
     - Settings API response with and without `SDLC_BOARD_SILENCE_MS`.
     - Overrides API validation for valid, invalid, and null `boardSilenceSeconds`.
     - Dynamic update of next quiet-time check interval on an active board feed without restart.
   - All targeted tests pass.
