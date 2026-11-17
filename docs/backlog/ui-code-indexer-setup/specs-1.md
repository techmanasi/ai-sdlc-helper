# Specification: ui-code-indexer-setup

Type: feature · Priority: P2 (normal)
Sources: `brief.md`, `decisions.md` (Round 1, binding).

## 1. Summary

The Doctor check (`src/registry/doctor.ts`, `web/ui/src/Projects.tsx`) and Settings page (`web/ui/src/Settings.tsx`) currently only display text warnings and CLI recommendations (e.g. `ai-sdlc-helper code-search <dir> --list`) when code indexers are unconfigured, missing, or unindexed.

This feature adds:
1. An inspection endpoint (`GET /api/projects/:project/code-search`) and an interactive setup modal in the web UI.
2. A `[ Setup Code Indexer ]` action button surfaced in the Doctor check card when the `code indexer` check advises action (`!c.ok`).
3. A `[ Setup Code Indexer ]` action button in the Settings page, allowing users to configure or switch indexers even when the current selection is healthy or explicitly set to `none`.
4. A selection and build modal presenting supported indexers (`graft` and `graphify`), their installation status on PATH, current index presence, setup/install instructions, and an action to trigger index building and configuration.
5. A setup endpoint (`POST /api/projects/:project/code-search/setup`) executing the build command server-side asynchronously, verifying index generation, persisting `agent.codeSearch` in `sdlc.config.json`, and providing progress, timeout, and error reporting.

Out of scope:
- Automatically installing global host packages (`npm -g`, `uv tool install`, `pipx`).
- Live command log streaming, manual cancellation, or persistence/recovery of active build operations across server restarts (Decision Q5).
- Destructive index removal/cleaning or configure-only without build actions (Decision Q3).
- Arbitrary custom indexers beyond `graft` and `graphify` in the setup selection (Decision Q2).

---

## 2. Definitions

- **Supported Indexers**: Strictly `graft` and `graphify` (Decision Q2). Their effective configuration (command, index path, build command, setup instructions) is resolved from `codeIndexers(...)` in `src/config/codeSearch.ts`, which merges built-in definitions with any project-level `agent.codeIndexers` overrides.
- **Binary Availability**: An indexer's binary is available when its defined executable `command` is present on the host system PATH (tested via `onPath` / `which`).
- **Index State**:
  - `indexed`: The index target path (file or directory, e.g. `graft` or `graphify-out/graph.json`) exists in the project root.
  - `unindexed`: The index target path does not exist in the project root.
- **Doctor Code Indexer Status**: Evaluated by `codeSearchFor(root, file, env)`.
  - Healthy (`ok: true`): Either an indexer is available and indexed, or `agent.codeSearch` is explicitly set to `"none"` (`search.warning === null`).
  - Advising Action (`ok: false`): `search.warning` is non-null (e.g. no indexer is available, index is missing, or the configured indexer is uninstalled/unindexed).
- **Build Operation**: An in-memory asynchronous child process execution per project running the selected indexer's build command with a maximum execution limit of 10 minutes (600,000 ms).

---

## 3. Behaviour

### 3.1 Doctor Check & Action Trigger (`web/ui/src/Projects.tsx`)

1. In the Project Doctor card, each check item is rendered with its status and details.
2. For the check row where `c.name === 'code indexer'`:
   - If `c.ok` is `false` (the check advises action), render a `[ Setup Code Indexer ]` button within the check row or its detail area (Decision Q4).
   - If `c.ok` is `true` (including when `agent.codeSearch` is explicitly `"none"` or when an indexer is healthy), do not render the setup button in the Doctor card (Decision Q4).
3. Clicking `[ Setup Code Indexer ]` opens the Code Indexer Selection Modal for that project.
4. When the modal completes setup successfully, the Doctor checks for that project automatically re-run (or refresh), transitioning the `code indexer` check to green (`✔`).

### 3.2 Settings Page Action Trigger (`web/ui/src/Settings.tsx`)

1. On the Settings page, always expose a `[ Setup Code Indexer ]` action button in the header or in a dedicated Code Search panel (Decision Q4).
2. The button is active regardless of whether `agent.codeSearch` is unconfigured, set to `"none"`, or set to a working indexer.
3. Clicking the button opens the Code Indexer Selection Modal for the active project.
4. When the modal completes setup successfully, Settings data is reloaded to reflect the updated `agent.codeSearch` configuration.

### 3.3 Code Indexer Selection Modal

The modal manages inspecting available indexers, selecting one, and triggering index building:

