# Agent lifecycle and adapters

The pipeline has two deliberately separate boundaries:

* Harness adapters (`src/pipeline/harness/*.ts`) compile an agent's command,
  flags, model/effort settings, permissions, and output format.
* `src/pipeline/agent-process.ts` supervises every non-interactive child in the
  same way: it supplies an explicit EOF on stdin, captures logs, resolves once,
  handles cancellation, and terminates a child that exceeds its timeout.

Adding an agent should therefore require a new `AgentHarness` implementation,
not a branch in the process runner. Models remain owned by their harness and
are never translated to another harness.

`SDLC_AGENT_TIMEOUT_MS` controls the generic process timeout. A request may
override it with `timeoutMs`; the default is 30 minutes. A timeout writes an
actionable message to the agent stderr log and terminates the child with
SIGTERM, followed by SIGKILL after a short grace period.
