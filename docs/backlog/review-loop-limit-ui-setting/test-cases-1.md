# Review loop limit test matrix

| Scenario | Expected result | Coverage |
| --- | --- | --- |
| Run option 5, 0, or maximum safe integer with project value 1 | Override wins and reaches the pipeline environment | Config and run context |
| Invalid run option, including whitespace and unsafe integer | Resolution fails and run context refuses it | Config and run context |
| Settings response with unset or configured limit | File value is distinguished from default 2 | Server settings GET |
| Settings response with invalid file limit | Presence is exposed for recovery; clearing removes the invalid key | Server settings GET and POST regression; existing test passes on the current implementation |
| Start with override 5 and project value 1 | Child receives override, resolves 5, and project file stays unchanged | Server start and settings loader |
| Invalid start option | HTTP 400 with limit message and no child started | Server start |
| Open review findings with override 0 or 1 | Run fails after exactly the overridden number of fix loops | Fake-agent pipeline |
| Project settings and Run screens | Field, current/default value, retained invalid input and error display | Manual UI review; no component test setup |
| Documentation and rules governing tests | Inspect documentation and test files during Review | Review item; no automated text assertions |

Existing save, clear, stale-file and empty-override behavior is covered by existing tests or review, as specified by the plan.

Review the project form's recovery from an invalid saved value, including both clearing and Use default. The server regression exercises one possible recovery contract; it does not exercise the form itself. Verify saving 3 and 0, clearing valid values, during Review; these are existing behaviors excluded from new automated tests by the stage instructions. A focused server start check confirmed that an empty run option uses the file value and leaves the file unchanged.

The round 3 finding about invalid saves describes behavior already satisfied by the current settings API. A focused API check confirmed 400 and `ok: false` for -1, 1.5, `abc`, and 9007199254740992, the exact limit message and a second `review.mode` error, and unchanged file bytes for each request. No new red test is added for this existing behavior. The existing invalid-file recovery test also passes on the current tree; it is retained as requested.

Round 5: the project form must display both the configured current limit 3 and the default 2 while the input remains filled. `web/test/review-loop-limit-findings.test.ts` renders the form and checks its visible content; it currently fails because 2 appears only in the placeholder. The server's empty-override fallback was already confirmed by the focused API check above, so the request for a failing regression for that behavior is a wrong finding under this stage's red-only constraint. The existing invalid-value server test remains in place; form recovery for invalid values is still a Review item.
