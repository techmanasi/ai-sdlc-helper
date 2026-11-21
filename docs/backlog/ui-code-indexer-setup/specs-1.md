# Spec: ui-code-indexer-setup

Type: feature · Priority: P2 (normal) · Sources: `docs/backlog/ui-code-indexer-setup/brief.md` and `docs/backlog/ui-code-indexer-setup/decisions.md`

## 1. Summary

The Doctor check (`src/registry/doctor.ts`, `web/ui/src/Projects.tsx`) and Settings view (`web/ui/src/Settings.tsx`) currently only display text warnings and CLI hints (e.g., `ai-sdlc-helper code-search <dir> --list`) when an indexer is not configured or unindexed. Users have no interactive web UI button to inspect whether `graft` or `graphify` binaries are installed on PATH, select one, or trigger the initial index build and configuration.

This feature adds interactive code indexer setup capabilities across the web UI and backend:
1. **Interactive Triggers:**
   - In `web/ui/src/Projects.tsx`: An inline `[ Setup Code Indexer ]` action button rendered directly within the `code indexer` row of the `Doctor` card when the check is failing (`!c.ok`).
   - In `web/ui/src/Settings.tsx`: A persistent `[ Code Search ]` header button in the top action bar (always accessible to configure, switch, or rebuild indexers), plus an inline `[ Setup Code Indexer ]` button rendered directly inside the warning banner whenever code search warnings are present.
2. **Selection & Build Modal:**
   - An accessible modal dialog presenting supported code indexers (e.g. `graft`, `graphify`, and any project-declared indexers).
   - Displays binary installation status on PATH, project index status (indexed vs. unindexed), and installation instructions if the CLI binary is missing.
   - Provides appropriate actions based on binary and index state:
     - Missing binary: Displays install command with a copy button; action buttons disabled.
     - Installed and already indexed: Offers a primary `[ Use <indexer> ]` button (switches `agent.codeSearch` in `sdlc.config.json` without rebuilding) and a secondary `[ Rebuild Index ]` button.
     - Installed but unindexed: Offers `[ Build Index ]` (or `[ Configure & Build ]`) for executable indexers, or displays interactive instructions with a copy button and a configuration button for non-executable indexers.
3. **Backend API Endpoints:**
   - `GET /api/projects/:project/code-search`: Inspects and returns indexer availability, PATH status, index file existence, and current settings.
   - `POST /api/projects/:project/code-search/setup`: Executes the build command (if requested and executable) with a 120-second timeout, updates `agent.codeSearch` in `sdlc.config.json`, and returns the refreshed doctor checks.

---

## 2. Current Behaviour (Verified)

1. **`src/config/codeSearch.ts`:**
   - Defines `CODE_INDEXERS` containing `graft` and `graphify`.
   - `graft`: `command: 'graft'`, `index: 'graft'`, `build: 'graft build'`.
   - `graphify`: `command: 'graphify'`, `index: 'graphify-out/graph.json'`, `build: 'build the graph with /graphify . in Claude Code'`.
   - `codeSearchFor(root, file, env)` checks availability and returns `{ codeSearch, indexer, warning }`. If unindexed or missing, it returns `codeSearch: 'none'` with an advisory warning string.
   - There are no public backend helper functions to inspect the full list of indexers with their installation and indexing status for API serialization.
2. **`src/registry/doctor.ts`:**
   - Line 130: Checks `codeSearchFor(root, ...)`.
   - Produces a non-required check with name `'code indexer'`. When `search.warning` is non-null, `ok` is `false`, `detail` describes the fallback to Grep and Glob, and `fix` states: `see the indexers with: ai-sdlc-helper code-search <root> --list`.
3. **`web/ui/src/Projects.tsx`:**
   - The `Doctor` component maps over `checks` and renders check rows. When `!c.ok && c.fix`, it displays `Fix: <fix>` as plain text with no action buttons.
4. **`web/ui/src/Settings.tsx`:**
   - Read-only dashboard showing resolved settings and raw `sdlc.config.json`.
   - Header contains disabled buttons for `Edit settings` and `Edit prompts`.
   - Displays warning banners if `data.warnings` contains messages, but offers no inline actions.
