# Specification: ui-code-indexer-setup

Type: feature · Priority: P2 (normal)
Sources: `brief.md`, `decisions.md` (Round 1, binding).

## 1. Summary

The Doctor check (`src/registry/doctor.ts`, `web/ui/src/Projects.tsx`) and Settings page (`web/ui/src/Settings.tsx`) currently report text advisories when a project lacks a code indexer, instructing developers to run manual CLI commands such as `ai-sdlc-helper code-search --use ...` or `ai-sdlc-helper code-search <dir> --list`.

This feature adds an interactive web UI workflow to inspect, configure, and build supported code indexers (`graft`, `graphify`, as well as `auto` and `none`) directly from the web dashboard:
1. **Interactive Trigger Buttons**: Surfaced in the Doctor check row in `Projects.tsx` (when unconfigured or unindexed) and in a dedicated Code Search panel in `Settings.tsx` (always visible, styled as setup or configure).
2. **Code Indexer Modal**: Lists indexers with their PATH installation status and project index existence, installation hints with copyable CLI boxes, and actionable build/configure buttons.
3. **Backend API Endpoints**: Endpoints to inspect current indexer status/availability and to execute index builds and configuration updates safely with a 120-second timeout.
4. **Instant Verification**: Persists `agent.codeSearch` into `sdlc.config.json` and refreshes doctor status so the check turns green (✔).

Out of scope: automatically running global package installs (`npm install -g` or `pipx/uv`) on the host machine without user intervention, and general phase 2 arbitrary settings editing for unrelated config fields.

## 2. Definitions & Architecture

- **Supported Indexers**:
  - `graft`: binary command `graft`, index directory `graft/`, build command `graft build`, setup `npm install -g @nanonets/graft, then graft build`. Can be built headlessly.
  - `graphify`: binary command `graphify`, index file `graphify-out/graph.json`, setup `uv tool install graphifyy (or pipx install graphifyy), then build the graph with /graphify . in Claude Code`. Requires Claude Code slash command `/graphify .` for index generation; headless CLI build is disabled in the UI unless an executable CLI command is defined.
  - Custom indexers: any declared in `agent.codeIndexers` in `sdlc.config.json`.
- **Special Search Settings**:
  - `auto`: picks the first available indexer in `agent.codeSearchOrder` or default indexer list.
  - `none`: explicit fallback to Grep and Glob without warning notices.
- **Indexer State per Project**:
  - `installed`: binary `command` is found on PATH in the server environment (via `which` / `onPath`).
  - `indexed`: project root contains the index file or folder (`ix.index`).
  - `canBuild`: whether the indexer defines an automated headless shell command (true for `graft`, false for `graphify` which instructs interactive slash commands).
- **Timeout & Concurrency**:
  - Builds execute synchronously on the server process with a 120-second timeout, consistent with `web/server/index.ts` `runCommand`.
  - While a build is in progress, the UI displays an active progress indicator and disables modal dismissal to prevent duplicate triggers.

## 3. Behaviour

### 3.1 Doctor Check Integration (`web/ui/src/Projects.tsx`)

- When the `code indexer` doctor check item is not green (`!c.ok`), the check row renders an actionable button: `[ Setup Code Indexer ]`.
- When the `code indexer` doctor check item is green (`c.ok === true`), no setup button is rendered in the Doctor row.
- Clicking `[ Setup Code Indexer ]` opens the Code Indexer Selection Modal for that project.
- Closing the modal or completing a configuration/build re-runs `api.doctor(projectName)` to refresh check states immediately.

### 3.2 Settings View Integration (`web/ui/src/Settings.tsx`)

- The Settings view includes a dedicated **Code Search** section/panel displaying:
  - Current configured setting (`agent.codeSearch`, defaulting to `auto`).
  - Effective search engine in use (e.g. `graft`, `graphify`, or `none (Grep and Glob)`).
  - Any advisory warning if the configured indexer is unavailable or unindexed.
  - An interactive button:
    - Label `[ Setup Code Indexer ]` (action styled) when no indexer is active or the current indexer is unindexed.
    - Label `[ Configure Code Indexer ]` when an indexer is actively configured and green.
- Clicking the button opens the Code Indexer Selection Modal for that project.
- Upon successful save or build completion, the settings data is refreshed (`api.settings(project)`).

### 3.3 Selection Modal (`web/ui/src/CodeSearchModal.tsx` or component)

The modal provides an interactive workflow to inspect and configure code search:
- **Header**: "Code Search Indexer" with a close button (disabled while a build is running).
- **Options List**:
  - Supported indexers (`graft`, `graphify`, plus custom if configured in `agent.codeIndexers`).
  - Special modes: `Auto (first available)` and `None (Grep and Glob)`.
