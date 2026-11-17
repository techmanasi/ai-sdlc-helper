# Plan: ui-code-indexer-setup

Sources: `specs-1.md`, `decisions.md` (Rounds 1 and 2, binding). No source edits in this stage.

## Dependencies
- none

(Only Node built-ins: `node:child_process` `spawn`, `node:fs`, `node:path`. Preact, the server and the test runner already exist.)

## Design in one paragraph

The build logic lives in the engine (`src/config/codeSetup.ts`), not in the HTTP handler, so it is testable by calling it directly and through the real server. It reuses `codeIndexers`, `unavailable`, `codeSearchErrors` from `src/config/codeSearch.ts` (`unavailable` and a new `onPath` export are made public). The server (`web/server/index.ts`) adds two thin routes next to `doctor`/`settings` (`web/server/index.ts:247-271`). The UI gets one modal component used by `Projects.tsx` (Doctor card) and `Settings.tsx`.

## Steps (in order)

### 1. `src/config/codeSearch.ts`: expose what setup needs
- `export` the existing `onPath` helper (line 41) and keep `unavailable` (line 74, already exported).
- Add `export function runnableBuild(ix: CodeIndexer): { program: string; args: string[] } | null` (Round 2 Q1/Q2): returns null when `ix.build` is missing/blank, contains any of `; & | < > $ \` ( ) " '`, or its first whitespace-split word is not `ix.command`. Otherwise `{ program: command, args: rest }`. With the built-ins this gives `graft build` → runnable; graphify's prose (first word `build` ≠ `graphify`) → null. `CODE_INDEXERS` is unchanged.
- `src/index.ts:6`: add `unavailable`, `runnableBuild`, `onPath as codeIndexerOnPath` (if needed by the server) to the export list; export the new setup module (step 2).

### 2. New `src/config/codeSetup.ts`: the build operation (engine)
Types:
```ts
export type OpStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'timeout';
export interface SetupOperation { status: OpStatus; indexer: string | null; startedAt: string | null; endedAt: string | null; exitCode: number | null; error: string | null; output: string[] }
export const SETUP_INDEXERS = ['graft', 'graphify'] as const;
```
Functions:
- `inspectCodeSearch(root, env): { configured, active: {codeSearch, indexer, warning}, indexers: [{name, command, installed, index, indexed, build, setup, runnable}] }`. Reads `sdlc.config.json` leniently (malformed → `{}`; also `{}` when `codeSearchErrors(file)` is non-empty, as `doctor.ts` does). `configured` = `agent.codeSearch || 'auto'`. Only `graft` and `graphify` are listed (Round 1 Q2) from `codeIndexers(file)` (project overrides apply). `installed` = `onPath(command, env)`; `indexed` = `exists(root/index)`; `runnable` = `runnableBuild(ix) !== null` (the UI disables `Configure & Build` unless `installed && runnable`). The spec's `active` block comes from `codeSearchFor`.
- `createCodeSetup(opts: { env, timeoutMs = 600_000, killGraceMs = 5_000 })` returning `{ operation(root): SetupOperation; start(root, indexer): SetupOperation }`. State: `Map<root, SetupOperation>` in memory.
  - `start` validation, in order, each throwing `SetupError(status, message, extra?)`: indexer not `graft`/`graphify` → 400 `indexer must be 'graft' or 'graphify'`; existing `sdlc.config.json` unparsable → 400 `sdlc.config.json is not valid JSON; fix it first` (missing file is fine); binary not on PATH → 400 `<name> is not installed (no <command> command)` with `setup`; `runnableBuild` null → 400 `<name> has no build command defined` with `setup`; operation for root `running` → 409 `a code indexer build is already in progress for this project`. Nothing is spawned on any rejection.
  - Spawn: `spawn(program, args, { cwd: root, env, stdio: ['ignore','pipe','pipe'] })`, no shell. Both streams feed a rolling buffer (last 100 lines and at most 32 KB).
  - Timeout: `setTimeout(timeoutMs)` → `child.kill('SIGTERM')`, then `SIGKILL` after `killGraceMs`; state `timeout`, error `Build timed out after 10 minutes`; the later `close` event must not overwrite it.
  - `error` event (spawn failure) → `failed` with the message (visible, not swallowed).
  - On `close` with code 0: call `unavailable(ix, root, env)`; non-null → `failed`, error `Build exited successfully, but index files were not found`, config untouched. Else persist: read the file (or `{}`), `agent = { ...agent, codeSearch: indexer }`, write `JSON.stringify(next, null, 2) + '\n'` (same shape as `codeSearch()` in `src/cli/main.ts:173-210`). A write error → `failed`, error `Index was built successfully, but saving configuration to sdlc.config.json failed: <reason>`. Only then `succeeded`.
  - Non-zero exit → `failed`, `exitCode`, error `Build failed with exit code N`, config untouched. Generated files are never removed.
  - Always set `endedAt` and clear timers.

### 3. `web/server/index.ts`: two routes (after the `doctor` line, ~line 247)
- Create one `createCodeSetup({ env, timeoutMs: opts.codeSetupTimeoutMs, killGraceMs: opts.codeSetupKillGraceMs })` inside `startServer`; add those two optional fields to `ServerOptions` (tests shorten them).
- `what === 'code-search' && method === 'GET' && !parts[3]` → `send(200, { ...inspectCodeSearch(p.path, env), operation: setup.operation(p.path) })`.
- `what === 'code-search' && parts[3] === 'setup' && method === 'POST'` → `setup.start(p.path, body.indexer)`; on success `send(202, { ok: true, status: 'running', indexer, message: 'Index build started' })`; map `SetupError` to `HttpError(status, message)` (400 responses also carry `setup`). Unknown project already 404s through `project()` (line 242).
- After a run ends the settings context cache invalidates itself through `contextKey` (config mtime), so no explicit `dropContext` is needed; the server must still not hold the route open for the build.
- `p.path` is used as the root key, so GET and POST agree.

