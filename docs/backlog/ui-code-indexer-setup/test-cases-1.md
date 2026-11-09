# Code indexer setup test matrix

| Area | Scenario and expected result | Coverage |
| --- | --- | --- |
| Status | No executable or index: auto falls back with a warning; graft is buildable, graphify is interactive only. | `test/config/code-search-status.test.ts` |
| Status | Executable appears, then index is created: installation and indexing are independent; auto resolves to graft. None suppresses the warning. | `test/config/code-search-status.test.ts` |
| Custom | A valid custom build command passes settings validation, is exposed as buildable and splits into a program and arguments. Shell metacharacters are rejected. | `test/config/code-search-status.test.ts` |
| GET | Status reflects changing PATH and index state; unknown project returns 404. | `web/test/code-search-setup.test.ts` |
| Save | Auto and none persist without a build and preserve unrelated settings. | `web/test/code-search-setup.test.ts` |
| Build | Graft runs in the project root, captures output, creates the index, saves the selection and becomes effective. | `web/test/code-search-setup.test.ts` |
| Failure | Nonzero exit and timeout return build details and leave configuration unchanged. | `web/test/code-search-setup.test.ts` |
| Validation | Missing, invalid, unknown and unsupported requests, missing binary, and interactive graphify build are rejected; malformed configuration remains intact. | `web/test/code-search-setup.test.ts` |
| Doctor | Successful build makes the doctor check green on refresh. | Review / manual integration check |
| UI | Doctor button visibility and refresh; Settings status, warning and setup/configure labels; modal options, badges, install hints, refresh, use/rebuild/save actions, build progress and dismissal lock, errors and retry. | Review / manual UI check; no component harness is planned |
| Documentation | Review web UI workflow, routes, timeout, graphify instructions and custom `buildCommand` documentation. | Review |
| Test authoring | Verify tests execute feature code, do not inspect test or documentation text, and follow the permitted file paths and mocking conventions. | Review |
| Build | Run UI typecheck and web build after implementation. | Implementation validation |
