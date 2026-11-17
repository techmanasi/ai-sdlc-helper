# Plan: review loop limit as a UI setting

Spec: `docs/backlog/review-loop-limit-ui-setting/specs-1.md`. Manual input: `manual-inputs.md` (binding). No `decisions.md`, no open questions: the code settles everything below.

## Existing behaviour (already on the base branch: NOT part of this item, no steps, NO tests)
- Saving, merging, clearing and refusing `review.maxLoops` through the project settings `POST` route and `editSettings` (`src/config/edit.ts`): the `'integer'` rule in `SCHEMA.review.maxLoops` (`src/config/settings.ts:162`, `:200`), `null` clears the key, atomic write, stale-hash refusal, 400 with the messages, default 2 in `resolve` (`settings.ts:392`).
- `reviewLoop` (`src/pipeline/review-gate.ts:204-238`) using `ctx.config.review.maxLoops`, its "fix loop N of M" and "needs you" texts, and Review stopping on a missing/invalid `review.json`, unknown verdict, "changes" without findings, and the multi-model union. These already print the effective value, so they follow the override with no change.
- Passing run options as the start request's `env` (`web/server/index.ts` `contextFor` -> `runContext`, a throw -> HTTP 400 before `start`; `pipelineEnv` strips only `CONTROL_ENV`).

## New (the only thing steps and tests target)
1. The settings screen shows "Review loop limit" with current value and default 2, saves/clears it via the existing route.
2. Per-run override `SDLC_REVIEW_MAX_LOOPS`: whole number 0 or more wins over `sdlc.config.json` for that run only; anything else refuses the start with a message (400); empty = project value.
3. 0 = no fix loop (first Review with open findings fails the run as "needs you"; existing `reviewLoop` already does this once `maxLoops` is 0, new part is only that the override can set it).
4. The run page names the run's effective limit.

