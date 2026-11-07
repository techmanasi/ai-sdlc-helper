# Codex CLI and Graft pipeline integration: remediation plan

Status: proposed, nothing implemented. This is a reliability and compatibility plan for running the SDLC pipeline with OpenAI Codex CLI and Graft.

## Goal

Every agent-backed stage can run with `codex` predictably, preserve the pipeline's safety and pause semantics, produce readable logs, and use the project's Graft index through a documented, tested path. Finalise remains a native pipeline operation; it does not need an LLM harness.

## Findings

### What is already wired

- `src/pipeline/agent.ts` routes Spec, Plan, Red tests, Implement, Test repair, and Review through the harness selected by `harnessFor`.
- Test repair runs its independent Test audit through the same selected harness.
- `CodexHarness` emits `codex exec -C <worktree> -m <model> -c model_reasoning_effort=<effort> --json <prompt>`; editable stages add `--approve-for-me`, while a protected-path override adds `--dangerously-bypass-approvals-and-sandbox`. Audit uses `-s read-only`.
- Codex CLI 0.166.0 accepts those core flags.
- Graft is a built-in code indexer. When its command is on `PATH` and its `graft/` index exists, resolved settings select it and `code-search.graft.md` is rendered into every stage prompt. Its index directory is linked into pipeline worktrees.

### Gaps and risks

1. The repository's `sdlc.config.json` has no `agent.harness` value, so its effective default is Claude. Codex requires `agent.harness: "codex"`, `SDLC_AGENT=codex`, or `start`/`restart --agent codex`.
2. Test audit is a blocker: Codex with `--json` writes JSONL, but `testRepairStage` reads `test-audit.log` as plain text and requires a literal `VERDICT: VALID` line. A valid JSONL result cannot satisfy that predicate without normalization.
3. The Codex harness ignores `allowedCommands` and `maxTurns`, even though the generic harness contract provides both. `--approve-for-me` and the dangerous bypass flag do not implement the pipeline's per-command permission model.
4. `runAgent` uses the generic permissions extractor directly, while `CodexHarness.parseOutput` is unused. The parser and extractor only have synthetic `message` and `tool_denial` test events, not a fixture captured from the installed Codex CLI.
5. A rate-limit retry starts a fresh `codex exec` process rather than resuming a prior session. This repeats context and can increase cost and latency.
6. Graft is available through shell commands and injected instructions, but the project neither configures nor verifies a Codex MCP server. Metadata naming `mcp__graft` does not make that tool available to `codex exec`.
7. Codex model names and the mappings from Claude defaults are hard-coded. Availability is not verified against the authenticated Codex account before a run starts.

## Design decisions

- Keep the generic `AgentHarness` boundary, but make it the sole owner of its output normalization and invocation semantics.
- Treat Graft CLI as the required baseline integration. Codex MCP support is optional and must be explicitly configured and probed; do not claim it merely from metadata.
- Preserve the existing safety guarantee: no harness may silently turn a granular allow-list into unrestricted execution.
- Keep generated raw JSONL for debugging, but make stage consumers use a normalized transcript/result file.

## Implementation steps

### 1. Add an explicit Codex setup contract

1. Document the project setting in README and `docs/web-ui.md`:

   ```json
   { "agent": { "harness": "codex", "codeSearch": "graft" } }
   ```

2. Make `doctor` report the selected Codex executable, version, authentication/readiness if that can be checked without an interactive run, and the selected code-indexer status.
3. Make the UI surface that Codex is selected per stage, rather than only showing a generic agent configuration.
4. Add a warning before start if a Codex-specific model mapping is unknown or incompatible with the installed CLI/account. Do not make a network call merely to list models unless the user requested it.

### 2. Normalize harness output before pipeline consumers read it

1. Extend `HarnessResult` to include a normalized final text, structured tool/permission events, session identity when supplied by the CLI, and a normalized limit/error classification.
2. Make `runAgent` call the selected harness parser after every invocation. Persist:
   - raw output: `<stage>.jsonl` (or an explicitly named raw file),
   - normalized transcript: `<stage>.log`,
   - normalized result metadata: `<stage>.result.json`.
