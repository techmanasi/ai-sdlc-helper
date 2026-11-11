# Plan: add OpenCode as a pipeline harness

Status: draft — produced by a deepen run (harness-integrator lens), pending independent review.

## Goal

Add OpenCode as a first-class agent harness in ai-sdlc-helper, so a project can
set `harness: "opencode"` (or a per-stage override) and the pipeline drives
`opencode run`. Model discovery must be **dynamic** (live from OpenCode, never a
hardcoded list), the web UI model dropdowns must gain a **client-side filter**,
everything must go through the **existing registry/adapter contract**, and
`claude` / `agy` / `codex` must be byte-identical before and after.

## Design decisions

1. **Conform, don't invent.** The repo already has the exact seam: `AgentHarness`
   (`src/pipeline/harness/types.ts`) + `ModelCatalogAdapter` + `DefaultHarnessRegistry`
   (`src/pipeline/harness/registry.ts`). Codex is the adapter exemplar
   (`src/pipeline/harness/codex.ts`, `src/pipeline/harness/codex/catalog.ts` —
   constructor-injected query fns, cache, fallback). OpenCode follows that shape;
   no new factory layer.

2. **The model list comes from the HTTP API, not the TUI table.** `opencode models`
   prints a bare newline list with **no `--json`** flag. The structured source is
   `opencode api get /api/model` (JSON: `{ location, data: [ { id, modelID,
   providerID, name, variants[].id + settings.reasoning.effort, capabilities,
   cost } ] }`). The adapter **unwraps `.data`** — it is not a bare array.

3. **Model IDs are canonical `provider/model`, composed deterministically.**
   The CLI reports `opencode-go/…` while the session API resolves `opencode/…`;
   `opencode run --model` accepts the canonical `provider/model#variant`. The
   adapter composes `HarnessModel.id` as `modelID` when it already contains `/`
   (e.g. openrouter `nex-agi/nex-n2.6`), else `providerID + "/" + modelID` (e.g.
   bare `claude-fable-5-2` → `opencode/claude-fable-5-2`). `compileStageArgs`
   appends `#<effort>` only when the model supports it. Whether bare ids are
   accepted without the prefix is open question 1 — never guessed, resolved by
   experiment.

4. **Harness id is an enum entry, the model list is dynamic.** `HARNESS_IDS` in
   `src/config/settings.ts:19` is a closed `as const` tuple used for the config
   schema, `forceOf` validation and `HarnessName`. Adding `'opencode'` here is one
   line, matching how `claude`/`agy`/`codex` are named — not "hardcoding a model".
   The *models* are what must never be hardcoded, and they won't be.

5. **Default model is the CLI's, not a translated Claude name.** `harnessSelection`
   (`src/pipeline/agent.ts`, and its doc comment) already states the global
   `STAGE_DEFAULTS` are Claude names and a foreign harness must let its own CLI
   pick the account default. `OpencodeHarness.selectStageModel` returns
   `{ model: configuredModel || '', effort: … }`, exactly like `AgyHarness`/`CodexHarness`.
   No change to `src/pipeline/models.ts` `STAGE_DEFAULTS`.

6. **Registry and `HARNESS_IDS` must stay in sync — there is already a test for it.**
   `test/edit-settings.test.ts:127` asserts
   `[...HARNESS_IDS].sort() === new DefaultHarnessRegistry().list().map(h => h.id).sort()`.
   Both are updated together and the test enforces it going forward.

## Files to add

### `src/pipeline/harness/opencode/catalog.ts`
`OpencodeModelCatalogAdapter implements ModelCatalogAdapter`, mirroring
`codex/catalog.ts`:
- `constructor(listFn = defaultListFn, fallback?: HarnessModel[])` — injectable for
  tests.
- `defaultListFn(env)` shells out to `opencode api get /api/model`, returns the
  raw JSON array. `env` is passed so tests can inject a fake binary/`OPENCODE` path.
- `listModels(env)` maps `/api/model`'s `data[]` items to `HarnessModel`:
  - `id` = `modelID` if it contains `/`, else `providerID + "/" + modelID`,
  - `name = item.name`,
  - `harness = 'opencode'`,
  - `supportsEffort` = some variant's `settings.reasoning.effort` ∈ `EFFORT_LEVELS`
    (`low|medium|high|xhigh|max`) — **not** `variants.length > 0` (real payloads
    carry `none`/`thinking`/`minimal` variants),
  - `defaultEffort` = the first such in-range variant effort,
  - `description` from `item.family` / capabilities.
  - **Filter:** keep only items whose `providerID` is the OpenCode Console/agent
    provider. The exact id (`opencode` vs `opencode-go`) must be read, not
    hardcoded: prefer the provider whose models are reachable under
    `opencode auth`; fall back to *all* items when the provider list is empty.
  - Cache the result; `invalidateCache()` clears it (as codex does).
- `getDefaultModel(env)` = `opencode api get /api/model/default`, else first item.
- `validateModel(id, env)` = `listModels(env)` then `some(m => m.id === id)`.
- On failure (CLI missing, unauthenticated, non-JSON) return the `fallback`
  (empty by default) and expose a `lastError` for `doctor`; never throw.

