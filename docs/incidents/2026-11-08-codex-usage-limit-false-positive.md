# Incident: Codex usage-limit false positive

**Date:** 2026-11-08  
**Severity:** High  
**Status:** Confirmed; remediation pending  
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

- [ ] `usageLimit()` returns `null` for this archived `spec-1.json` plus
      `spec-1.err`.
- [ ] Actual Codex `rate_limit_exceeded` JSONL still returns `rate limit reached`.
- [ ] Actual quota error JSONL still returns `quota exceeded`.
- [ ] A successful Codex stage with Graft output is not stopped.
- [ ] The UI no longer shows a quota recovery message for transcript text.
- [ ] The repaired pipeline reaches Plan.