- **Selected Option Details**:
  - **For concrete indexers (`graft`, `graphify`)**:
    - **Installation Status**: Shows badge `✔ Installed on PATH` or `✘ Not installed on PATH`.
    - **Index Status**: Shows badge `✔ Indexed` or `✘ Unindexed` (checks for `graft/` or `graphify-out/graph.json`).
    - **Missing Binary Scenario** (`!installed`):
      - Displays instruction banner explaining that the binary must be installed on the host.
      - Displays copyable CLI snippet box with the installation command from `ix.setup` (e.g. `npm install -g @nanonets/graft` or `uv tool install graphifyy`).
      - Shows `[ Refresh ]` button to re-query the backend status without closing the modal.
      - Build action buttons are disabled.
    - **Installed & Unindexed Scenario** (`installed && !indexed`):
      - If `canBuild` is true (e.g. `graft`): Displays `[ Build Index ]` button.
      - If `canBuild` is false (e.g. `graphify`): Explains that graph generation requires running the interactive Claude Code slash command `/graphify .`. Displays command box with `/graphify .` and disables headless build.
    - **Installed & Already Indexed Scenario** (`installed && indexed`):
      - Displays two distinct action buttons:
        - `[ Use Indexer ]`: Configures `agent.codeSearch = <indexer>` in `sdlc.config.json` immediately without rebuilding.
        - `[ Rebuild Index ]`: Re-runs the build command and ensures `agent.codeSearch` is configured.
  - **For `Auto` / `None` options**:
    - Displays descriptive explanation (e.g. `Auto: automatically uses the first available installed indexer`, `None: always uses Grep and Glob without warnings`).
    - Displays `[ Save Setting ]` action button (updates `agent.codeSearch` without triggering any build).
- **Build Execution & Progress Feedback**:
  - While a build is executing:
    - Shows an inline loading spinner and text `Building index... (this may take a minute)`.
    - Disables action buttons, selection options, and modal close triggers (ESC key / close button / backdrop click).
  - If build fails (non-zero exit code or timeout):
    - Shows error alert box with error summary.
    - Displays full `stderr` (or `stdout`) in a scrollable monospace terminal output block.
    - Allows the user to dismiss or retry.
  - If build succeeds (exit code 0):
    - Automatically updates project settings `agent.codeSearch = <indexer>`.
    - Shows success confirmation or immediately closes modal and triggers parent refresh.

## 4. Inputs, Outputs & API Routes

### 4.1 Route: `GET /api/projects/:project/code-search`

Inspects code search configuration, effective indexer, and status of all available indexers.

- **Parameters**: `project` (URL slug).
- **Response (200 OK)**:
  ```json
  {
    "setting": "auto",
    "effective": "none",
    "warning": "no code indexer is available; code search uses Grep and Glob...",
    "indexers": [
      {
        "name": "graft",
        "command": "graft",
        "index": "graft",
        "installed": false,
        "indexed": false,
        "setup": "npm install -g @nanonets/graft, then graft build",
        "build": "graft build",
        "canBuild": true
      },
      {
        "name": "graphify",
        "command": "graphify",
        "index": "graphify-out/graph.json",
        "installed": false,
        "indexed": false,
        "setup": "uv tool install graphifyy (or pipx install graphifyy), then build the graph with /graphify . in Claude Code",
        "build": "build the graph with /graphify . in Claude Code",
        "canBuild": false
      }
    ]
  }
  ```

### 4.2 Route: `POST /api/projects/:project/code-search/setup`

Configures `agent.codeSearch` in `sdlc.config.json` and optionally executes the indexer's build command.

- **Parameters**: `project` (URL slug).
- **Request Body**:
  - `indexer`: string (`graft` | `graphify` | `auto` | `none` | custom indexer name). Required.
  - `build`: boolean. Optional (default `false`). If `true`, runs the build command before saving.
- **Validation**:
  - `indexer` must be `'auto'`, `'none'`, or a recognized indexer from `codeIndexers(file)`. If invalid, return 400 Bad Request with descriptive message.
  - If `build` is `true`:
    - Indexer must be installed on PATH. If not installed, return 400 Bad Request (`indexer <name> is not installed on PATH`).
    - Indexer must have an executable build command (`canBuild === true`). If not, return 400 Bad Request (`indexer <name> does not support automated headless build`).
- **Execution Flow**:
  1. If `build` is `true`:
     - Run build command (e.g. `graft build`) in project root with a 120-second timeout.
     - Capture exit code, stdout, stderr, and timedOut flag.
     - If build fails (`code !== 0` or `timedOut`): return 400 (or 200 with `ok: false`) including build outcome details. Do NOT update `sdlc.config.json`.
  2. If build succeeds or `build` was `false`:
     - Update `agent.codeSearch` in `sdlc.config.json` using atomic write (`editSettings` or equivalent).
     - Return 200 OK with `{ ok: true, codeSearch: indexer, buildOutput?: ... }`.