5. **`web/server/index.ts`:**
   - Exposes `/api/projects/:project/doctor` and `/api/projects/:project/settings`, but has no dedicated code search endpoints.

---

## 3. Configuration & Indexer Inspection

### 3.1 Supported Indexers
The inspection and setup mechanism covers all indexers resolved by `codeIndexers(file)`:
1. Built-in `graft`:
   - Command: `graft`
   - Index path: `graft` (directory relative to project root)
   - Setup instruction: `npm install -g @nanonets/graft, then graft build`
   - Build instruction: `graft build` (executable command)
   - Executable build: `true`
2. Built-in `graphify`:
   - Command: `graphify`
   - Index path: `graphify-out/graph.json` (file relative to project root)
   - Setup instruction: `uv tool install graphifyy (or pipx install graphifyy), then build the graph with /graphify . in Claude Code`
   - Build instruction: `build the graph with /graphify . in Claude Code` (interactive agent instruction, not shell-executable)
   - Executable build: `false`
3. Custom indexers:
   - Any project-declared indexer in `sdlc.config.json` under `agent.codeIndexers`.
   - Executable build: `true` if `build` is present, starts with an executable program name that matches `PROGRAM` (`/^[\w.@+-]+$/`), and does not require Claude Code interactive prompts.

### 3.2 State Evaluation per Indexer
For each indexer, the system evaluates:
- **`installed`**: `boolean` — true if `command` is non-empty and found on PATH via `onPath(command, env)`.
- **`indexed`**: `boolean` — true if `index` is non-empty and exists on disk in the project root (`exists(path.join(root, index))`).
- **`canBuild`**: `boolean` — true if `installed` is true, `build` is defined, and `build` represents a direct CLI command that can be spawned (e.g. `graft build`), as opposed to human/interactive agent instructions.
- **`setup`**: `string | null` — setup / install instructions.
- **`build`**: `string | null` — build command string or interactive instruction.

---

## 4. Behaviour

### 4.1 Backend Inspection Helpers (`src/config/codeSearch.ts`)
Provide a helper function (e.g. `inspectCodeSearch(root, file, env)`) that evaluates:
1. Configured setting: Reads `agent.codeSearch` from project config (defaulting to `'auto'`).
2. Current effective indexer: Calls `codeSearchFor(root, file, env).codeSearch`.
3. List of indexer statuses: Iterates all indexers from `codeIndexers(file)` and generates an array containing `name`, `command`, `installed`, `indexed`, `setup`, `build`, and `canBuild`.

### 4.2 Web Server Endpoints (`web/server/`)

#### 4.2.1 `GET /api/projects/:project/code-search`
- **Method:** `GET`
- **Path:** `/api/projects/:project/code-search`
- **Authentication:** Standard token guard.
- **Behaviour:**
  - Resolves project `p`.
  - Reads `sdlc.config.json` in `p.path`.
  - Computes inspection status via the backend helper.
  - Returns HTTP 200 with the code search inspection payload.

#### 4.2.2 `POST /api/projects/:project/code-search/setup`
- **Method:** `POST`
- **Path:** `/api/projects/:project/code-search/setup`
- **Authentication:** Standard token guard and CSRF/Origin guard.
- **Request Body:**
  - `indexer`: (string, required) The name of the indexer to configure (e.g., `'graft'`, `'graphify'`).
  - `build`: (boolean, optional) Whether to run the indexer's build command prior to updating configuration. Defaults to `false`.
