# Code indexer setup test matrix

| Area | Scenario and expected result | Coverage |
|---|---|---|
| Inspection | GET reports configured and active engines, only supported indexers, installed/indexed/runnable flags, instructions, and idle operation; unknown project returns 404. Overrides and custom configured names are reflected. | `web/test/code-search-setup.test.ts`: basic status and unknown project; review override/custom cases |
| Build command | Accept executable plus whitespace-delimited arguments; reject blank, mismatched executable, prose, and shell metacharacters. | `test/config/code-search-build.test.ts` |
| Validation | Reject missing/custom selection, missing binary, malformed config, missing/unsafe build, without launching a process; report setup guidance. | Route tests cover rejection and unchanged malformed config; review error detail and missing-build variants |
| Success | Return 202 promptly; verify generated index, preserve other config keys, write formatted JSON, and refresh Doctor to healthy. Create a missing config. Rebuild an existing index. | Route tests cover persistence, Doctor and creation; review already-indexed rebuild |
| Failure | Nonzero exit retains config and reports output; zero exit without index fails verification; generated files remain. | Route tests cover exit and verification; review intermediate-file preservation |
| Concurrency and timeout | A second build for a running project gets 409; GET reports running; timeout terminates the process and remains timeout after close. Other projects remain independent. | Route tests cover conflict and timeout; review termination escalation and cross-project isolation |
| Save failure | A verified index remains when saving config fails; operation reports the explicit save failure. | Review or platform-specific integration test; chmod behavior varies by privileges |
| Process and output | Spawn asynchronously with project cwd, inherited environment, and no shell; cap combined output to 100 lines and 32 KB; surface spawn errors. | Review and targeted integration testing |
| Doctor UI | Action appears only on the failing code indexer row; healthy and `none` suppress it. Opening and closing a successful setup refreshes Doctor. | UI review / interactive verification |
| Settings UI | Action is always available, including `none` and healthy configurations; opening and completing setup refreshes settings. | UI review / interactive verification |
| Modal | Loading, configured/active status, indexer descriptions, installed/indexed status, instructions, selection and disabled rules reflect inspection. Submit selected indexer; show progress and poll. | UI review / interactive verification |
| Modal lifecycle | Closing during a build leaves it running; reopening restores running or completed status. Success closes with refresh; failure shows output and supports retry and close; API errors remain visible. | UI review / interactive verification |
| Documentation | Review README endpoint and setup guidance, timeout, graphify manual workflow, and Settings comment. | Review only |
| Test constraints | Review tests for real code execution, no test-file or documentation text assertions, allowed paths, and lint compliance. | Review only |

## Review round 1 regression matrix

| Finding | Expected behavior | Coverage |
|---|---|---|
| Oversized output | A multi-megabyte unterminated or newline-terminated line is retained within 32 KB in the final HTTP response; the rolling buffer must also remain bounded during execution. | `web/test/code-indexer-findings.test.ts`: both final-output forms through the setup engine; inspect in-flight memory and HTTP serialization in review. |
| Concurrent configuration edits | Re-read configuration after a verified build, retaining edits or a file created while it ran; malformed current configuration causes a save failure and is preserved. | `web/test/code-indexer-findings.test.ts`: edited, created, and malformed configurations. |
| Timeout and exclusion | A SIGTERM-ignoring child cannot overlap another build during the grace period and is killed after it. Descendant workers, including workers holding output pipes after their parent exits, must also terminate. | `web/test/code-indexer-findings.test.ts`: guard and direct child escalation; descendant process cases require further integration coverage. |
| Dismissed modal | A successful operation first observed on reopening requests a parent refresh; running and failed operations alone do not. The component must use the helper and refresh Doctor and Settings. | `web/test/code-indexer-findings.test.ts`: helper contract; component integration and UI behavior require review / interactive verification. |

The existing route and build-command tests remain intact. They cover core API paths but do not establish the UI rendering and lifecycle cases above; review those and the remaining gaps identified in the original matrix. Documentation and constraints on the tests themselves are review items, not automated assertions.
