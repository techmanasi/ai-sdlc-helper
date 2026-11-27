# Plan: Consistent model effort support across harnesses

## Goal

Prevent an effort setting unsupported by the selected model from reaching any agent CLI. Apply the same model capability rules to Claude, agy, Codex, OpenCode, and declarative harnesses, for defaults, project and personal configuration, stage overrides, environment settings, and run-wide overrides.

The reported case is agy model deepseek-v4.1-flash-free. Its catalog accepts low, high, and max, while the effective stage effort is medium. Resolve this incompatibility before invoking the stage and avoid offering unsupported choices in the UI.

## Findings from the current code

- HarnessModel already carries supportsEffort, optional supportedEfforts, and defaultEffort in src/pipeline/harness/types.ts.
- Catalogs provide capability information with uneven completeness. OpenCode reads its variants, Codex reads reasoning-effort support from RPC/API data, Claude supplies a catalog, and agy currently infers fixed effort from model ID suffixes in main.
- stageModel in src/pipeline/models.ts clears effort for some fixed agy variants and models explicitly marked supportsEffort false. It does not normalize an effort absent from a nonempty supportedEfforts list.
- validateStageCatalogs rejects a requested effort only when supportedEfforts is nonempty. The reported error suggests runtime model selection or catalog capability seen by validation differs from the capability/error produced by the CLI, or effort is transformed after validation.
- harnessSelection in src/pipeline/agent.ts resolves model and effort again at execution. Individual harnesses can adjust selection, while argument compilers use different effort conventions. OpenCode encodes effort in the model identifier. Codex uses model_reasoning_effort. Claude and agy use --effort.
- web/ui/src/Run.tsx uses per-model effort choices when present, but falls back to the global effort list when the selected model has no list. Its run-wide override picker must also track the selected model. web/ui/src/Projects.tsx provides project/personal defaults and per-stage settings, any of which can retain stale effort after a model change.
- src/pipeline/run.ts invokes catalog validation before requested stages. Launch independently resolves settings, so both paths need a common effective-selection policy.

## Design

1. Define one shared capability interpretation for a selected catalog model:
   - A nonempty supportedEfforts list is authoritative. Preserve a configured value in that list.
   - If the configured effort is absent from an authoritative list, use the model default when it is listed, otherwise omit separate effort and use the harness/model default.
   - supportsEffort false clears separate effort.
   - An explicit empty supportedEfforts list means no separate effort.
   - Missing capability metadata means unknown. Preserve current behavior for that model and harness instead of assuming all levels are valid.
   - Keep harness-specific mappings, such as OpenCode model#effort encoding, after shared compatibility resolution.

2. Apply the shared policy in pipeline startup validation, stageModel, and final harness selection. Validation and launch must use the same model/effort pair. Keep errors for invalid effort names and unsupported model IDs.

3. Load catalog data for the effective selected model before capability-dependent validation. Cover stage settings, MODEL_<STAGE>/EFFORT_<STAGE>, SDLC_MODEL/SDLC_EFFORT, project settings, and SDLC_FORCE_MODEL/SDLC_FORCE_EFFORT while preserving current setting precedence.

4. Constrain every user-facing effort picker to known supported levels. Clear or normalize stale efforts when the model or harness changes. Cover project/personal defaults, per-stage rows, run-stage controls, and run-wide overrides. For unknown capabilities, retain general effort choices.

5. Review built-in and declarative harnesses. Ensure no harness reintroduces incompatible effort after shared normalization and each compiler gets the intended value. Preserve model choice and provider routing.

## Implementation outline

1. Add focused capability-resolution helpers beside the existing shared harness/model types.
2. Integrate capability resolution and catalog loading with effective-stage resolution. Make validation and launch use the same resolved model/effort pair.
3. Update model/effort pickers in Projects.tsx and Run.tsx to resolve inherited model identity and constrain choices.
4. Add regression tests for all built-in harnesses and a declarative harness. Cover supported, unsupported, fixed-effort, unknown-metadata, model-default, and model-switch behavior.
5. Add an integration regression for agy deepseek-v4.1-flash-free with stale medium. Assert the compiled invocation omits incompatible effort and lets the stage proceed.
6. Run targeted tests, lint, typecheck, and build, then broader checks required by repository guidance.

## Test matrix

| Area | Scenario | Expected result |
| --- | --- | --- |
| Shared capability resolution | Requested effort is supported | Preserve requested effort |
| Shared capability resolution | Requested effort is missing from a nonempty supported list | Use listed model default, otherwise omit effort |
| Shared capability resolution | Model explicitly has no effort support | Omit separate effort |
| Shared capability resolution | Catalog has no effort metadata | Preserve current harness behavior |
| Pipeline precedence | Values supplied by stage config, env, project default, global env, and run override | Preserve current source precedence, then apply model capability |
| Validation and launch | Same effective model and effort | Both use the same normalized pair |
| agy | deepseek-v4.1-flash-free reports low/high/max with stale medium | Invocation does not pass medium and proceeds with supported selection |
| Claude | Adjustable model and no-effort model | Keep supported effort; omit unsupported effort |
| Codex | Model advertises restricted effort list | Omit unsupported effort before compiler emits config |
| OpenCode | Model advertises variants and encodes effort in model ID | Encode only supported variant |
| Declarative harness | Manifest exposes effort flag and catalog capabilities | Compile supported effort, omit unsupported effort |
| Project settings | Change default or stage model with stale effort | Clear effort or select supported default |
| Run UI | Change stage or run-wide model | Choices and selected value follow that model |
| Unknown catalog | Discovery unavailable or metadata missing | Existing picker and launch behavior remain usable |
| Documentation review | User-facing explanation of fallback behavior | Review manually, without documentation-text tests |

## Review items

- Confirm behavior for incompatible stored effort. This plan selects the model-declared default when supported, otherwise omits effort.
- Decide whether normalization also needs a visible run status or UI notice.
- Review documentation changes manually. Tests must exercise implementation behavior rather than inspect docs.
