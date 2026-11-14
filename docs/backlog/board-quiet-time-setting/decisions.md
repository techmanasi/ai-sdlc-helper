# Decisions for board-quiet-time-setting

## Round 1 (2026-11-14)

### Q1: Storage location, scope, and configuration key name
The brief says to "Keep it with the other settings the Config modal edits", but the Config modal edits two distinct locations with separate validation schemas:
1. Global repository settings in `sdlc.config.json` (committed and shared across the team, validated against `SCHEMA` in `src/config/settings.ts`).
2. Personal overrides in `~/.config/ai-sdlc-helper/projects.json` under `overrides` (local to this machine, validated by `overrideErrors` in `src/config/edit.ts`), where machine-specific settings like `worktreeBase` and `maxParallel` live.
Both schemas strictly reject unknown keys. Should the board quiet time be stored:
- (a) As a personal override in `projects.json` under `overrides` (e.g. `overrides.boardSilenceSeconds`),
- (b) In `sdlc.config.json` (e.g. under `ui.boardSilenceSeconds`), or
- (c) Both (project default in `sdlc.config.json` with a personal override in `projects.json`)?
**Suggested:** Store it as a personal override in `projects.json` under `overrides.boardSilenceSeconds` (defaulting to 30 seconds when unset). Board watching and refresh frequencies are local workstation behaviour rather than shared repository code configuration.
**Answer:** accept

### Q2: Stored unit, precision, and validation rule
The brief specifies "30 s as the default and 1 s as the minimum" and "A value below 1 s or not a number is refused, with a message on the page." The environment variable `SDLC_BOARD_SILENCE_MS` and internal `BOARD_WATCH_TIMINGS.silenceMs` use milliseconds (`ms >= 1000`).
Should the stored setting be an integer representing whole seconds (e.g., `30`, minimum `1`), or milliseconds (e.g., `30000`, minimum `1000`)? And does the validation reject fractional seconds (e.g., `1.5`)?
**Suggested:** Store the setting as an integer representing whole seconds (`boardSilenceSeconds`), with a minimum of 1. The UI input should use `type="number" min="1" step="1"`. Values less than 1, non-integers, and non-numeric inputs should be refused with an error message on the page (e.g. "Board quiet time must be a whole number of seconds, at least 1").
**Answer:** accept

### Q3: UI behaviour and messaging when `SDLC_BOARD_SILENCE_MS` is set
The brief states:
- "The environment variable still wins when set, and the UI says so."
- "With `SDLC_BOARD_SILENCE_MS` set, the UI shows that value and that it comes from the environment."
When `SDLC_BOARD_SILENCE_MS` is present in the server's environment:
Should the quiet time input field in the Config modal be disabled (read-only) displaying the active environment value (converted to seconds), or remain editable with an inline notice indicating that the environment variable currently takes precedence?
**Suggested:** When `SDLC_BOARD_SILENCE_MS` is set, display the input populated with the active environment value in seconds, mark the input as disabled (read-only), and display helper text underneath: `Set by SDLC_BOARD_SILENCE_MS in server environment (overrides config)`.
**Answer:** accept

### Q4: Placement in the Config modal layout
In `web/ui/src/Projects.tsx`, the Config modal (`EditSetup`) currently contains:
1. Agent / model / effort settings with a scope toggle ("Global settings" vs "Only for me").
2. Preliminary / Diagnostic Tests (visible under Global settings).
3. Machine-specific overrides for registered projects: "Worktree folder (personal, this machine only)" and "Runs in parallel (personal)".
Where in the Config modal should the board quiet time field be placed?
**Suggested:** Place it in the personal overrides section alongside "Worktree folder" and "Runs in parallel", labeled `Board quiet time in seconds (personal)`, with placeholder `30`.
**Answer:** accept