- **Behaviour & Execution Rules:**
  1. Validate that `indexer` exists in `codeIndexers(file)`. If invalid, return HTTP 400 with `{ ok: false, error: "unknown indexer: '<indexer>'" }`.
  2. If `build: true`:
     - Verify that the indexer is installed on PATH and has `canBuild === true`. If `canBuild` is false (e.g. for `graphify` or missing binary), return HTTP 400 with `{ ok: false, error: "cannot build indexer '<indexer>': no executable build command or binary not on PATH" }`.
     - Execute the build command (e.g. `graft build`) with the working directory set to the project root (`p.path`) and environment `env`.
     - Impose a process timeout of 120 seconds (`COMMAND_TIMEOUT_MS`).
     - Collect standard output and standard error.
     - If the build process exits with a non-zero code or times out:
       - Return HTTP 400 with `{ ok: false, error: "<failure reason>", output: "<combined stdout/stderr>" }`.
       - **Do NOT** modify `sdlc.config.json`.
  3. If the build succeeds or `build: false`:
     - Update `agent.codeSearch = indexer` in `sdlc.config.json` using `editSettings(p.path, { agent: { codeSearch: indexer } })`.
     - Invalidate project context cache (`dropContext(p.name)`).
     - Re-run doctor checks for `p.path` via `doctor(p.path, { env })`.
     - Return HTTP 200 with `{ ok: true, codeSearch: indexer, output: "<build output if built>", checks: <refreshed checks> }`.

### 4.3 Web UI

#### 4.3.1 Doctor Card Action Trigger (`web/ui/src/Projects.tsx`)
1. In `web/ui/src/Projects.tsx`, inspect each check in `Doctor`.
2. For the check item where `c.name === 'code indexer'` and `!c.ok`:
   - Render a `[ Setup Code Indexer ]` action button (styled as `btn btn-s btn-p` or `btn btn-s`) inline within the check row (alongside or below the `Fix:` text).
   - Clicking the button opens the Code Search Setup Modal for the active project.
   - When the modal completes setup or closes after changes, the `Doctor` component automatically re-fetches doctor checks (`api.doctor(name)`) so that the check turns green (`✔`) immediately.

#### 4.3.2 Settings Page Action Triggers (`web/ui/src/Settings.tsx`)
1. **Header Action Bar:**
   - In `web/ui/src/Settings.tsx`, add a `[ Code Search ]` button (class `btn btn-s` or `btn`) to the top header row alongside the existing `Edit settings` and `Edit prompts` buttons.
   - This button is always active and enabled, regardless of whether the current code search check is passing or failing, allowing users to inspect, switch, or re-index at any time.
   - Clicking the button opens the Code Search Setup Modal.
2. **Warning Banner Inline Trigger:**
   - If `data.warnings` contains a warning string concerning code search (e.g. matching `/code (indexer|search)/i` or `/code search uses Grep and Glob/`), render an inline `[ Setup Code Indexer ]` button directly within or alongside the warning banner.
   - Clicking this button opens the Code Search Setup Modal.

#### 4.3.3 Code Search Setup Modal (`web/ui/src/CodeSearchModal.tsx`)
Create a dedicated accessible modal component following existing modal patterns (`Projects.tsx`, `dialog.ts`):
1. **Accessibility & Keyboard Navigation:**
   - Markup container has `role="dialog"`, `aria-modal="true"`, `aria-label="Code Search Setup"`, and `tabindex="-1"`.
   - Focus is automatically trapped within the modal; pressing Escape closes the modal; clicking the backdrop closes the modal.
2. **Modal Content & Layout:**
   - Title header: `Code Search Setup · <project name>` with a `[ Close ]` button.
   - Displays current setting (`agent.codeSearch`) and effective search status.
   - Lists supported indexers (cards or list items for each indexer, e.g. `graft`, `graphify`).
3. **Card Presentation per Indexer:**
   - **Header:** Indexer name (e.g. `graft`), current active badge (e.g. `current` tag if active in `sdlc.config.json`).
   - **Status Badges:**
     - Installation status: `✔ Installed` or `✘ Binary not found on PATH`.
     - Index status: `✔ Indexed` (with path details, e.g. `graft/`) or `! Unindexed`.
   - **Scenario A: Binary Missing on PATH:**
     - Displays install instructions (e.g. `npm install -g @nanonets/graft` or `uv tool install graphifyy`) with a `CopyButton`.
     - Action buttons (`Build Index`, `Use Indexer`) are disabled.
   - **Scenario B: Binary Installed & Index Already Exists:**
     - Primary action: `[ Use <indexer> ]` button.
       - Invokes setup endpoint with `{ indexer: name, build: false }`.
       - Sets `agent.codeSearch = indexer` without rebuilding.
     - Secondary action (if `canBuild: true`): `[ Rebuild Index ]` button.
       - Invokes setup endpoint with `{ indexer: name, build: true }`.
   - **Scenario C: Binary Installed & Unindexed:**
     - If `canBuild: true` (e.g. `graft`):
       - Primary action: `[ Build Index ]` button.
       - Invokes setup endpoint with `{ indexer: name, build: true }`.
     - If `canBuild: false` (e.g. `graphify`):
       - `[ Build Index ]` button is disabled.
       - Renders build instruction text (e.g. `build the graph with /graphify . in Claude Code`) with a `CopyButton`.
       - Renders a `[ Configure (agent.codeSearch: graphify) ]` button to set `agent.codeSearch = graphify` once the index exists.
