# Agent lifecycle and adapters

The pipeline has two deliberately separate boundaries:

* Harness adapters (`src/pipeline/harness/*.ts`) compile an agent's command,
  flags, model/effort settings, permissions, and output format.
* `src/pipeline/agent-process.ts` supervises every non-interactive child in the
  same way: it supplies an explicit EOF on stdin, captures logs, resolves once,
  handles cancellation, and terminates a child that exceeds its timeout.

Adding an agent should therefore require a new `AgentHarness` implementation,
not a branch in the process runner. Models remain owned by their harness and
are never translated to another harness, and each adapter says so itself
([types.ts](../../src/pipeline/harness/types.ts)):

* `ownsModelIds` — whether the CLI takes model ids as they are (`true`, the
  default: agy, codex, opencode, declarative plugins) or has them resolved
  through a custom provider first (`false`, the claude harness only).
* `ownsModel(model)` — which ids are this harness's own. It defaults to
  `"<id>/..."`; OpenCode also claims its provider prefixes such as
  `opencode-go/...`, and a plugin may claim anything it wants.

`stageModel` asks the registry which harness owns a model instead of knowing
any of it ([src/pipeline/models.ts](../../src/pipeline/models.ts)): a model that
another harness owns cannot run on this stage, whatever set it (a stage entry,
`--model`, `MODEL_<STAGE>` or `SDLC_MODEL`), and the run stops at its start
naming the stage whose setting is wrong:

```
ERROR: model 'opencode/gemini-4-carbon' belongs to the opencode harness;
stage test-repair runs on claude (set agent.stages.test-repair.harness, or pick a claude model)
```

The `SDLC_PROVIDERS` message stays for a prefix no harness claims, where a
custom provider really was intended. The claude harness keeps both provider
paths — the user model registry first, then `SDLC_PROVIDER*` — so an
`openrouter/...` or registry model on a claude stage is resolved exactly as
before.

`SDLC_AGENT_TIMEOUT_MS` controls the generic process timeout. A request may
override it with `timeoutMs`; the default is 30 minutes. A timeout writes an
actionable message to the agent stderr log and terminates the child with
SIGTERM, followed by SIGKILL after a short grace period.