- **Response (200 OK / 400 Bad Request)**:
  ```json
  {
    "ok": true,
    "codeSearch": "graft",
    "buildOutput": {
      "code": 0,
      "stdout": "[graft] indexed 42 files...",
      "stderr": "",
      "timedOut": false
    }
  }
  ```
  On build failure:
  ```json
  {
    "ok": false,
    "error": "Build command failed with exit code 1",
    "buildOutput": {
      "code": 1,
      "stdout": "",
      "stderr": "graft: failed to parse...",
      "timedOut": false
    }
  }
  ```

### 4.3 Client API in `web/ui/src/api.ts`

- Add TypeScript interfaces:
  - `CodeIndexerStatus`: status details for each indexer (`name`, `command`, `index`, `installed`, `indexed`, `setup`, `build`, `canBuild`).
  - `CodeSearchView`: inspect response shape (`setting`, `effective`, `warning`, `indexers`).
  - `CodeSearchSetupResult`: setup response shape (`ok`, `codeSearch`, `buildOutput`, `error`).
- Add API methods:
  - `api.codeSearch(project: string): Promise<CodeSearchView>`
  - `api.codeSearchSetup(project: string, body: { indexer: string; build?: boolean }): Promise<CodeSearchSetupResult>`

## 5. Error Cases & Edge Cases

| Scenario | System Behaviour |
|---|---|
| Project does not exist (`project` slug not in registry) | 404 Not Found (`no project named '<project>'`). |
| Unknown indexer name submitted in setup | 400 Bad Request (`"<name>" is not a code indexer (use auto, none, graft, graphify)`). |
| `build: true` requested for non-installed binary | 400 Bad Request (`graft is not installed (no graft command on PATH)`). |
| `build: true` requested for interactive-only indexer (e.g. `graphify`) | 400 Bad Request (`graphify requires interactive build via Claude Code slash command: /graphify .`). |
| Build command times out after 120 seconds | Process terminated (SIGTERM), returns `{ ok: false, buildOutput: { timedOut: true, ... } }`. `sdlc.config.json` is not modified. |
| Build command fails with non-zero exit code | Returns `{ ok: false, buildOutput: { code: 1, stderr: "...", ... } }`. `sdlc.config.json` is not modified. |
| Malformed `sdlc.config.json` on disk | Handled gracefully by returning error without corrupting config file. |
| User closes browser or modal during build | Server process continues in background until completion or timeout; UI state catches up on next poll/request. |
| Indexer is already indexed | UI offers `[ Use Indexer ]` (no build overhead) as well as `[ Rebuild Index ]`. |
| Host PATH changes while modal is open | User clicks `[ Refresh ]` in modal to re-poll availability without closing dialog. |

## 6. Acceptance Criteria

1. **Doctor Action Button**:
   - When doctor check `code indexer` reports warning or failure (`!c.ok`), an action button `[ Setup Code Indexer ]` is visible on the row.
   - Clicking opens the indexer setup modal.
   - When doctor check `code indexer` passes green (`c.ok`), no setup button is shown on the doctor check row.
2. **Settings Section**:
   - Settings page displays a Code Search status section.
   - Displays `[ Setup Code Indexer ]` if unindexed/warning, or `[ Configure Code Indexer ]` if already active.
   - Clicking opens the indexer setup modal.
3. **Modal Inspection & Options**:
   - Modal queries `GET /api/projects/:project/code-search` and lists `graft`, `graphify`, `Auto`, and `None`.
   - Each indexer clearly displays installation status (on PATH) and project index existence.
   - If binary is missing on PATH, install instructions and copyable CLI command are displayed, build buttons are disabled, and a `[ Refresh ]` button is available.
   - If an indexer is installed and its index exists, both `[ Use Indexer ]` and `[ Rebuild Index ]` buttons are provided.
4. **Build Execution & Feedback**:
   - Triggering build sends `POST /api/projects/:project/code-search/setup` with `build: true`.
   - Modal shows active progress spinner and disables dismissal while building.
   - If build fails or times out, error and stderr output are shown in modal; config file is untouched.
   - If build succeeds, `sdlc.config.json` updates `agent.codeSearch`, modal dismisses, and doctor check updates to green (✔).
5. **Auto & None Configuration**:
   - Selecting `Auto` or `None` displays `[ Save Setting ]`.
   - Clicking updates `sdlc.config.json` without running build commands.
6. **Documentation**:
   - `docs/web-ui.md` updated to document the code indexer setup action button, modal, and configuration workflow.
7. **Typecheck & Tests**:
   - Backend endpoints covered by tests in `web/test/`.
   - UI typecheck (`npm run typecheck`) and web build (`npm run build:web`) pass without errors.

## 7. Dependencies

No new npm packages or external libraries are required. Reuses existing Node APIs (`child_process`, `fs`, `path`), existing UI components (`Modal`, `Cli`, `ErrorBox`), and existing `codeSearch` utilities in `src/config/codeSearch.ts`.