4. **Loading & Feedback States:**
   - During index building:
     - Disables modal buttons.
     - Displays a loading indicator and status message (e.g. `Building index... this may take up to a minute`).
   - On Error:
     - Displays error message in an `ErrorBox`.
     - If the build produced output, displays terminal output in a scrollable `<pre class="code mono">` block.
   - On Success:
     - Displays success toast or confirmation badge.
     - Calls `onConfigured()` callback to trigger doctor and settings refresh.
     - Closes modal or updates local indexer statuses.

#### 4.3.4 Frontend API Client (`web/ui/src/api.ts`)
Add frontend API client methods:
- `codeSearch: (project: string) => call<CodeSearchStatus>('GET', ...)`
- `setupCodeSearch: (project: string, body: { indexer: string; build?: boolean }) => call<CodeSearchSetupResult>('POST', ...)`

---

## 5. Inputs and Outputs

### 5.1 Data Contracts

#### 5.1.1 `CodeIndexerStatus`
Properties:
- `name`: `string` — Indexer identifier (e.g. `'graft'`, `'graphify'`).
- `command`: `string | null` — CLI executable name.
- `installed`: `boolean` — Whether executable is found on PATH.
- `indexed`: `boolean` — Whether index file/directory exists in project root.
- `setup`: `string | null` — Installation instruction string.
- `build`: `string | null` — Build command line or interactive instruction string.
- `canBuild`: `boolean` — Whether server can execute the build command automatically.

#### 5.1.2 `CodeSearchStatusResponse`
Properties:
- `setting`: `string` — Value of `agent.codeSearch` in `sdlc.config.json` (e.g. `'auto'`, `'graft'`, `'graphify'`, `'none'`).
- `current`: `string` — Active indexer in use (e.g. `'graft'`, `'none'`).
- `indexers`: `CodeIndexerStatus[]` — Array of inspected indexers.

#### 5.1.3 `CodeSearchSetupRequest`
Properties:
- `indexer`: `string` (required) — Target indexer name.
- `build`: `boolean` (optional) — If true, triggers index build prior to configuration.

#### 5.1.4 `CodeSearchSetupResponse`
Properties:
- On Success (HTTP 200):
  - `ok`: `true`
  - `codeSearch`: `string` — Newly configured `agent.codeSearch`.
  - `output`: `string | undefined` — Output captured from build process if executed.
  - `checks`: `Check[]` — Refreshed doctor checks list.
- On Failure (HTTP 400):
  - `ok`: `false`
  - `error`: `string` — Human-readable failure explanation.
  - `output`: `string | undefined` — Captured stdout/stderr from failed build process.

---

## 6. Error Cases & Edge Cases

1. **Indexer Binary Missing on PATH:**
   - `installed` evaluates to `false`.
   - Setup modal shows installation instructions with a copy button.
   - Build buttons are disabled in the UI.
   - Backend rejects `POST` with `build: true` returning HTTP 400 with an informative error message.
2. **Interactive Build Commands (e.g. `graphify`):**
   - In `src/config/codeSearch.ts`, `graphify.build` requires Claude Code interactive execution (`build the graph with /graphify . in Claude Code`).
   - `canBuild` evaluates to `false`.
   - UI disables `[ Build Index ]` and shows the copyable Claude Code command.
   - Once the index file (`graphify-out/graph.json`) exists, the user can click `[ Configure (agent.codeSearch: graphify) ]` or `[ Use graphify ]`.
   - Backend rejects `POST` with `indexer: 'graphify'` and `build: true` with HTTP 400.