3. Make the permission flow and `usageLimit` consume normalized metadata, not harness-specific JSON shapes.
4. Make `runAudit` normalize the Codex result before `testRepairStage` reads it. The normalized audit log must contain the exact final audit text, so `VERDICT: VALID` works for every harness.
5. Preserve raw output and stderr in failure reports.

### 3. Make Codex permissions explicit and safe

1. Decide and document one supported policy for editable Codex stages:
   - preferred: invoke Codex in `workspace-write` sandbox mode and translate pipeline allow rules into a supported Codex execution policy/configuration; or
   - fallback: declare Codex stages as coarse-grained approval only, disable the misleading per-command permission UI for those stages, and require an explicit user acknowledgement before start.
2. Never automatically use `--dangerously-bypass-approvals-and-sandbox` from a previously saved per-command permission decision. Restrict it to an explicit, run-wide opt-in that is visible in the UI and recorded in run metadata.
3. Keep audit strictly `read-only`; verify that a rejected write results in a normalized denial and an actionable pipeline error.
4. Add an integration test proving that an unapproved dangerous command neither runs nor is silently accepted.

### 4. Bound and resume Codex sessions

1. Investigate the current Codex CLI's supported limit/cancellation controls. Map `maxTurns` only if an equivalent exists; otherwise label it unsupported in configuration/status rather than silently dropping it.
2. Persist the Codex session/thread identifier from normalized JSONL output.
3. On retryable rate/usage limits, use `codex exec resume <id>` when safe; otherwise record why a fresh session is required.
4. Add a wall-clock timeout/cancellation path managed by the pipeline supervisor, with clear recovery instructions.

### 5. Make Graft support concrete

1. Keep the CLI baseline: require `graft` on `PATH`, `graft/` present, and inject the existing Graft search guide into prompts.
2. Add an integration test that runs a Codex-harness fixture with resolved `codeSearch: graft` and asserts the rendered prompt contains the guide and the worktree exposes the index.
3. If MCP support is desired, add an explicit Codex MCP configuration mechanism, a probe, and a setting such as `agent.codeIndexerTransport: "cli" | "mcp"`. Only advertise `mcp__graft` after the probe succeeds.
4. Fall back clearly to Graft CLI, then Grep/Glob, with the resolved method shown in status and logs.

### 6. Use real captured fixtures

1. Add sanitized fixtures from the installed Codex version for: successful editable stage, successful audit, tool denial, rate limit, malformed JSONL, and non-zero exit with stderr.
2. Test `CodexHarness.parseOutput`, the generic normalized-result writer, permission extraction, rate-limit retry, and audit verdict detection against those fixtures.
3. Run an opt-in end-to-end fixture pipeline with a Codex stand-in that reproduces real JSONL shape. It must cover Spec through Finalise, including Test repair and Test audit.

## Acceptance criteria

1. A pipeline configured with `agent.harness: "codex"` dispatches Codex for Spec, Plan, Red tests, Implement, Test repair, Review, and Test audit; Finalise completes natively.
2. Every Codex invocation's command, model, effort, sandbox/approval mode, and resolved Graft method are recorded in status/log metadata.
3. A valid Codex audit producing `VERDICT: VALID` in its final message passes Test repair; `VERDICT: INVALID` rejects it.
4. Permission behavior is either faithfully enforced or explicitly declared coarse-grained before the run; a saved per-command grant never silently enables full sandbox bypass.
5. Graft CLI is verified for the project and appears in rendered Codex prompts and worktrees. MCP availability is reported only when explicitly probed.
6. Captured JSONL fixture tests pass, as do `npm run check` and the applicable end-to-end pipeline suite.
7. A failed or rate-limited Codex run leaves sufficient raw and normalized evidence for the user to resume or diagnose it.

## Recommended order

1. Output normalization and audit verdict fix.
2. Real JSONL fixtures and tests.
3. Permission-policy decision and implementation.
4. Explicit Codex/Graft setup and doctor/UI visibility.
5. Session resume, limits, and optional MCP support.

This order removes the Test repair blocker first and avoids marketing a secure, fully integrated Codex workflow before the protocol and permission boundary are real.
