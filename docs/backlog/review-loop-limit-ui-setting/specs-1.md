# Specification: review loop limit as a UI setting

Brief: `docs/backlog/review-loop-limit-ui-setting/brief.md`. No `decisions.md` exists for this item.

## Background (facts already in the code)
- `review.maxLoops` already exists (`src/config/settings.ts`): a whole number, default 2, read from `sdlc.config.json`. `reviewLoop` (`src/pipeline/review-gate.ts`) sends the run back through Red tests and Implement at most that many times; when findings are still open after the last loop, the run stops as failed with "needs you".
- A value in the file that is not a whole number is today silently replaced by 2 when settings are loaded.
- The project settings are read and saved through the server's `settings` GET and POST routes; a save is validated against the settings schema before anything is written, and a stale save (the file changed since it was opened) is refused.
- Other Review choices (`SDLC_REVIEW_MODE`, `SDLC_REVIEW_REVIEWERS`) are already per-run options that win over the file. The Run page's "Review" run-options section holds them.
- No new package is needed.

## Behaviour

### 1. Project setting
- The project settings screen shows "Review loop limit" (`review.maxLoops`) with its **current value** and its **default (2)**.
- The current value is the value in `sdlc.config.json`, or 2 when the file does not set it. The screen tells the two cases apart (for example "default" next to an unset value).
- Saving a valid value writes `review.maxLoops` into `sdlc.config.json`, keeping the rest of the file (other keys, indentation) as the existing settings save does. The write is atomic and follows the existing stale-file check.
- The new value applies to runs started after the save. Runs already running or paused keep the value they started with (same rule as other project settings).
- The saved value is shown again after a reload.
- Clearing the field (or an explicit "use default") removes `review.maxLoops` from the file so the default of 2 applies. The brief does not ask for a different "reset" behaviour.

### 2. Per-run override
- The Run options (the Review section of the Run page) offer a "Review loop limit" field for one run. Left empty, the run uses the project value.
- Starting a run with a value makes that run's `review.maxLoops` equal to it, winning over `sdlc.config.json`, in the same way as `SDLC_REVIEW_MODE` and `SDLC_REVIEW_REVIEWERS`. The override is not written to `sdlc.config.json`.
- The override travels with the run's start request (the run options environment). Its variable name is chosen by Plan; it follows the existing `SDLC_REVIEW_*` naming.
- The Run options text shows the project's current value, so the user can see what an empty field means.
- The run page's existing statements about the loop (for example "fix loop 1 of N", and the "needs you" failure naming N) use the effective value of that run.

### 3. Valid values
- A valid value is a whole number, 0 or greater. There is no upper bound in the brief, so none is enforced.
- 0 is valid: Review never sends the run back; the first Review with open findings fails the run as "needs you".
- A value written as text with digits only (for example `"3"`) is accepted in a run option or form field and stored/used as the number 3. In `sdlc.config.json` the stored value is a JSON number.

## Inputs and outputs
- Project settings save: the existing `POST` settings route, with a patch containing `review.maxLoops` (number) and the file hash. Output: success with the new hash, or a failure with a list of messages.
- Project settings read: the existing `GET` settings route returns the effective value and what the file holds, so the UI can show current value and default.
- Run start with options: the existing start route with the new run option in its environment. Output: the run starts and uses that value, or the start is refused with a message.

## Error cases
- Value below 0 (for example `-1`): refused with a message that says the limit must be a whole number, 0 or more. The file is not changed.
- Value not a whole number (for example `1.5`, `abc`, `1e1x`, `NaN`, a blank string that is not an intended "clear"): refused with the same message. The file is not changed.
- Run option with an invalid value: the start is refused with the same message and **no run is started**; the run does not fall back to the project value or to 2.
- A saved patch with several invalid fields reports every message (the existing behaviour), including this one; nothing is written.
- Stale file hash, unreadable or invalid JSON in `sdlc.config.json`: the existing refusals apply unchanged.
- The refusal is shown next to the field in the UI, and the invalid text stays in the field so the user can correct it (no silent reset to a previous or default value).
- The server (not only the form) validates: the same refusal happens when the API is called directly.

## Out of scope
- Changing how the loop works, or the default of 2.
- A personal (per-user) override of the limit; the project setting is in `sdlc.config.json` only.
- Changing the settings load so that an invalid value already in the file is reported (it keeps today's fallback to 2), except that the save path must not write one.

## Acceptance criteria
1. The project settings response and screen show `review.maxLoops` with its current value and the default 2; with no value in the file the current value shown is 2, marked as the default.
2. Saving `3` writes `"review": { "maxLoops": 3 }` (merged with any other `review` keys) into `sdlc.config.json`; loading the settings afterwards returns 3 and the screen shows 3. Saving 0 is accepted and stored as 0.
3. Clearing the setting removes `review.maxLoops` from the file and the effective value becomes 2.
4. Saving `-1`, `1.5`, `abc` is refused with a message, `sdlc.config.json` is byte-for-byte unchanged, and the response carries the message (tested through the server API).
5. Starting a run through the server API with the run option set to `5` produces a run whose effective `review.maxLoops` is 5, while `sdlc.config.json` says another value and stays unchanged; with the option empty the run uses the file value (tested through the server API).
6. Starting a run with the option set to `-1`, `1.5` or `abc` is refused with a message and no run is started (tested through the server API).
7. A run with the override `0` that gets a Review with open findings stops as failed "needs you" without a fix loop (tested with a fake agent).
8. The Run page's Review run options show the field with the project's value; the project settings screen shows the field with an error message beside it on a refused save (UI behaviour verified by the UI's own tests where they exist; no assertions on prose).
9. Tests exercise real code (the settings edit function, the server routes, the settings loader); none assert on Markdown or comments.