### 4. `web/ui/src/api.ts`: client calls and types
- Types `CodeSearchView` (matching step 3) and `SetupOperation`.
- `api.codeSearch(project)` → `GET ${p(project)}/code-search`; `api.setupCodeSearch(project, indexer)` → `POST ${p(project)}/code-search/setup` `{ indexer }` (follow the `call` pattern of `doctor`/`settings`, lines 193-199).

### 5. New `web/ui/src/CodeIndexerSetup.tsx`: the modal
Props `{ project, onClose(changed: boolean) }`. Behaviour per spec 3.3:
- On open call `api.codeSearch`; show `Loading…`. If `operation.status === 'running'`, show the in-progress view at once (`Building <indexer> index…`).
- Header: configured value and active engine. List `graft` and `graphify` as radio cards: `✔ Installed on PATH` or `✘ Command '<command>' not found on PATH`; `Indexed` / `Not indexed`; the `setup` text when not installed or not `runnable` (graphify shows `/graphify .` in Claude Code).
- `Configure & Build` disabled unless the selected indexer is `installed && runnable`; click → `api.setupCodeSearch`; then poll `api.codeSearch` every 1.5 s while `running` (use the existing `usePoll.ts` helper if its shape fits, else a `useEffect` timer cleared on unmount; closing the modal does not cancel the server build).
- Result view: success `✔ <indexer> index built and configured successfully` + `Done`; failure shows the error and the `output` tail in a `<pre>` plus `Retry` and `Close`. `Done` calls `onClose(true)`; other closes call `onClose(false)`.
- Errors from the API go to `ErrorBox` (always visible).

### 6. `web/ui/src/Projects.tsx` (Doctor, lines 8-28)
- In the `checks.map` row, when `c.name === 'code indexer' && !c.ok`, render a `[ Setup Code Indexer ]` button; it opens `CodeIndexerSetup`. `onClose(true)` calls `run()` so the check re-runs. No button when `c.ok` (including `agent.codeSearch: "none"`).

### 7. `web/ui/src/Settings.tsx` (header row, line 15-18)
- Always render a `Setup Code Indexer` button beside the existing buttons; it opens the modal. `onClose(true)` reloads settings via the same `api.settings(project)` call (extract the existing `useEffect` body into a `load` function).

### 8. Tests (real code, no document assertions)
New `web/test/code-search-setup.test.ts`, using the server fixture style of `web/test/backlog-edit-route.test.ts` (temp git repo, `startServer`, env with a temp `bin/` dir first on `PATH` holding stub executables). Stubs: `graft` (`graft build` creates `graft/` dir and exits 0; variants controlled by an env var file: exit 1, hang, exit 0 without creating the index). Cases map to the scenarios:
- GET lists `graft` installed and unindexed, `graphify` not installed with `setup` and `runnable: false`; unknown project → 404 (Scenario 4).
- POST success: 202, then poll GET until `succeeded`; `sdlc.config.json` has `agent.codeSearch === 'graft'`, unrelated keys kept, 2-space JSON with trailing newline; `doctor` check `code indexer` is `ok` (Scenario 5). Absent config file is created.
- Malformed `sdlc.config.json`: 400 and the stub never ran (marker file absent), file unchanged (Scenario 6).
- Concurrent POST while the stub hangs: second gets 409 (Scenario 7); GET shows `running`.
- Exit 1: `failed`, output tail includes the stub's stderr, `codeSearch` remains `none` (Scenario 8).
- Exit 0 without index: `failed` with `Build exited successfully, but index files were not found`, config untouched.
- Read-only config (chmod 0444 on the file or directory) after a good build: error mentions the index was built but the config not saved.
- Timeout: server started with `codeSetupTimeoutMs: 300`; the hanging stub is killed, status `timeout`, message `Build timed out after 10 minutes` (Scenario 9).
- `indexer: 'custom'`, missing `indexer`, `graphify` (prose build) → 400, nothing spawned.
Plus unit tests in `test/code-search.test.ts` (existing file) for `runnableBuild`: `graft build` → `{program:'graft', args:['build']}`; graphify default → null; `graft build; rm -rf x` → null; first word differing from `command` → null; blank → null; project override `{ build: 'graft build --fast' }` → args `['build','--fast']`.
Run each file with `ai-sdlc-helper run --file <file>`; the full suite runs in CI.

### 9. Documentation (separate step, no test)
- `README.md` (UI section): the Setup Code Indexer action in Doctor and Settings, the two endpoints, and the 10-minute limit; mention that only `graft` builds from the UI and graphify stays a Claude Code `/graphify .` step.
- Update the comment at the top of `web/ui/src/Settings.tsx` if it still says settings are read-only.

## Notes / risks
- `graft` appearing in `PATH` for tests: `shell.onPath` reads `env.PATH` from the env passed to `startServer`, so stubs need no global changes.
- The in-memory operation map is per server process (out of scope: persistence across restarts).
- Keep Node 18 APIs only (no `AbortSignal.timeout` reliance; plain timers).
- After the code changes run `graft build` to refresh the graph, as AGENTS.md asks.
