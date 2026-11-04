# red-tests-minimal-case-tests

Type: improvement
Priority: P2 (normal)
Source: User request (2026-11-02): "how can we optimise our red-test stage to add minimum required tests to cover all cases and reduce redundant tests, cover multiple changes/features in a workflow to verify multiple cases in one run, any one of the cases fail, print appropriate messages to point to the exact failure". Deepened from an eval engineer's view, with a correction from the Vitest timeout investigation (`docs/investigations/vitest-ontaskupdate-timeout.md`).

## Problem
The Red tests stage prompts (`assets/prompts/prompt-red-tests.md`, `assets/skills/red-tests.md`) say nothing about test shape. The agent can write redundant tests, repeat slow setup per test, and give failures that do not name the spec case. Its red check only needs the run to fail, so a test bundling several cases can hide cases that pass vacuously.

Merging cases into one long `expect.soft` test is not the answer:
- `expect.soft` exists only in Vitest; the stage also writes Jest, Mocha, node:test and generic JUnit suites.
- A Vitest test file that ran 67s of synchronous git work without the event loop turning made Vitest's worker RPC time out at 60s ("Timeout calling onTaskUpdate"). This repo's fix (`test/setup.ts`) pauses before each test, so fewer, longer tests weaken it, and target projects do not have it at all.

## Task prompt
Run this prompt as written (it needs the user's approval for about 24 real Red tests stage runs):

```
Role: LLM eval engineer who treats a stage prompt as a product: changes are measured on a fixed benchmark, not judged by reading.

Goal: Change the Red tests stage of ai-sdlc-helper (repo: /Volumes/Work/Projects/trials/ai-sdlc-helper) so its agent writes the fewest tests that still cover every spec case. Each case gets a stable ID (C1, C2, …) in test-cases-1.md. Default shape, for every runner: slow setup runs once per file (beforeAll/before) and each case is its own named test with the case ID in its name. Shared setup that spawns processes or touches files uses async APIs (async spawn, fs.promises), never spawnSync/execSync/*Sync, so the event loop keeps turning. Soft assertions (Vitest expect.soft(value, 'C3: <what failed>')) are allowed only for several observations of one quick action inside one test, and only in Vitest suites; Jest, Mocha, node:test and generic JUnit suites use separate named tests and assertion messages instead. Dependent steps use hard checks so failures do not cascade. Background: a Vitest test file that ran 67s of synchronous git work without the event loop turning made Vitest's worker RPC time out at 60s ("Timeout calling onTaskUpdate"); this repo fixed it with a pause before each test (test/setup.ts), which target projects do not have, so merging cases into long tests, or long synchronous setup, can bring the error back. The red step must show every case ID failing, not just the file. Prove the change on a benchmark against the current prompt.

Start from:
- Prompts: assets/prompts/prompt-red-tests.md, assets/skills/red-tests.md; check consistency with assets/prompts/prompt-test-repair.md, prompt-test-audit.md, assets/skills/tdd-loop.md.
- Per-runner text: src/config/settings.ts FRAMEWORK_TEXT / testFramework (runners: jest, vitest, mocha, node-test, generic-junit); placeholders in src/pipeline/agent.ts:100 and src/config/skills.ts.
- Lesson: docs/investigations/vitest-ontaskupdate-timeout.md ("Mechanism" and "Fix") and test/setup.ts.
- Benchmark: the four sample projects in e2e/projects (specs from their backlog items; e2e/run.mjs PROJECTS lists slug, test and source files). Write a correct reference implementation for each if none exists.
- Runner docs via Context7 (Vitest expect.soft and hooks, Jest, node:test subtests/assert messages, Mocha).
- NEEDS THE USER: approval for about 24 real Red tests stage runs (4 projects x 2 prompt versions x 3), and optionally past real Red tests outputs from their projects.

Methods: A/B on the fixed benchmark, >=3 runs per version; traceability matrix (case ID -> test -> assertion); per-case red check on the pre-implementation tree; seeded faults (one per case, in the reference implementation); Stryker mutation score and unique kills per test on the green implementation; an event-loop block probe per test file (interval sampler loaded as a setup file, or via --require for non-Vitest runners); a scan of generated tests for spawnSync/execSync/*Sync calls in hooks and tests; stress runs of the Vitest benchmark at default workers with synthetic CPU load.

Out of scope (do not do): rewriting this repo's own tests; changing Implement/Review prompts (Test repair/audit only if a rule now conflicts, e.g. case IDs); a new pipeline stage or bundled mutation tooling; changing the stage's model/effort; porting test/setup.ts or any Vitest config change into target projects.

Acceptance criteria:
1. `npm run check > /tmp/sdlc-ai-sdlc-helper.log 2>&1; echo exit=$?` prints exit=0, and `npm run e2e` passes. Any src change has a test that runs the real code; no test asserts on Markdown or prompt text.
2. Results table (benchmark x version x run): every spec case ID traced to an assertion in 100% of new-prompt runs; median test count and test run time at or below the old prompt's.
3. Per-case red: in every new-prompt run, every case ID appears in the red failure output.
4. Seeded faults: for every case, breaking it in the reference implementation gives a failure that names that case ID and no case that does not depend on it, in every new-prompt run.
5. Mutation score (Stryker, JS/TS benchmarks) of the new-prompt tests at or above the old prompt's median; list each test with zero unique kills.
6. Shape: in every new-prompt run, each case ID is its own named test (or, in Vitest only, a soft assertion inside a test that observes one action); no expect.soft outside Vitest suites; no spawnSync/execSync/*Sync in shared hooks.
7. Blocking: measured, not estimated. No new-prompt test file's event loop is blocked for over 10s, and 5 stress runs of the Vitest benchmark at default workers under synthetic CPU load show no "Timeout calling" error.

Deliver: a branch and PR into main with the prompt changes (plus any src/test change for per-runner text), and docs/investigations/red-tests-prompt-eval.md holding the results table, the raw numbers and the commands used. Do not merge; report the PR and its CI status.

Independent review (required before you present the result):
When done, have your result reviewed by another agent in a separate session, on a model different from your own (for example Sonnet if you are Opus, Opus if you are Sonnet). Give the reviewer only the goal, the acceptance criteria and your result, not your reasoning or this conversation. The reviewer must return PASS or FAIL for each criterion, with the evidence it checked (commands run, sources opened). Fix each FAIL or report it as unresolved. Then present the result together with the review verdict for each criterion.
```
