---
pr: https://github.com/techmanasi/ai-sdlc-helper/pull/85
---

# ci-full-suite-gate

Type: feature
Priority: P2 (normal)

## Problem
The pipeline runs the project's tests on the developer's machine. On a large suite that is slow, and it ties up the machine while CI does the same work again. Red tests only runs the new test files and nothing records how the existing suite was doing before Implement starts, so a side effect on older tests is found late or not at all.

## Expected behaviour
- A config setting (project and personal config, plus an environment override) turns on "full suite in CI only". With it on, the pipeline runs only the new or changed test files locally and leaves the full suite to CI. With it off, behaviour is as today.
- When Red tests starts, the pipeline pushes the branch and opens a draft PR, so CI begins on the red tests at once.
- Red tests does not wait for CI. Red tests is red by design, so CI failing on it is expected and is not a gate.
- Implement waits for the full CI run on the branch. It continues only when CI is green.
- When CI is not green, Implement reads the failing checks. If a failure is a side effect of the implementation (a test that passed on main and fails on the branch), Implement fixes it and pushes again, within its normal attempt limit. A failure that already exists on main, or is flaky or infrastructure, is reported and does not block or get patched.
- If CI cannot be reached (no remote, no gh, no workflow), the pipeline says so and falls back to running the full suite locally. It never reports green without a result.

## Decisions
- Waiting reuses the PR status lookup in src/pipeline/finalise.ts (gh, with its timeout and cache) instead of a second poller.
- Main is the reference for "pre-existing": a failure also failing on the base commit is not a side effect.
- The draft PR is created once, by the run, and the same PR is used by Finalise; Finalise marks it ready.
- A wait has a timeout setting; when it passes, the run pauses with a recovery hint instead of failing.

## Scope
- In: the config setting and its docs, draft PR at Red tests start, the Implement wait for CI, side-effect fixing, fallback to local, web UI showing the CI state on the run page.
- Out: CI providers other than GitHub Actions through gh, changing how Test repair or Review work, making CI itself faster.

## Tests
- Config off: no draft PR, nothing changes.
- Config on: draft PR opened at Red tests start; Red tests proceeds without waiting; Implement blocks until CI reports success.
- CI red on a test that passes on the base: Implement is given the failure and fixes it; CI red on a test that also fails on the base: reported, not patched.
- No remote or gh: falls back to local full suite with a visible message.

## Docs
- README and docs/web-ui.md: the setting, the draft PR, and what Implement waits for.