1. **Loading State**: On open, fetches current status from `GET /api/projects/:project/code-search`. Shows a loading indicator while fetching.
2. **Current Status Header**: Displays the currently configured `agent.codeSearch` (e.g. `auto`, `none`, `graft`, `graphify`, or a custom name) and the active search engine in use. If an active build is already in progress for this project, the modal immediately displays the in-progress view (see step 6).
3. **Indexer List**: Presents the two supported indexers (`graft` and `graphify`):
   - **Name & Purpose**: Indexer name and brief description.
   - **Binary Status**:
     - Installed (`✔ Installed on PATH`).
     - Not Installed (`✘ Command '<command>' not found on PATH`).
   - **Index Status**:
     - `Indexed` (target path exists in project).
     - `Not indexed` (target path missing).
   - **Setup Instructions**: When binary is missing or build command is absent, display actionable installation guidance (e.g. `npm install -g @nanonets/graft` or `uv tool install graphifyy`).
4. **Selection & Action Controls**:
   - Radio selection or card picker between `graft` and `graphify`.
   - **Configure & Build Button**:
     - Disabled if the selected indexer's binary is not on PATH, or if its build command is missing/empty.
     - Enabled if binary is installed and build command is defined.
     - Label: `Configure & Build` (or `Build Index`).
   - **Cancel / Close Button**: Dismisses the modal.
5. **Execution Trigger**:
   - Clicking `Configure & Build` sends `POST /api/projects/:project/code-search/setup` with `{ indexer: "<selected>" }`.
6. **In-Progress View**:
   - Displays a spinner / progress indicator indicating that the index build is running (e.g. `"Building <indexer> index…"`).
   - Modal allows dismissing/closing; closing or navigating away does not abort or kill the background process (Decision Q5).
   - Reopening the modal for the project queries status and restores the in-progress view while the build continues (Decision Q5).
7. **Completion & Result View**:
   - **On Success**:
     - Displays confirmation (e.g. `✔ <indexer> index built and configured successfully`).
     - Offers a `Done` / `Close` button.
     - Automatically refreshes Doctor / Settings views upon closing.
   - **On Failure**:
     - Displays an actionable failure banner with bounded command output (tail of stdout/stderr) (Decision Q5).
     - If the build succeeded but updating `sdlc.config.json` failed, displays an explicit warning: `Index was built successfully, but saving configuration to sdlc.config.json failed` (Decision Q1).
     - Leaves a `Retry` button and a `Close` button enabled (Decision Q5).

### 3.4 Server Execution, Concurrency, and Timeout (`web/server/`)

1. **Pre-execution Validation**:
   - Before launching a build, the server validates `sdlc.config.json` in the project root:
     - If `sdlc.config.json` exists but contains malformed JSON, reject the setup request immediately without executing commands (Decision Q1).
     - If `sdlc.config.json` is missing, allow creation upon completion (Decision Q1).
   - Validates that the requested indexer is strictly `'graft'` or `'graphify'` (Decision Q2).
   - Validates that the indexer command is installed on PATH and a non-empty `build` command string is defined (Decision Q2).
2. **Concurrency Guard**:
   - Only one code search build operation can run per project at any given time.
   - If a build request arrives while another build is in progress for the same project, reject with HTTP 409 Conflict: `a code indexer build is already in progress for this project` (Decision Q5).
3. **Execution**:
   - Executes the build command via child process `spawn` with the project root as `cwd` and inherited server environment (Decision Q2).
   - Runs asynchronously without blocking the Node.js event loop or other dashboard operations (Decision Q5).
   - Captures output into a bounded rolling buffer (e.g. last 100 lines or 32 KB of combined stdout/stderr) for failure reporting (Decision Q5).
4. **Timeout**:
   - Enforces a 10-minute (600,000 ms) execution timeout.
   - If the process exceeds 10 minutes, terminates the process (SIGTERM, then SIGKILL if needed) and sets the state to `timeout` with error `Build timed out after 10 minutes` (Decision Q5).
5. **State Tracking**:
   - Maintains operation state per project in memory: `idle` | `running` | `succeeded` | `failed` | `timeout`.
   - Tracks: `indexer`, `startedAt`, `endedAt`, `exitCode`, `error`, `outputTail`.

### 3.5 Post-Build Verification & Configuration Persistence

1. **Verification**:
   - When the build process exits with code 0, server invokes `unavailable(indexer, projectRoot, env)` from `src/config/codeSearch.ts` to verify that the index file/directory now exists and is accessible.
   - If `unavailable(...)` returns an error string (e.g. target index path still does not exist), the operation fails verification:
     - Mark operation as failed with reason `Build exited successfully, but index files were not found`.
     - Do not update `sdlc.config.json`.
     - Leave any created files in place (Decision Q1).
