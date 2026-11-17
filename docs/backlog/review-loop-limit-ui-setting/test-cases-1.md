# Review loop limit test matrix

| Scenario | Expected result | Coverage |
| --- | --- | --- |
| Run option 5, 0, or maximum safe integer with project value 1 | Override wins and reaches the pipeline environment | Config and run context |
| Invalid run option, including whitespace and unsafe integer | Resolution fails and run context refuses it | Config and run context |
| Settings response with unset or configured limit | File value is distinguished from default 2 | Server settings GET |
| Start with override 5 and project value 1 | Child receives override, resolves 5, and project file stays unchanged | Server start and settings loader |
| Invalid start option | HTTP 400 with limit message and no child started | Server start |
| Open review findings with override 0 or 1 | Run fails after exactly the overridden number of fix loops | Fake-agent pipeline |
| Project settings and Run screens | Field, current/default value, retained invalid input and error display | Manual UI review; no component test setup |
| Documentation and rules governing tests | Inspect documentation and test files during Review | Review item; no automated text assertions |

Existing save, clear, stale-file and empty-override behavior is covered by existing tests or review, as specified by the plan.
