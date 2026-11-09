# Plan: ui-code-indexer-setup

Spec: `specs-1.md`; decisions (binding): `decisions.md` Round 1. No open technical questions.

## Dependencies

- none

No new package: Node `child_process`/`fs`/`path`, Preact (already used) and the existing helpers are enough.

## Findings that shape the plan

- `src/config/codeSearch.ts` has `codeIndexers`, `codeSearchFor`, `unavailable`, `CODE_INDEXERS`. Its `build` field is prose for graphify (`build the graph with /graphify . in Claude Code`), so it cannot be run as a command. The spec's `canBuild` needs an explicit executable command: add an optional `buildCommand` field. `graft` gets `buildCommand: 'graft build'`; `graphify` has none, so `canBuild` is false (decision Q1).
- `onPath` in that file is private (it also checks the `PROGRAM` pattern). The new status function lives in the same file.
- The server imports the engine only from `ai-sdlc-helper` (`src/index.ts`), so the new engine functions must be exported there.
- `web/server/index.ts`: `runCommand` (inline in `startServer`) spawns this tool's CLI with a 120 s timeout (`COMMAND_TIMEOUT_MS`). The build needs the same spawn/timeout/capture logic for another program, so extract a `runProcess(file, args, cwd)` helper and have `runCommand` call it.
- `editSettings(root, patch)` (`src/config/edit.ts`) writes atomically, validates through `fileErrors` (which includes `codeSearchErrors`), and returns `{ ok: false, errors }` for invalid JSON without touching the file. Use it for saving `agent.codeSearch`.
- There is no shared `Modal` component. The UI uses an inline `overlay` / `dialog` markup (`Projects.tsx:328`, `App.tsx:41`). The new modal follows that pattern in its own file.
- The Doctor row has `c.ok`, `c.name === 'code indexer'`. `Doctor` already has `run` to refresh.
- Tests: `web/test/server.test.ts` shows the harness (`startServer({ port: 0, env, cwd, ... })`, token header). The server's `env` decides PATH lookups, so a fake `graft` script in a temp bin dir put first on `env.PATH` makes "installed" and "build" real and deterministic.

## Steps (in order)

### 1. Engine: `src/config/codeSearch.ts`

1. `CodeIndexer`: add `buildCommand?: string` ("the command line that builds the index headlessly, program and arguments, no shell syntax").
2. `CODE_INDEXERS.graft`: add `buildCommand: 'graft build'`. Leave `graphify` without it.
3. `INDEXER_SCHEMA`: add `buildCommand: 'string'` (settings.ts line 144 reuses it, so `agent.codeIndexers.<name>.buildCommand` validates as text).
4. `codeSearchErrors`: for each declared indexer with `buildCommand`, push `agent.codeIndexers.<name>.buildCommand: a program and its arguments, no shell syntax` unless every whitespace-separated word matches `/^[\w.@+\/=:-]+$/` and the first matches `PROGRAM`.
5. New `export function codeBuildArgv(ix: CodeIndexer): { file: string; args: string[] } | null`: split `ix.buildCommand` on whitespace; `null` when absent or empty.
6. New exported types and function:
   - `CodeIndexerStatus { name, command?, index?, installed, indexed, setup?, build?, canBuild }`
   - `CodeSearchView { setting, effective, warning, indexers }`
   - `codeSearchStatus(root, file = {}, env = process.env): CodeSearchView`
   - `setting` = `file.agent.codeSearch || 'auto'`; `effective` and `warning` from `codeSearchFor` (`effective` = its `codeSearch`); `installed` = `Boolean(ix.command && onPath(ix.command, env))`; `indexed` = `ix.index ? exists(path.join(root, ix.index)) : installed`; `canBuild` = `codeBuildArgv(ix) !== null`.
7. `src/index.ts` line 6: also export `codeBuildArgv`, `codeSearchStatus`, `SEARCH_SETTINGS`, and the types `CodeSearchView`, `CodeIndexerStatus`.

### 2. Server: `web/server/index.ts`