## Decisions made here
- Variable name `SDLC_REVIEW_MAX_LOOPS`, empty string = not set. Not added to `CONTROL_ENV` (the pipeline must receive it).
- One rule for a run-option value: digits-only text whose number is a safe integer, 0 or more. `-1`, `1.5`, `abc`, `1e1x`, `NaN`, blank ` `, and numbers above `Number.MAX_SAFE_INTEGER` are refused. Message: `must be a whole number, 0 or more`.
- A saved patch value stays a JSON number (the API does not coerce `"3"`); the UI form converts digit text to a number. Invalid text from the form is sent as typed so the server's refusal is the source of truth.
- Settings GET adds `fileReview` (the file's `review.maxLoops` when set) and `defaults.reviewMaxLoops` so the UI can tell "default" from "set".

## Steps (in order)

### 1. `src/config/settings.ts`: the run option and the shared rule
1. Export `DEFAULT_REVIEW_MAX_LOOPS = 2`, `LOOP_LIMIT_MESSAGE = 'must be a whole number, 0 or more'`, and `parseLoopLimit(v: unknown): number | null` (number or digits-only string that is a safe integer >= 0 gives the number; anything else, including `''`, gives `null`).
2. Make the existing save rule use the same message: new schema token `'loops'` for `SCHEMA.review.maxLoops` (JSON number, safe integer, >= 0, else `` `${at}: ${LOOP_LIMIT_MESSAGE}` ``); other `'integer'` keys unchanged. (Adjusts an existing refusal's wording to the spec; no separate test.)
3. `resolve`: `review.maxLoops` = non-empty valid `env.SDLC_REVIEW_MAX_LOOPS` (wins), else the file value if a whole number >= 0, else `DEFAULT_REVIEW_MAX_LOOPS`. A non-empty env value that does not parse pushes `` `SDLC_REVIEW_MAX_LOOPS ${LOOP_LIMIT_MESSAGE}, not '<value>'` `` onto `errors` (config null: a pipeline started directly with a bad value is refused, not defaulted). Update the comment at `:393` to name the variable.

### 2. `src/runs/index.ts`: refuse before any run starts
In `runContext`, next to the `SDLC_MAX_PARALLEL` check (`:73-74`), throw `` `SDLC_REVIEW_MAX_LOOPS ${LOOP_LIMIT_MESSAGE}, not '${v}'` `` when the value is non-empty and `parseLoopLimit` gives `null`. Update the doc comment above. The existing `contextFor` turns the throw into 400, so `start` is never reached.

### 3. `web/server/index.ts`: settings GET (`:254-271`)
Add `fileReview: { maxLoops }` (only when the file holds a whole number there, else `{}`) and `defaults: { reviewMaxLoops: DEFAULT_REVIEW_MAX_LOOPS }`. The POST branch is unchanged (existing).

### 4. `web/ui/src/api.ts`
Extend `SettingsView`: `config.review?: { maxLoops: number }`, `fileReview: { maxLoops?: number }`, `defaults: { reviewMaxLoops: number }`.

### 5. `web/ui/src/Projects.tsx` (`EditSetup`, project scope)
- State `loops` / `loopsError`; `fill` sets `loops` from `fileReview.maxLoops` (`''` when unset).
- Labelled input "Review loop limit" with placeholder `default 2`, a line showing the current value marked "(default)" when `fileReview.maxLoops` is undefined, a "Use default" button that empties the field, and `loopsError` rendered beside it.
- `save`: clear `loopsError`; empty -> `review: { maxLoops: null }` only when the file has a value; digits-only -> `Number(text)` only when it differs; otherwise send the raw text. On refusal put the message(s) naming `review.maxLoops` into `loopsError` (all still go to `errors`) and keep `loops` as typed.

### 6. `web/ui/src/Run.tsx` (`reviewConfig`, `:416`)
Add a row "Review loop limit": text input `aria-label="review loop limit"`, `value={envObj.SDLC_REVIEW_MAX_LOOPS || ''}`, `onChange` -> `setEnvVar('SDLC_REVIEW_MAX_LOOPS', value.trim())` (empty removes the variable), `disabled={running}`, placeholder = `catalog?.config?.review?.maxLoops ?? 2`. Change the closing "Review only reports..." line to name the project's current value. Confirm the `start` error path keeps `env` (typed text stays) and shows the 400 message; do not clear `env` there.

### 7. Docs (separate step, no test)
README settings table (`review.maxLoops` editable in the UI), the variable `SDLC_REVIEW_MAX_LOOPS` and precedence (run option > `sdlc.config.json` > 2) beside `SDLC_REVIEW_MODE`. Checked in Review.

### 8. `graft build` after the code changes.

## Tests (new behaviour only; each imports or runs real code and fails before Implement)
Targeted runs only: `ai-sdlc-helper run --file <file>`; the full suite runs in CI. No test for the existing behaviour listed above, and no additions to the existing review-gate stop cases.

1. `test/config/review-loop-limit.test.ts` (already written; `resolve`, `runContext`, `pipelineEnv`): run option `'5'`/`'0'` beats a file value of 1, `''` uses the file value, the value reaches `pipelineEnv`; `'-1'|'1.5'|'abc'|'1e1x'|'NaN'|' '|'9007199254740992'` give `errors`, null config, and `runContext` throws. Only its run-option cases are new; the save/clear cases in that file duplicate existing behaviour and are not extended.
2. `web/test/server.test.ts`:
   - GET settings: `fileReview` is `{}` with no file value, `fileReview.maxLoops === 3` with 3 in the file, `defaults.reviewMaxLoops === 2`.
   - POST start with `env: { SDLC_REVIEW_MAX_LOOPS: '5' }` against a file value of 1, via the fake pipeline command: the child sees 5 and `sdlc.config.json` is byte-identical; empty option sees the file value.
   - POST start with `-1`, `1.5`, `abc`: 400 with the message and no run started.
3. `test/review-gate.test.ts` (existing fake-agent helper): file `maxLoops: 3` with env `{ SDLC_REVIEW_MAX_LOOPS: '0' }`, Review with open findings fails as "needs you" with no fix loop; env `'1'` with file 0 runs exactly one fix loop. (Only the env-driven cases; the existing stop cases stay untouched.)
4. UI (criterion 8): `web/ui` has no component test setup; covered by the server tests above plus manual verification in Review (board screenshot for the UI PR). No assertions on prose.

## Files touched
`src/config/settings.ts`, `src/runs/index.ts`, `web/server/index.ts`, `web/ui/src/api.ts`, `web/ui/src/Projects.tsx`, `web/ui/src/Run.tsx`, README/docs, and the test files above.

## Dependencies
- none