3. **Build Command Failure (Non-Zero Exit Code):**
   - If the index build command fails (e.g. syntax error in codebase causing indexer crash, or missing tool permissions), the process terminates with exit code != 0.
   - Backend captures `stdout` and `stderr`.
   - `sdlc.config.json` is **NOT** modified.
   - Endpoint returns HTTP 400 with `{ ok: false, error: "<command> exited with code <N>", output: "<combined output>" }`.
   - UI renders the error message and preserves build output in a preformatted block.
4. **Build Process Timeout:**
   - If the build command exceeds 120 seconds (`COMMAND_TIMEOUT_MS`), the backend process kills the spawned child process.
   - Returns HTTP 400 with `{ ok: false, error: "build timed out after 120s" }`.
   - `sdlc.config.json` is **NOT** modified.
5. **Project Without `sdlc.config.json`:**
   - If `sdlc.config.json` does not exist, `editSettings` creates or updates it with the `agent.codeSearch` property.
6. **Concurrent Requests:**
   - While a build is in progress, the UI disables setup buttons to prevent duplicate triggers.
7. **Accessibility & Dialog Trapping:**
   - Modals trap focus and allow closing with the `Escape` key, following existing app dialog standards (`web/ui/src/dialog.ts`).

---

## 7. Acceptance Criteria

1. **Inspection API:**
   - `GET /api/projects/:project/code-search` returns HTTP 200 with `setting`, `current`, and an array of `indexers` matching the schema in Section 5.1.
   - When `graft` is installed on PATH and indexed in the project, `installed: true` and `indexed: true`.
   - When an indexer binary is not on PATH, `installed: false` and `canBuild: false`.
   - Built-in `graphify` always reports `canBuild: false`.
2. **Setup API Execution:**
   - `POST /api/projects/:project/code-search/setup` with `{ indexer: 'graft', build: true }` executes `graft build`, updates `sdlc.config.json` setting `agent.codeSearch` to `'graft'`, and returns HTTP 200 with refreshed doctor checks.
   - `POST /api/projects/:project/code-search/setup` with `{ indexer: 'graft', build: false }` updates `sdlc.config.json` setting `agent.codeSearch` to `'graft'` without running a build command.
   - `POST` with `build: true` on an indexer with `canBuild: false` returns HTTP 400.
   - `POST` where the build process exits with non-zero status returns HTTP 400 with `error` and `output`, leaving `sdlc.config.json` unchanged.
3. **Doctor Card UI:**
   - In `web/ui/src/Projects.tsx`, when `code indexer` check fails (`!c.ok`), a `[ Setup Code Indexer ]` button is visible in the check row.
   - Clicking `[ Setup Code Indexer ]` opens the modal.
   - Completing setup closes the modal and turns the doctor check to green (`✔`).
4. **Settings Page UI:**
   - In `web/ui/src/Settings.tsx`, a `[ Code Search ]` button is always present in the header row.
   - When a warning regarding code search exists in `warnings`, an inline `[ Setup Code Indexer ]` button appears inside the warning banner.
   - Clicking either button opens the setup modal.
5. **Setup Modal Interaction:**
   - Lists indexers with installation status and index status badges.
   - Shows copyable installation instructions when the binary is not on PATH.
   - Shows `[ Use <indexer> ]` and `[ Rebuild Index ]` when already indexed.
   - Shows `[ Build Index ]` when installed but unindexed and `canBuild: true`.
   - For `graphify`, shows copyable `/graphify . in Claude Code` command instruction and disables direct build.
   - Displays clear loading state during index build.
   - Displays error messages and process output on failure.
6. **Selector Integrity & Quality:**
   - Any selector added to `sdlc-ui.js` exists in `web/ui/src/` ensuring `test/ui-automation.test.ts` passes.
   - Web UI passes typecheck (`npm run typecheck`) and build (`npm run build:web`).

---

## 8. Out of Scope

1. Automatically executing package manager installation commands (`npm install -g`, `pipx`, `uv`) on the host machine.
2. Building indexes inside worktrees or background supervisor runs; setup applies to the project root.
3. General settings configuration for unrelated configuration keys.