2. **Persistence**:
   - Only after both the build process exits with 0 and index availability verification succeeds, update `sdlc.config.json`:
     - If `sdlc.config.json` exists, parse existing JSON, set `agent.codeSearch = indexer`, and write back formatted with 2-space indentation and trailing newline, preserving all unrelated keys (Decision Q1).
     - If `sdlc.config.json` does not exist, create it with `{ "agent": { "codeSearch": indexer } }`.
   - If writing the configuration fails (e.g. file system permission error):
     - Keep generated index files in place (Decision Q1).
     - Return/report failure stating that index was built but configuration was not saved (Decision Q1).
3. **Success State**:
   - Operation is marked `succeeded` only when both build verification and persistence complete successfully (Decision Q1).

---

## 4. API Endpoints

### 4.1 GET `/api/projects/:project/code-search`

Inspects code search configuration, indexer availability, and active build status.

**Parameters**:
- Path: `project` (string, required): project name in registry.

**Response (200 OK)**:
```json
{
  "configured": "auto",
  "active": {
    "codeSearch": "none",
    "indexer": null,
    "warning": "no code indexer is available; code search uses Grep and Glob..."
  },
  "indexers": [
    {
      "name": "graft",
      "command": "graft",
      "installed": true,
      "index": "graft",
      "indexed": false,
      "build": "graft build",
      "setup": "npm install -g @nanonets/graft, then graft build"
    },
    {
      "name": "graphify",
      "command": "graphify",
      "installed": false,
      "index": "graphify-out/graph.json",
      "indexed": false,
      "build": "build the graph with /graphify . in Claude Code",
      "setup": "uv tool install graphifyy (or pipx install graphifyy)..."
    }
  ],
  "operation": {
    "status": "idle",
    "indexer": null,
    "startedAt": null,
    "endedAt": null,
    "error": null,
    "output": []
  }
}
```

When an operation is running:
- `operation.status`: `"running"`
- `operation.indexer`: `"graft"`
- `operation.startedAt`: ISO timestamp

### 4.2 POST `/api/projects/:project/code-search/setup`

Initiates index build and configuration for a selected indexer.

**Parameters**:
- Path: `project` (string, required): project name.
- Body (JSON):
  - `indexer` (string, required): strictly `"graft"` or `"graphify"`.

**Responses**:
- `202 Accepted` (or `200 OK`):
  ```json
  {
    "ok": true,
    "status": "running",
    "indexer": "graft",
    "message": "Index build started"
  }
  ```
- `400 Bad Request`:
  - When `indexer` is missing or not `"graft"` or `"graphify"`.
  - When existing `sdlc.config.json` contains malformed JSON.
  - When indexer binary is not found on PATH or build command is missing (response includes `setup` instructions).
- `404 Not Found`:
  - Project does not exist in registry.
- `409 Conflict`:
  - Another build is already running for the project.

---

## 5. Inputs, Outputs, and Validation

| Input | Location | Validation Rule | Error Outcome |
|---|---|---|---|
| `project` | Path param | Must match a registered project name (or active cwd project) | 404 `no project named '<name>'` |
| `indexer` | POST Body | Must be a string equal to `"graft"` or `"graphify"` | 400 `indexer must be 'graft' or 'graphify'` |
| `sdlc.config.json` | Project file | If file exists, must be valid JSON | 400 `sdlc.config.json is not valid JSON; fix it first` |
| Binary on PATH | Host env | `onPath(indexer.command, env)` must be true | 400 `<name> is not installed (no <command> command)` with setup info |
| Build command | Indexer def | `indexer.build` must be a non-empty string | 400 `<name> has no build command defined` |
| Concurrency | Server state | No active operation running for project | 409 `a code indexer build is already in progress for this project` |

---

## 6. Error Cases & Edge Cases

1. **Unknown Project**:
   - Request to `/api/projects/unknown/code-search` returns 404.
2. **Unsupported / Custom Indexer Name**:
   - Client sends `POST` with `indexer: "custom"`. Server rejects with 400. Custom indexers in `sdlc.config.json` can be reported as `configured` in GET, but cannot be targeted for setup (Decision Q2).
3. **Malformed `sdlc.config.json`**:
   - User has syntax error in config. POST returns 400 without running any build command; file remains untouched (Decision Q1).
4. **Missing Binary on PATH**:
   - User requests setup for `graphify` when `graphify` is not installed. Setup rejects with 400 and returns install instructions (`uv tool install graphifyy`). In the UI, the button is disabled with setup instructions displayed (Decision Q2).
5. **Overlapping Requests**:
   - While a build is running, another POST request for the same project returns 409 Conflict (Decision Q5).
