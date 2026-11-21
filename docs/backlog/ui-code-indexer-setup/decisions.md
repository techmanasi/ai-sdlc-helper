# Decisions for ui-code-indexer-setup

## Round 1 (2026-11-20)

### Q1: Handling `graphify` index build vs. `graft build`
In `src/config/codeSearch.ts`, `CODE_INDEXERS.graft.build` is `'graft build'`, which is an executable CLI command that the server can run via `spawn`. In contrast, `CODE_INDEXERS.graphify.build` is `'build the graph with /graphify . in Claude Code'`, which is an interactive instruction for Claude Code rather than a shell-executable command. The brief states: "Clicking triggers the build command (e.g. `graft build` or graphify build command)". Attempting to spawn `'build the graph with /graphify . in Claude Code'` as a shell command will fail. How should the setup modal and backend handle building for `graphify`?
**Suggested:** Only execute backend build commands when the indexer specifies an executable command line (e.g. `graft build`). For `graphify` (or any indexer whose build instruction requires Claude Code or manual interactive steps), disable the `[ Build Index ]` button, display the command instruction (`/graphify . in Claude Code`) with a copy button, and provide a `[ Configure (agent.codeSearch: graphify) ]` button to set the configuration in `sdlc.config.json` once the index (`graphify-out/graph.json`) is generated.
**Answer:** accept

### Q2: Modal options when an index is already built vs. unindexed
An indexer can be in one of three states on the host project:
1. Binary not installed on PATH.
2. Binary installed, but unindexed (no index folder/file in project).
3. Binary installed and index already exists in project root.
When an indexer already has a built index (e.g. `graft/` or `graphify-out/graph.json` exists), the user may want to switch `agent.codeSearch` to it without re-running a full index build. What buttons/actions should the modal offer for an already indexed indexer vs. an unindexed indexer?
**Suggested:**
- If binary is missing on PATH: Disable build/configure buttons and show install instructions (`npm install -g @nanonets/graft` or `uv tool install graphifyy`).
- If binary is installed and index already exists: Show a primary `[ Use <indexer> ]` button (sets `agent.codeSearch` in `sdlc.config.json` without rebuilding) and a secondary `[ Rebuild Index ]` button.
- If binary is installed but unindexed: Show `[ Build Index ]` (or `[ Build & Configure ]`) which runs the build command and updates `agent.codeSearch`.
**Answer:** accept

### Q3: API endpoint contracts and build failure handling
The brief outlines `GET /api/projects/:project/code-search` and `POST /api/projects/:project/code-search/setup`. The exact payload structures, timeout behavior, and error handling are not defined. What should the request and response schemas be, and how should build errors be handled?
**Suggested:**
- `GET /api/projects/:project/code-search`: Returns `{ setting: string, current: string, indexers: Array<{ name: string, command: string | null, installed: boolean, indexed: boolean, setup: string | null, build: string | null, canBuild: boolean }> }`.
- `POST /api/projects/:project/code-search/setup`: Request body `{ indexer: string, build?: boolean }`.
  - When `build: true` is requested and the indexer has an executable build command, execute it with a timeout (e.g. 120s matching `COMMAND_TIMEOUT_MS`).
  - If the build process exits with a non-zero code or times out, return HTTP 400 with `{ ok: false, error: string, output: string }` and do not modify `sdlc.config.json`.
  - If the build succeeds (or `build: false`), update `agent.codeSearch = indexer` in `sdlc.config.json` and return `{ ok: true, codeSearch: string, output?: string, checks: Check[] }` so the UI can update doctor check state immediately.
**Answer:** accept

### Q4: Settings page button placement and availability
The brief says: "When a code indexer is missing or unindexed, a `[ Setup Code Indexer ]` action button is displayed in the Doctor card (`web/ui/src/Projects.tsx`) and in the Settings view (`web/ui/src/Settings.tsx`)." Decisions add: "provide an action button/panel for code search setup so users can configure or switch indexers without going to the Projects page." Where in `web/ui/src/Settings.tsx` should the setup trigger appear, and should it remain accessible even when an indexer is already healthy?
**Suggested:**
1. In `web/ui/src/Settings.tsx`, add a `[ Code Search ]` button to the top header row (alongside `Edit settings` and `Edit prompts`). This button is always accessible (even when healthy) to allow switching or rebuilding indexers.
2. In addition, when `data.warnings` contains a code search warning, display an inline `[ Setup Code Indexer ]` button right inside the warning banner for one-click access.
**Answer:** accept

### Q5: Doctor card action button placement in `web/ui/src/Projects.tsx`
In `web/ui/src/Projects.tsx`, the `Doctor` component lists individual checks (Node, git, code indexer, etc.). Where should the `[ Setup Code Indexer ]` button be rendered within the Doctor component?
**Suggested:** Render the `[ Setup Code Indexer ]` button directly inline within the `code indexer` check item row whenever `!c.ok` (alongside or below the `Fix:` text). When clicked, it opens the indexer setup modal. Upon completing setup or closing the modal after changes, Doctor automatically re-runs checks (`api.doctor(name)`) to update the row to green (`✔`).
**Answer:** accept

## Round 2 (2026-11-20)

### Q6: Executable custom build declarations
How should a project declare that a custom `agent.codeIndexers.<name>.build` value is safe to treat as an executable command? The existing `build` string also holds manual instructions, and `PROGRAM` only validates the shape of a program name. Even a first word found on PATH does not establish whether the remaining text is command arguments or instructions for a human. The decision determines when the web server may start a process from project configuration.
**Suggested:** Add an optional `buildArgv` array for project-declared executable builds, including project overrides that replace a built-in build. Treat its first element as a `PROGRAM`-valid executable that must be on PATH and pass the remaining elements as literal arguments with the shell disabled. Keep `build` as display text. The default `graft build` remains executable and built-in Graphify remains manual.
**Answer:** accept

### Q7: Resolved index paths in the modal
May the inspection response include the resolved index path for each indexer? The modal calls for path details, while the approved response has only an `indexed` boolean. Projects can override even the built-in paths, so hard-coded labels could show a path different from the one the server checked.
**Suggested:** Add `index: string | null` to each `CodeIndexerStatus` and show the configured path when present. Return `null` when the indexer declares no on-disk index.
**Answer:** accept

### Q8: Setup for indexers without an index path
What should the modal offer for an installed custom indexer with no `index` path? The existing resolver can use it as soon as its binary is on PATH. The proposed `indexed` flag is always false without a path, so waiting for an index before enabling configuration would leave an otherwise usable indexer unavailable in the modal.
**Suggested:** Show `No index required` and enable `Use <indexer>` for installed indexers that declare no index path. Keep `indexed: false` in the response and offer `Rebuild Index` when an executable build is declared.
**Answer:** accept
