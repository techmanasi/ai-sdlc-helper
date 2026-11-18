# orchestrator-agent

Feature: an optional agent that drives a run and decides pauses for the user, and notifies the user when out of tries.

Recommended shape (from the 2026-11-19 review): off by default; a try limit per pause kind and a spend cap; it may answer
questions, retry transient failures and resume, but may never allow a protected-path permission, accept a test-repair
claim or bypass a gate; every decision is logged to `decisions.md` and shown on the run page. Hooks that exist today:
`StageRecovery`, `answerQuestions`, `decide`, `start --from`. Overlaps `docs/redesign/` parallel reviewers.
Status: brief only; write the full spec when picked up.
