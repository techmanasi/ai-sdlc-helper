# stage-model-harness-mismatch

Type: bug
Priority: P1 (high)

## Problem
After the fix "a harness that owns its models keeps its model ids" (every non-claude
harness passes its model id to its own CLI instead of resolving it as a custom
provider), a run still died before the agent started:

```
ERROR: model 'opencode/gemini-4-carbon' (stage test-repair): provider 'opencode' is not listed in SDLC_PROVIDERS (see .env.example)
```

That skip only checks the harness the stage resolves to (`agentFor`). A model id can
still reach the stage from a source that outranks the project's stage entry:

- the run's `--model`, or `MODEL_<STAGE>`, or `SDLC_MODEL` (all above the project's
  choice in `stageModel`);
- a stage entry that names a model of a harness it does not run, e.g.
  `{ "harness": "claude", "model": "opencode/gemini-4-carbon" }`, which is what a
  stage keeps when its harness changes without its model being reset.

The stage then goes down the claude provider path with an OpenCode id and fails, and
the message sends the user to `SDLC_PROVIDERS`/`.env` — a claude-harness concept
that cannot fix an OpenCode model id on a claude stage.

## Expected behaviour
1. A model id is never resolved as a custom provider for a harness that does not
   own it: when the `<prefix>` of `<prefix>/<model>` is a known harness id, that id
   is the model's owner.
2. When the stage cannot run the model, the run stops at its start with a message
   that names both harnesses and says how to fix it, e.g. "model
   'opencode/gemini-4-carbon' belongs to the opencode harness; stage test-repair
   runs on claude (set agent.stages.test-repair.harness or pick a claude model)".
   The `SDLC_PROVIDERS` message stays only for a prefix that is not a harness.
3. The claude harness keeps both provider paths (the model registry and
   `SDLC_PROVIDER*`), unchanged.
4. Every stage is checked at the start of the run, so the failure names the stage
   whose setting is wrong instead of the stage where the run happened to resume.

## Decisions
- Read the owner from the id instead of adding a setting or a new field to
  `sdlc.config.json`.
- Keep the existing precedence of `--model` / `MODEL_<STAGE>` / the project's
  setting / `SDLC_MODEL`; only the resolution of the resulting model changes.
- An id whose prefix is not a harness id is still a custom provider: do not break
  `openrouter/...` or a registry provider.

## Scope
- In: `stageModel` / `resolveProvider` in `src/pipeline/models.ts`, the harness-aware
  model selection around `stageFlags` in `src/pipeline/agent.ts`, the error text,
  and the unit tests in `test/pipeline-units.test.ts`.
- Out: the harness adapters and their model catalogs; the model registry and
  `SDLC_PROVIDER*` loading; the UI model pickers (which already list only the models
  of the chosen harness).

## Tests
- A stage configured as claude with an `opencode/...` model: the run fails at its
  start with the mismatch message, not the `SDLC_PROVIDERS` one, and the message
  names the stage.
- The same through `--model`, `MODEL_<STAGE>` and `SDLC_MODEL`.
- An opencode stage with an `opencode/...` model: runs as today, no provider.
- `opus`, `openrouter/...` and a registry provider on a claude stage: unchanged.
- Every case runs the real code.

## Docs
- `docs/agent-lifecycle-adapters.md`: extend the harness-owned-models paragraph with
  the mismatch rule and the message a user sees.