1. Import `codeBuildArgv, codeIndexers, codeSearchErrors, codeSearchStatus, readSettings`-equivalents from `'ai-sdlc-helper'` (`readSettings` is not exported from `src/index.ts`; use `resolve`-free approach: read and parse `sdlc.config.json` in the route, falling back to `{}` on error, as the settings route already does with `fileJson`). Also import `SEARCH_SETTINGS`.
2. Extract `runProcess(file: string, args: string[], cwd: string)` out of `runCommand` (same body: spawn with `env`, 1e6-char caps, `COMMAND_TIMEOUT_MS` SIGTERM timer, error and close handlers). `runCommand = (args, cwd) => runProcess(cli[0], [...cli.slice(1), ...args], cwd)`.
3. A helper `codeSearchFile(p)`: parse `sdlc.config.json` to an object, `{}` when missing or invalid; use `{}` as the settings when `codeSearchErrors(file)` is non-empty (same as `doctor`).
4. Route `what === 'code-search' && parts.length === 3 && method === 'GET'` (place after the `settings` routes): `send(200, codeSearchStatus(p.path, codeSearchFile(p), env))`.
5. Route `what === 'code-search' && parts[3] === 'setup' && method === 'POST'`:
   - `body.indexer` must be a non-empty string, else 400 `indexer is required`; `body.build` must be undefined or boolean, else 400.
   - `all = codeIndexers(file)`; unless `SEARCH_SETTINGS.includes(indexer)` or `all[indexer]`, 400 `"<name>" is not a code indexer (use auto, none, <names>)`.
   - If `build`: `auto`/`none` reject with 400 (`<name> has no index to build`); `ix` not installed (`!ix.command || !onPath`; use `codeSearchStatus(...).indexers` entry's `installed`) gives 400 `<name> is not installed (no <command> command on PATH)`; `codeBuildArgv(ix)` null gives 400 `<name> requires an interactive build: <ix.build>`.
   - Build: `runProcess(argv.file, argv.args, p.path)`; if `code !== 0 || timedOut`, answer 400 `{ ok: false, error: timedOut ? 'Build command timed out after 120 seconds' : 'Build command failed with exit code N', buildOutput: { code, stdout, stderr, timedOut } }` and do not touch the config.
   - Save: `editSettings(p.path, { agent: { codeSearch: indexer } })` (no hash: the change is a single key). If `!r.ok`, 400 `{ ok: false, error: r.errors.join('; '), ...(buildOutput) }`. Else 200 `{ ok: true, codeSearch: indexer, buildOutput? }`.

### 3. Client API: `web/ui/src/api.ts`

1. Add `CodeIndexerStatus`, `CodeSearchView`, `CodeSearchSetupResult { ok, codeSearch?, error?, buildOutput? }` interfaces (own copies; the browser build must not import Node code).
2. Add `api.codeSearch(project)` (GET `${p(project)}/code-search`) and `api.codeSearchSetup(project, body)` (POST `${p(project)}/code-search/setup`). The setup call must return the body on a 400 (a failed build carries `buildOutput`); read how `call` surfaces non-2xx responses and, if it throws, use a variant that returns the parsed JSON for this one route.

### 4. UI modal: new `web/ui/src/CodeSearchModal.tsx`

`CodeSearchModal({ project, onClose, onChanged })`, using the `overlay` / `dialog` markup of `Projects.tsx:328`.

- Loads `api.codeSearch(project)`; `[ Refresh ]` re-queries without closing.
- State: `selected` (initially the current `setting`, else the first indexer), `busy`, `result`, `error`.
- Option list: every `indexers` entry plus `auto` ("Auto (first available)") and `none` ("None (Grep and Glob)").
- Detail for an indexer: badges `✔ Installed on PATH` / `✘ Not installed on PATH` and `✔ Indexed` / `✘ Unindexed`, then:
  - `!installed`: banner, `<Cli>` with the `setup` command, `[ Refresh ]`, build buttons disabled.
  - `installed && !indexed`: `canBuild` gives `[ Build Index ]`; otherwise an explanation, `/graphify .`-style command box from `build`, and no headless build.
  - `installed && indexed`: `[ Use Indexer ]` (`build: false`) and, when `canBuild`, `[ Rebuild Index ]` (`build: true`).
- `auto` / `none`: description plus `[ Save Setting ]` (`build: false`).
- While busy: spinner text `Building index... (this may take a minute)`; options, action buttons, close button, Escape and backdrop click are disabled.
- On failure: `ErrorBox` with `error` and a scrollable monospace block with `stderr || stdout`; user can retry or close. On success: call `onChanged()` and `onClose()`.

### 5. UI integration

- `web/ui/src/Projects.tsx` `Doctor`: state `setup: boolean`; in the row map, when `c.name === 'code indexer' && !c.ok` render `<button class="btn btn-p btn-s">Setup Code Indexer</button>` that opens `<CodeSearchModal project={name} .../>`; `onChanged` and close both call `run()` so the check re-runs. No button when `c.ok`.
- `web/ui/src/Settings.tsx`: new "Code Search" `Panel` in the side column, loading `api.codeSearch(project)` alongside the settings; shows the setting, the effective engine (`none` shown as `none (Grep and Glob)`) and the warning; the button reads `Setup Code Indexer` when `effective === 'none'` with a warning, or the configured indexer is not installed/indexed; otherwise `Configure Code Indexer`. `onChanged` re-fetches both `api.settings(project)` and `api.codeSearch(project)`. Update the file's header comment, which says settings are read-only.
- `web/ui/src/styles.css`: only if the spinner, badge or terminal block needs a class that does not exist; reuse `s-done`, `s-failed`, `cli`, `mono`, `code`, `banner`, `error` first.

### 6. Tests (all import or run real code)

- `test/code-search.test.ts` (extend; it already imports `resolve`): `codeSearchStatus` with a temp project and a fake `graft` script dir on `env.PATH`: not installed gives `installed:false`; installed without `graft/` gives `indexed:false`; with the dir gives `indexed:true`; `canBuild` true for graft, false for graphify; a custom indexer with `buildCommand` is buildable; `codeSearchErrors` rejects a `buildCommand` with `;`, `&&` or `$(...)`; `codeBuildArgv` splits `graft build`.
- `web/test/code-search.test.ts` (new, same harness as `server.test.ts`, env with a temp bin dir first on `PATH` holding a fake `graft` that creates `graft/` on `build` and a failing/hanging variant, and a fake `graphify`):
  - GET status for the shop project: not installed, installed, indexed, effective engine, graphify `canBuild:false`; unknown project gives 404.
  - POST `{indexer:'auto'}` and `{indexer:'none'}` write `agent.codeSearch` in `sdlc.config.json` (other keys kept) and run no build (the fake graft leaves a marker file only on build).
  - POST `{indexer:'graft', build:true}` runs the build in the project root, writes the setting, and `GET /doctor` then reports `code indexer` `ok: true`.
  - Failing build gives 400, `ok:false`, `buildOutput.code`/`stderr`, and `sdlc.config.json` unchanged (compare file text).
  - Timeout: add an optional `ServerOptions.commandTimeoutMs` (default `COMMAND_TIMEOUT_MS`) so a test can use a short timeout with a sleeping fake graft; asserts `timedOut:true` and the config unchanged.
  - Not installed + `build:true` gives 400; graphify + `build:true` gives 400; unknown indexer gives 400; missing/non-string `indexer` gives 400; malformed `sdlc.config.json` gives an error and the file is not rewritten.
- UI (`Doctor` button, modal states, Settings panel) has no component-test harness in the repo; it is checked by `npm run typecheck` and `npm run build:web`, and by the Review stage.

### 7. Docs (separate step, no test)

- `docs/web-ui.md`: describe the Setup / Configure Code Indexer buttons (Doctor row and Settings), the modal (installed / indexed badges, install command, Build / Use / Rebuild / Save Setting), the two routes, the 120-second timeout, and that graphify is built with `/graphify .` in Claude Code.
- Mention `agent.codeIndexers.<name>.buildCommand` wherever the code indexer settings are documented (search `codeIndexers` in `README.md` and `docs/` during Implement).

### 8. Finish

- `npm run check > /tmp/sdlc-$(basename $PWD).log 2>&1; echo exit=$?`, then `npm run build:web`.
