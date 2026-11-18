# Test matrix: fix-loop red gate

| Scenario | Expected result | Coverage |
| --- | --- | --- |
| Missing-test passes now and fails at original Red commit | Commit and lock tests; record accepted files and skip Implement and Test repair; continue Review | `test/fix-loop-red-gate-kind.test.ts` |
| Test passes at both commits | Stop with test name and open finding, without Plan recovery | `test/fix-loop-red-gate-kind.test.ts` |
| Blocker has no failing current test | Stop naming the blocker | `test/fix-loop-red-gate-kind.test.ts` |
| Mixed blocker and missing-test results | Accept both and run Implement | `test/fix-loop-red-gate-kind.test.ts` |
| Fix-loop gate errors | Diagnose findings, offer Red tests, point to tests.log, no escape hatch | `test/fix-loop-red-gate-kind.test.ts` |
| Existing initial red gate | Passing tests still point to Plan | `test/hints.test.ts` and existing pipeline tests |
| Restoring findings | Restore active rounds and retain other prompt context; do not restore final or absent rounds | `test/fix-loop-red-gate-kind.test.ts` |
| Loop limit across starts | A previously recorded loop prevents a second fix cycle at the configured limit | `test/fix-loop-red-gate-kind.test.ts` |
| Restart from Spec or Plan | Archive history and reset the loop count | Additional coverage needed |
| Resume at Red tests after a fix-loop stop | Restore findings, retain implementation commits and skip Implement when appropriate | `test/fix-loop-red-gate-kind.test.ts` |
| No new tests, blocker-only failing test and discard reset | Preserve stop, normal Implement and clean history respectively | Additional coverage needed |

Review items: inspect documentation changes in `docs/PLAN.md` and `CHANGELOG.md`; confirm `decisions.md` is not modified for a skip. Review test code for compliance with the test-file and documentation inspection restrictions; these are not automated test requirements.