6. **Build Command Exits Non-Zero**:
   - Process fails (e.g. compiler error, missing dependencies).
   - Server preserves prior `sdlc.config.json` without modifying `agent.codeSearch`.
   - Leaves generated intermediate files on disk (Decision Q1).
   - Operation status set to `failed` with exit code and bounded stderr/stdout output.
   - UI displays failure message and tail output, and allows retry.
7. **Build Exits Zero but Index Missing**:
   - Process succeeds with exit code 0, but target index path does not exist.
   - Availability verification fails.
   - Config is not modified. Operation marked `failed`.
8. **Config Save Failure**:
   - Build and verification succeed, but writing to `sdlc.config.json` fails (e.g. read-only filesystem).
   - Operation reports that index was built but config could not be saved (Decision Q1).
9. **Build Exceeds 10 Minutes**:
   - Process is killed by server.
   - Operation status set to `timeout`. Error message: `Build timed out after 10 minutes`.
10. **Reopening Modal During / After Build**:
    - User closes modal while build is in progress and reopens it. Modal queries GET endpoint, sees `status: "running"`, and displays the active spinner without restarting the build (Decision Q5).
    - If the build completed while the modal was closed, reopening displays the completed outcome (success or error).
11. **Configured `agent.codeSearch: "none"`**:
    - Doctor check is green (`✔`), no action button appears in Doctor (Decision Q4).
    - Settings page still displays `[ Setup Code Indexer ]`, allowing user to select and configure an indexer (Decision Q4).
12. **Already Indexed Target**:
    - User selects an indexer that already has an index. Clicking Configure & Build still runs the build command to ensure freshness, then persists configuration (Decision Q3).

---

## 7. Acceptance Criteria

### Scenario 1: Doctor card surfaces Setup button when indexer advises action
- **Given** a registered project where `graft` is not indexed and `agent.codeSearch` is unconfigured (`auto`), so the Doctor `code indexer` check advises action (`!c.ok`),
- **When** the user views the Project Doctor card in `web/ui/src/Projects.tsx`,
- **Then** a `[ Setup Code Indexer ]` action button is visible in the `code indexer` row.

### Scenario 2: Doctor card suppresses Setup button when explicitly set to "none" or healthy
- **Given** a project where `sdlc.config.json` sets `agent.codeSearch` to `"none"`,
- **When** the Doctor check runs,
- **Then** the `code indexer` check reports green (`✔`), and no `[ Setup Code Indexer ]` button is rendered in the Doctor check row.

### Scenario 3: Settings page always provides Setup Code Indexer action
- **Given** any project (whether code search is healthy, `"none"`, or unindexed),
- **When** the user navigates to the Settings page (`web/ui/src/Settings.tsx`),
- **Then** a `[ Setup Code Indexer ]` action button is available.

### Scenario 4: Modal inspection reflects system status
- **Given** `graft` is installed on PATH but unindexed, and `graphify` is not installed on PATH,
- **When** the user opens the Code Indexer Setup modal,
- **Then** `graft` shows installed (`✔`) and unindexed, with `Configure & Build` enabled,
- **And** `graphify` shows not installed (`✘`) with setup instructions displayed and selection/build disabled.

### Scenario 5: Successful build updates configuration and turns Doctor check green
- **Given** `graft` is installed and unindexed,
- **When** the user selects `graft` and clicks `Configure & Build`,
- **Then** `POST /api/projects/:project/code-search/setup` starts `graft build`,
- **And** the modal displays an in-progress indicator,
- **And** upon process exit 0 and index verification, `agent.codeSearch = "graft"` is written to `sdlc.config.json`,
- **And** the modal reports success,
- **And** closing the modal refreshes Doctor checks, turning `code indexer` green (`✔`).

### Scenario 6: Rejection of malformed configuration
- **Given** `sdlc.config.json` contains syntax errors,
- **When** a setup request is posted,
- **Then** the server responds with 400 Bad Request without executing the build command or corrupting the configuration file.

### Scenario 7: Concurrency rejection
- **Given** a build is currently running for project `my-app`,
- **When** another setup request is sent for `my-app`,
- **Then** the server responds with 409 Conflict.

### Scenario 8: Build failure leaves previous configuration intact
- **Given** `agent.codeSearch` was previously `"none"`, and a build command fails with exit code 1,
- **Then** the operation state reports failure with command error tail output,
- **And** `agent.codeSearch` in `sdlc.config.json` remains `"none"`.

### Scenario 9: 10-minute timeout termination
- **Given** an indexer build process hangs or runs longer than 10 minutes,
- **When** 10 minutes elapse,
- **Then** the child process is terminated,
- **And** the operation reports a timeout failure.
