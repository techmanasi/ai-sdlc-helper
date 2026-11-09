# Decisions for ui-code-indexer-setup

## Round 1 (2026-11-09)

### Q1: What command line should be executed when building graphify?
In `src/config/codeSearch.ts`:
- `graft` defines `build: 'graft build'`.
- `graphify` defines `build: 'build the graph with /graphify . in Claude Code'`, which is a natural-language instruction for an interactive slash command in Claude Code, not an executable shell command.
The brief states:
- "Clicking triggers the build command (e.g. `graft build` or graphify build command)"
- "Leverage `CODE_INDEXERS` and `codeIndexers(...)` from `src/config/codeSearch.ts` which already specify the binary commands, build commands, and index file/directory paths."
Attempting to execute `build the graph with /graphify . in Claude Code` as a shell command will fail with `build: command not found`.
What exact command should be executed when building graphify from the web UI? Should `graphify .` (or `graphify`) be executed if the `graphify` binary is installed on PATH, or should automated execution be disabled for graphify if it requires interactive Claude Code execution, displaying the slash command instruction instead?
**Suggested:** If `graphify` binary can build via CLI, execute `graphify .` (and update `CODE_INDEXERS.graphify.build` to `'graphify .'`). If graphify cannot be run headlessly from CLI without Claude Code, disable the `[ Build Index ]` button for graphify and display the instructional slash command `/graphify .` for Claude Code.
**Answer:** accept

### Q2: What actions should be offered when an indexer is already indexed?
If an indexer is installed and its index already exists in the project root (e.g., `graft/` directory exists), but `agent.codeSearch` is not configured (or is set to `auto` or `none`), rebuilding the index can be slow and unnecessary.
Should the modal offer a way to simply select/configure the indexer without rebuilding, or does clicking build always trigger the index build command?
**Suggested:** When the selected indexer is installed and its index already exists, the modal provides two buttons: `[ Use Indexer ]` (which immediately updates `agent.codeSearch` in `sdlc.config.json` without running the build command) and `[ Rebuild Index ]` (which runs the build command and updates `agent.codeSearch`).
**Answer:** accept

### Q3: How should the UI handle an indexer whose binary is not installed on PATH?
The brief states that the modal displays setup/install instructions if the binary is missing on PATH (e.g. `npm install -g @nanonets/graft` or `uv tool install graphifyy`), and notes that running global package installs is out of scope.
When a selected indexer's binary is not installed on PATH, what should happen to the `[ Build Index ]` button?
**Suggested:** The `[ Build Index ]` button is disabled when the indexer binary is not found on PATH. The modal displays the installation command from `ix.setup` in a copyable CLI box (`Cli args=...`), with a hint to run the install command in the terminal and a `[ Refresh ]` button to re-check PATH.
**Answer:** accept

### Q4: Should the build execution API run synchronously with a timeout or asynchronously?
The brief states: "Safe execution & feedback: Run the build process asynchronously or with clear loading feedback in the modal so long-running index builds do not freeze the UI or fail silently."
Should `POST /api/projects/:project/code-search/setup` execute the build command synchronously in the backend process up to a timeout (e.g. 120 seconds, matching the existing `web/server/index.ts` `runCommand` pattern) and return the outcome `{ ok: boolean, code: number | null, stdout: string, stderr: string, timedOut: boolean }` while the UI shows a modal loading spinner, or does it require an asynchronous background task with polling or streaming SSE events?
**Suggested:** Run synchronously on the server with a 120-second timeout (reusing the `runCommand` pattern in `web/server/index.ts`). The frontend modal displays an active spinner and disables close/action buttons while the build is running, then displays stderr output if it fails or times out.
**Answer:** accept

### Q5: Is the Setup/Configure Code Indexer button in Settings always visible, or only when unindexed?
The brief has two statements:
- Expected behaviour: "When a code indexer is missing or unindexed, a `[ Setup Code Indexer ]` action button is displayed in the Doctor card (`web/ui/src/Projects.tsx`) and in the Settings view (`web/ui/src/Settings.tsx`)."
- Decisions: "In `web/ui/src/Settings.tsx`, provide an action button/panel for code search setup so users can configure or switch indexers without going to the Projects page."
When a project already has a working, indexed code search configured (doctor check passes green), should the Settings page still provide a button to open the modal and switch indexers or rebuild?
**Suggested:** In Settings, always provide a Code Search panel/section that displays current status. When an indexer is missing or unindexed, the button is styled as an action `[ Setup Code Indexer ]`. When an indexer is already working and indexed, the button is `[ Configure Code Indexer ]`, allowing switching to another indexer or rebuilding. In Doctor (`Projects.tsx`), the action button is only shown when the `code indexer` check fails or gives an advisory warning (`!c.ok`).
**Answer:** accept

### Q6: Should the modal allow selecting "auto" or "none" (Grep and Glob)?
`src/config/codeSearch.ts` and `ai-sdlc-helper code-search --use` support setting `agent.codeSearch` to `"auto"` (pick the first available installed indexer) or `"none"` (fall back to Grep and Glob without warnings).
Should the modal allow selecting "auto" or "none" in addition to explicit indexers (`graft`, `graphify`), or only concrete indexers?
**Suggested:** Include options for "Auto (first available)" and "None (Grep and Glob)" in the modal's list or dropdown, allowing users to configure these settings directly from the UI without needing the CLI. For "Auto" and "None", the button displays `[ Save Setting ]` without triggering a build command.
**Answer:** accept
