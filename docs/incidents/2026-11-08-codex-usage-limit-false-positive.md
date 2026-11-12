# Incident: Codex usage-limit false positive

**Date:** 2026-11-08  
**Severity:** High  
**Status:** Closed 2026-11-12 for the code: fixed in #77 (`e833b0a`),
regressions covered in `test/agent-failure-and-limits.test.ts` (see
[Resolution](#resolution-2026-11-12)). One manual check stays open: a Codex
stage on `gpt-5.6-luna`, which the remediation asked for and no later run
performed.  
**Affected stage:** Spec  
**Affected model:** `gpt-5.6-luna`  
**Run:** `config-modal-keyboard`

## Summary

The SDLC pipeline stopped a successful Codex Spec execution and reported:

```text
agent 'spec-1' hit the usage limit (usage limit reached)
```

This was a false positive. Codex completed its turn, wrote `specs-1.md`, and the
captured stderr contained no provider quota or rate-limit response.

## Impact

- The run was marked failed at Spec.
- The UI displayed a quota/usage-limit recovery path and suggested waiting or
  switching models.
- A successful stage had to be retried unnecessarily.
- The failure obscured the real non-fatal command issue in the agent transcript:
  an `apply_patch` verification failure while checking a file path.

## Timeline

1. The UI started `config-modal-keyboard` with `codex`, model
   `gpt-5.6-luna`, effort `medium`.
2. Codex executed repository inspection commands and created
   `specs-1.md`.
3. The Codex JSONL transcript recorded `turn.completed`.
4. The child process exited.
5. `usageLimit()` scanned the complete JSONL file and returned
   `usage limit reached`.
6. The pipeline stopped with exit code 1 and rendered the quota diagnosis.

## Evidence

Run output:

`/Volumes/Work/Projects/trials/ai-sdlc-helper-sdlc/config-modal-keyboard/docs/backlog/config-modal-keyboard/logs/run.out`

```text
-> agent: spec-1
model=gpt-5.6-luna effort=medium
!! agent 'spec-1' hit the usage limit (usage limit reached)
```

Agent stderr:

`/Volumes/Work/Projects/trials/ai-sdlc-helper-sdlc/config-modal-keyboard/docs/backlog/config-modal-keyboard/logs/spec-1.err`

```text
Reading additional input from stdin...
2026-11-08T08:28:53.823080Z ERROR codex_core::tools::router:
error=apply_patch verification failed
```

The file contains no quota, rate-limit, HTTP 429, or reset message.

Agent transcript:

`/Volumes/Work/Projects/trials/ai-sdlc-helper-sdlc/config-modal-keyboard/docs/backlog/config-modal-keyboard/logs/spec-1.json`

The transcript contains a successful `turn.completed` event and a completed
file change for `specs-1.md`. It also contains Graft command output that quotes
source and test code containing the literal `usage_limit_reached`.

That block describes the file **as captured on 2026-11-08**. The resumed run
overwrote it on 2026-11-09, so the path now holds a different, single-line
transcript; the shape above lives on in the regression test named in the
checklist below.

## Root cause

`src/pipeline/agent.ts` parses structured JSONL events, but then performs a
second unrestricted scan:

```ts
const fromRaw = checkText(raw);
if (fromRaw) return fromRaw;
```

`raw` is the entire Codex transcript, including command output produced by
tools such as Graft. That output can contain quota-related strings as ordinary
source-code text. The detector interpreted the quoted literal
`usage_limit_reached` as an actual provider error.

The detector therefore confused **content mentioned by the agent/tools** with
**an error emitted by the Codex provider**.

## Contributing factors

- Codex JSONL combines assistant messages, tool commands, tool output, and
  provider events in one file.
- The detector uses broad regular expressions over untrusted transcript text.
- The pipeline checks usage after the child exits, so the false positive
  overrides the otherwise successful completion.
- The UI displays the detector result without showing the matching evidence.

## Remediation plan

- Restrict Codex usage detection to structured provider error events and
  provider-owned stderr.
- Do not scan complete JSONL transcripts for quota strings.
- For single-object agent formats, inspect only typed error/status fields, not
  arbitrary `result` or assistant text.
- Add regression coverage where tool output contains
  `usage_limit_reached`, `quota exceeded`, and `rate_limit_exceeded` as quoted
  source text; the detector must return `null`.
- Add positive fixtures for actual Codex rate-limit and quota error events.
- Include the matched source (`stderr`, structured error event, or status field)
  in diagnostics so the UI can distinguish a provider limit from transcript
  content.
- Re-run the same `config-modal-keyboard` pipeline with `gpt-5.6-luna` after
  the fix and verify the stage advances beyond Spec.

## Verification checklist

- [x] `usageLimit()` returns `null` for this archived `spec-1.json` plus
      `spec-1.err`.
      The original pair was overwritten by the resumed run on 2026-11-09
      (`spec-1.err` is now empty, `spec-1.json` is a different single-line
      file), so the replay is the regression test that encodes this transcript's
      shape: Codex `command_execution` output quoting `usage_limit_reached`,
      `quota exceeded` and `rate_limit_exceeded`, plus an `agent_message` quoting
      them, all in a successful turn (`test/agent-failure-and-limits.test.ts`,
      "ignores quota strings in Codex tool output and assistant text of a
      successful turn").
- [x] Actual Codex `rate_limit_exceeded` JSONL still returns `rate limit reached`.
      `{"error":{"code":"rate_limit_exceeded"}}` and
      `{"type":"turn.failed","error":{"code":"rate_limit_exceeded"}}` both return
      it (same file).
- [x] Actual quota error JSONL still returns `quota exceeded`.
      `{"error":{"code":"insufficient_quota",…}}`, a `turn.failed` with the quota
      message, and the stderr fallback all return it (same file).
- [x] A successful Codex stage with Graft output is not stopped.
      The same regression test runs `graft grep usage_limit_reached` as the
      tool command and asserts `usageLimit()` is `null`, so the pipeline never
      writes the `hit the usage limit` line and never stops the stage.
- [x] The UI no longer shows a quota recovery message for transcript text.
      `stageRecoveryHint` only diagnoses a quota from the run.out line
      `!! agent '<name>' hit the usage limit` / `quota / usage limit reached`
      (`test/agent-failure-and-limits.test.ts`, "stageRecoveryHint diagnoses
      agent failures and quotas across stages"). With `usageLimit()` returning
      `null`, that line is never written.
- [ ] The repaired pipeline reaches Plan.
      **Not demonstrated on the Codex path.** The same worktree did go on to
      Implement and Finalise on 2026-11-09
      (`../ai-sdlc-helper-sdlc/config-modal-keyboard/docs/backlog/config-modal-keyboard/logs/run.out`),
      but that run resumed with the claude harness (`model=opus` / `sonnet`), not
      `gpt-5.6-luna` on codex, so the remediation's "re-run with `gpt-5.6-luna`"
      was never done. The detector itself is proven by the regression tests
      above; this item is a manual check to run the next time a Codex stage runs.

## Resolution (2026-11-12)

What shipped in #77, against the remediation plan:

- **Done.** Detection reads only typed provider events: `error.code`,
  `event.code`, `type: "error" | "turn.failed" | "rate_limit"`, the
  `RATE_LIMITED` / `QUOTA_EXCEEDED` statuses, and the stderr file
  (`src/pipeline/agent.ts`, `usageLimit`). The whole-transcript scan
  (`const fromRaw = checkText(raw)`) is gone; JSONL is walked event by event.
- **Done.** For a single-object transcript only typed fields are read (`status`,
  `error.code`, `error.status`, `api_error`), plus `result` when `is_error` is
  true — the text of a failed run is the provider's message, the text of a
  successful one is the agent's own answer.
- **Done.** Regression coverage for quoted limit strings in tool output and
  assistant text, and positive fixtures for real Codex rate-limit, quota and
  usage-limit events, including the resets message.
- **Done.** The regression tests prove the detector returns `null` for this
  transcript's shape, so the stage is not stopped. What the tests do not show is
  a live Codex run: the later run of `config-modal-keyboard` that continued past
  Spec used the claude harness (`model=opus` / `sonnet`), not `gpt-5.6-luna`, so
  the remediation's re-run was never made and that line stays open below.
- **Not done, deliberately.** The matched source (`stderr`, structured event or
  status field) is not surfaced separately in the UI: `usageLimit()` returns the
  provider's text ("resets 3pm", "quota exceeded"), and the recovery hint shows
  that text, not which field it came from. Add it if a future false positive
  needs to be triaged from the UI rather than the logs.

Closing note: the archived evidence under
`../ai-sdlc-helper-sdlc/config-modal-keyboard/` was overwritten by the resumed
run, so this file and the regression tests are the record. Keep a copy of the
transcript with an incident when one is filed, not only its path.

