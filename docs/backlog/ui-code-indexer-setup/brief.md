# ui-code-indexer-setup

Type: feature
Priority: P2 (normal)
Source: Feature request: Interactive UI button to configure and build graft/graphify code indexers from Doctor and Settings.

## Problem
The Doctor check (`src/registry/doctor.ts`, `web/ui/src/Projects.tsx`) and Settings page (`web/ui/src/Settings.tsx`) currently only show text warnings and recommendations pointing users to run CLI commands (such as `ai-sdlc-helper code-search --use ...` or `ai-sdlc-helper code-search <dir> --list`).

Specifically:
1. When an indexer is not configured or unindexed, the Doctor check displays an advisory warning (`code search uses Grep and Glob`) with a text hint (`see the indexers with: ai-sdlc-helper code-search <dir> --list`).
2. The Settings page is currently read-only and displays raw configuration plus CLI helpers (`Cli args={['show']}`) without interactive configuration.
3. Users have no interactive UI button in the web dashboard to inspect whether `graft` or `graphify` binaries are installed on PATH, select one, or trigger the initial build/setup.

## Expected behaviour
1. **Detection & Status Inspection**:
   - The Doctor check and Settings detect whether `graft` and/or `graphify` binaries are installed on PATH (using `which` / `onPath`), whether their index directory/file exists in the project root, and the currently configured `agent.codeSearch` in `sdlc.config.json`.
2. **Interactive Setup Button**:
   - When a code indexer is missing or unindexed, a `[ Setup Code Indexer ]` action button is displayed in the Doctor card (`web/ui/src/Projects.tsx`) and in the Settings view (`web/ui/src/Settings.tsx`).
3. **Selection Modal**:
   - Clicking `[ Setup Code Indexer ]` presents a selection modal listing supported indexers (`graft`, `graphify`):
     - Displays their installation status (installed vs. not installed on PATH).
     - Displays their current index state (indexed vs. unindexed in the project).
     - Displays setup/install instructions if the binary is missing on PATH (e.g. `npm install -g @nanonets/graft` or `uv tool install graphifyy`).
4. **Trigger Build & Configure**:
   - Selecting an indexer allows the user to click `[ Build Index ]` (or `[ Configure & Build ]`).
   - Clicking triggers the build command (e.g. `graft build` or graphify build command), updates `agent.codeSearch` in `sdlc.config.json`, and re-checks the doctor status to turn it green (✔).

## Decisions
- **Reuse existing indexer definitions**: Leverage `CODE_INDEXERS` and `codeIndexers(...)` from `src/config/codeSearch.ts` which already specify the binary commands, build commands, and index file/directory paths.
- **Backend API**: Provide API endpoints in `web/server/` (e.g. `GET /api/projects/:project/code-search` and `POST /api/projects/:project/code-search/setup`) to check availability and execute index building.
- **Doctor card enhancement**: In `web/ui/src/Projects.tsx`, allow check items (specifically `code indexer`) to surface action buttons directly in the check row or footer when failing or advising action.
- **Settings page enhancement**: In `web/ui/src/Settings.tsx`, provide an action button/panel for code search setup so users can configure or switch indexers without going to the Projects page.
- **Safe execution & feedback**: Run the build process asynchronously or with clear loading feedback in the modal so long-running index builds do not freeze the UI or fail silently.

## Scope
- **In**:
  - `src/config/codeSearch.ts`: Helpers for inspecting indexer availability and PATH status.
  - `web/server/`: API endpoints to inspect code search status and execute index setup/build.
  - `web/ui/src/Projects.tsx`: Doctor card `[ Setup Code Indexer ]` button and trigger.
  - `web/ui/src/Settings.tsx`: Settings page `[ Setup Code Indexer ]` button.
  - `web/ui/src/`: Code indexer selection and build modal component.
  - `web/ui/src/api.ts`: Frontend API methods for code search status and build actions.
- **Out of scope**:
  - Automatically running global package installs (`npm -g` or `pipx`) on the host machine without user intervention.
  - Full Phase 2 arbitrary settings editor for unrelated config keys.

## Tests
- Unit/integration tests in `web/test/` verifying code search status and build setup endpoints.
- Verification that updating `agent.codeSearch` in `sdlc.config.json` persists correctly and doctor status reports green.
- Web UI typecheck (`npm run typecheck`) and production build (`npm run build:web`).

## Docs
- Update `docs/web-ui.md` to document the code indexer setup action button, modal, and workflow in the web UI.

## Open questions
- none
