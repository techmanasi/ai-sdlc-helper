# Review round 6

Verdict: changes.

- AC8 blocker: refused project saves throw from the API client before the form can set its adjacent loop-limit error. Only the general error is populated. A test must submit invalid text using the real API client, then check the adjacent message and retained input.
- AC5 missing test: empty override fallback still lacks an automated server-start test. Use a committed project configuration and verify the child uses that value without changing the file.
- AC8 missing test: component tests now exist for Projects, but none verifies the Run field, project-value hint (including 0), or override input wiring.

The prior default-display issue is fixed. `tsc -p web --noEmit` passes, so the reported CI typing issue is resolved. An in-memory execution of the real API client confirmed that a 400 validation response rejects with ApiError. The prescribed `ai-sdlc-helper run --file web/test/review-loop-limit-findings.test.ts` stopped before running tests because the installed runner rejects `tests.fullSuite` and `agent.stages` in the repository configuration. Runtime test results therefore remain unverified.

The inspected feature tests exercise source code, HTTP routes, and the fake-agent pipeline; none asserts on Markdown or comments. The feature is implemented in code. Binding exclusions for existing settings save/clear/refusal behavior, safe integers, and uncommitted settings were honored. Only the two requested review reports were written.