### `src/pipeline/harness/opencode.ts`
`OpencodeHarness implements AgentHarness`:
- `id = 'opencode'`, `name = 'OpenCode'`, `defaultBinary = 'opencode'`,
  `catalog = new OpencodeModelCatalogAdapter()`.
- `detect(env)`: `which('opencode')`; when found, also try
  `opencode auth list` / `opencode api get /api/model` to report `installed` plus
  whether models are reachable (extend the `HarnessDetection` usage; keep
  `installed:false, error` when the binary is absent).
- `listModels(env)` = `catalog.listModels(env)`.
- `selectStageModel(opts)` = `{ model: opts.configuredModel || '', effort: opts.configuredEffort }`
  (same as agy/codex — foreign harness, account default).
- `compileStageArgs(opts)`: `opencode run` →
  - `--model <model>#<effort>` when both present (effort as the `#variant`),
    else `--model <model>` / `--model <provider/default>` omitted when empty,
  - `--format json`,
  - `--auto` for `acceptEdits`/`bypass` (OpenCode has no distinct bypass flag;
    see open question 3),
  - `--agent build` optional (open question 4),
  - `<prompt>` last.
- `compileAuditArgs` = same shape for read-only audit.
- `parseOutput` / `normalizeOutput` are **out of scope** here (stream parsing is a
  follow-up); stub `parseOutput` to the minimum the interface requires and flag it.

### `test/fixtures/opencode/model-list.json`
A frozen copy of `opencode api get /api/model` (a few real entries including the
provider-id discrepancy, plus variants with `reasoning.effort`), used by the
adapter tests — following the `test/fixtures/codex/*` convention.

## Files to change

- **`src/config/settings.ts:19`** — `HARNESS_IDS = ['claude', 'agy', 'codex', 'opencode']`.
  This widens `HarnessName` and the config schema automatically (schema is built
  from `[...HARNESS_IDS]` at `src/config/settings.ts:156-157`), and the
  `forceOf`/`run.ts:158` "must be one of claude, agy, codex" messages become
  "…, opencode" for free (generated from the tuple).
- **`src/pipeline/harness/registry.ts:21-27`** — register
  `this.register(new OpencodeHarness());` in `DefaultHarnessRegistry`'s
  constructor's `registerDefaults` block, and export it from
  `src/pipeline/harness/index.ts`.
- **`src/registry/doctor.ts`** — the CLI-check branches (around `:78-96`) only
  cover the harnesses a project actually uses. Add an `opencode` branch and a
  model-reachability check (empty list → graceful "signed in but no models" or
  "not authenticated" note, never a hard failure).
- **`src/pipeline/harness/types.ts`** — extend `HarnessDetection` with optional
  `models?: { reachable: boolean; count?: number }` (or a sibling field) so
  `doctor`/UI can report reachability without breaking the existing three
  harnesses' `detect`.
- **`web/ui/src/Run.tsx`** — add the model-dropdown filter (below). The existing
  `harnessModels` server payload already becomes
  `{ …, opencode: [ … ] }` with no server change, because `web/server/index.ts:122-127`
  iterates `DefaultHarnessRegistry.list()`.
- **Tests that hard-code the 3-harness world — update them** (they will break
  otherwise; the plan must not assume they pass unchanged):
  - `test/harness.test.ts:291` — `expect(list.map(h => h.id)).toEqual(['claude','agy','codex'])` → add `'opencode'`.
  - `web/test/server.test.ts:264,270` — `harnesses: ['claude','agy','codex']` and
    `Object.keys(models).toEqual(['claude','agy','codex'])` → include `'opencode'`.
  - `test/edit-settings.test.ts` — the "must be one of claude, agy, codex"
    expectations (≈ lines 45, 47, 212, 225, 246, 251, 295, 304) are generated
    from `HARNESS_IDS`, so they update to the 4-item list; the `:127` assertion
    is the sync guard that keeps registry and tuple together.

No change to `src/pipeline/models.ts`, `web/server/index.ts`, or the other three
harnesses.

## UI filter design (`web/ui/src/Run.tsx` `stagePickers`)

Today the model `<select>` (`Run.tsx:400`) renders `catalog.models[harness]`
options directly. Add a small filter that:

1. Keeps the **same option source** — `catalog.models[<active harness>]` — so
   `claude`/`codex`/`agy` option sets are untouched (only `opencode` is added at
   the top level of the payload).
2. Adds a text `<input>` above the model `<select>` (searchable combobox, or a
   filter-only input + `<select>`). Filters options client-side by substring over
   `id` **and** `name`, case-insensitive. Debounced (~120ms), trimmed.
3. Shows a `no models match "<q>"` empty state (disabled "no match" option) and a
   reset affordance; when the filter is empty the full list renders exactly as today.
4. Keeps keyboard/ARIA on the `<select>` (a filter input does not replace the
   select semantics).
5. Extract the filter predicate into a pure function (e.g.
   `web/ui/src/modelFilter.ts` — `filterModels(models, query): HarnessModel[]`) so
   it is unit-testable in `web/test` without a browser.

The same filter should **not** be force-applied to the effort `<select>` (its
values are the fixed `EFFORTS`) or the agent `<select>` unless desired — scope is
models only.

## Tests

- `test/opencode-catalog.test.ts` — adapter mapping from the fixture
  (`id` = `modelID`-or-`providerID/modelID` composition, `supportsEffort` from
  `reasoning.effort` ∈ `EFFORT_LEVELS`, `defaultEffort` coercion), `.data`
  unwrap, caching, `invalidateCache`, `getDefaultModel`, `validateModel`,
  fallback-on-error.
- `test/harness.test.ts` (extend) — `OpencodeHarness` metadata,
  `compileStageArgs` emits `--model <provider/model>#<effort>` + `--format json`,
  `selectStageModel` default `''`; and update the `:291` registry-list
  expectation to four harnesses.
- Golden-diff regression — snapshot `compileStageArgs`/`listModels` for
  `claude`/`agy`/`codex` and assert unchanged (byte-identical) after the opencode
  registration. Placed in `test/harness.test.ts`.
- `test/edit-settings.test.ts` — update the generated error-message expectations
  to the 4-item `HARNESS_IDS`; keep the `:127` sync assertion.
- `test/model-filter.test.ts` — `filterModels` pure-function cases (substring,
  case, empty query, no match), importing `../web/ui/src/modelFilter.js`
  (repo convention: pure UI fns live in `web/ui/src/*.ts`, tests in root
  `test/*.test.ts`, e.g. `test/markdown.test.ts`).
- `web/test/server.test.ts` — update the `harnessModels` expectations
  (`harnesses` and `Object.keys(models)`) to include `opencode`; assert the three
  existing keys' contents are unchanged.

`npm run check` must stay green end to end.

## Acceptance criteria (for the reviewer)

1. `OpencodeModelCatalogAdapter.listModels(fixture)` unwraps `data` and returns
   models with `id` = canonical `provider/model` (or already-prefixed `modelID`),
   `supportsEffort` from `variants[].settings.reasoning.effort` ∈ `EFFORT_LEVELS`,
   and `defaultEffort` from the first such variant.
2. `compileStageArgs` emits `--model <provider/model>#<variant>` (the id exists
   verbatim in the dynamic list) plus `--format json`; no `#variant` when the
   model has no in-range effort.
3. `npm run check` green, and a golden-diff proves claude/agy/codex
   `listModels`/`compileStageArgs` are unchanged after registering opencode
   (the three hard-coded harness-list tests are updated to four).
4. The UI model dropdown adds a client-side filter over the existing
   `harnessModels` payload; claude/codex/agy option sets are unchanged, only an
   `opencode` key is added.
5. `doctor` reports `opencode` installed state and model reachability (via the
   extended `HarnessDetection`), and degrades gracefully (empty list, not a
   failure) when unauthenticated.

## Open questions / risks (to verify during implementation, not blockers)

1. **Provider-id namespace** — confirm whether `opencode api get /api/model`
   reports the Console provider as `opencode`, `opencode-go`, or both (all four of
   `openrouter`/`opencode`/`opencode-go`/`ollama` were observed live), and whether
   `opencode run --model <bare-modelID>` (no prefix) is accepted. Resolve by
   experiment, then encode the *composition rule* (not a guess) in the adapter.
2. **Variant ↔ effort** — confirm `variants[].id` values (`low`/`medium`/`high`/
   `xhigh`/`max`) match `EFFORT_LEVELS`, so `#variant` round-trips.
3. **Permission mode** — OpenCode has no `--permission-mode` equivalent; confirm
   `--auto` is the right mapping for both `acceptEdits` and `bypass`, or whether a
   settings file (`{env:…}` permission allowlist) is needed.
4. **Agent selection** — whether to pass `--agent build` (default) or let it
   inherit; decide after a smoke run.
5. **Stream parsing** — `opencode run --format json` output shape and
   `parseOutput`/denial mapping is explicitly deferred (follow-up), but must be
   stubbed so the harness typechecks.

## Implementation notes

- A live `opencode api get /api/model` inspection returned provider ids
  `openrouter` (353 entries), `opencode` (42), `opencode-go` (32), and `ollama`
  (2). Both Console providers used bare `modelID` values (for example
  `claude-fable-5-2`), while OpenRouter included already-prefixed values such as
  `nex-agi/nex-n2.6`. The adapter therefore keeps a `modelID` containing `/`
  verbatim and otherwise composes `providerID + "/" + modelID`. No real
  `opencode run` was executed.
- Implemented the dynamic catalog, harness registration and invocation
  compilation, settings/doctor integration, model reachability reporting, the
  debounced web model filter, and regression/unit tests. Stage runs map both
  editing permission modes to `--auto`; no `--agent build` flag is added.
- Deferred OpenCode JSON event-stream normalization and parsing, including
  assistant-text extraction, tool-denial mapping, and rate-limit handling. The
  interface currently has a deliberately minimal raw-output `parseOutput` stub.
