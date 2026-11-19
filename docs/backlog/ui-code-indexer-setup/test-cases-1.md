# Code indexer setup test matrix

The plan and decisions Q6–Q8 define executable builds through `buildArgv`, include the resolved index path in inspection, and allow selection of an installed indexer that has no index path.

## Automated cases

| Test file | Fixture and action | Expected observation |
| --- | --- | --- |
| `test/code-search.test.ts` | Inspect a moved Graft directory with only Graphify installed, then with Graft installed | Default setting is auto. Disk and PATH independently determine the badges. Effective selection changes from none to Graft. Graphify exposes manual instructions. |
| Same | Select an installed custom tool without an index path or instructions | Current equals the tool, indexed is false, absent fields are null. |
| Same | Replace Graft display text with and without argv, remove either executable from PATH | A replacement can build only with explicit argv and both programs installed. An unrelated path override retains the default build. |
| Same | Resolve settings with a future builder, then empty, malformed, non-string or NUL-containing argv | Valid literal arguments are accepted ahead of installation. Invalid declarations report a buildArgv error. |
| `web/test/code-search-route.test.ts` | Inspect with a token, then omit credentials or submit with foreign Origin or wrong content type | Valid inspection returns the configured and effective choices and indexer statuses. Guards return 401, 403 or 415 and preserve settings. |
| Same | Build Graft twice using a logging executable | Both runs receive exactly the build argument, project cwd and server environment. Output, passing doctor check, sibling setting and refreshed inspection reflect success. |
| Same | Build a custom tool with a separate builder and arguments containing spaces, a variable and a wildcard | The builder receives the original argument vector unchanged. |
| Same | Configure a stale selection with build false, or omit build on a project without a config | Save or create config without invoking the executable or returning build output. |
| Same | Submit missing or malformed fields, unknown or inherited names, missing Graft, or installed manual Graphify | HTTP 400 and a diagnostic, no configuration change. |
| Same | Request build with malformed JSON on disk or invalid prospective settings | HTTP 400 before spawning and original bytes preserved. |
| Same | Real builder emits on both streams and exits 7, then retry with a working executable | Both diagnostics and exit status reach the caller, config bytes survive failure, retry succeeds. |
| Same | Fire the production 120-second timer after a resistant child reports its PID | Timeout response, terminated child and unchanged config. |
| Same | Hold a real child open, attempt another setup, edit settings and release child | Concurrent save rejected, original request reports conflict and retains build output, external edit survives. Later setup and inspection succeed. |
| `web/test/code-search-api.test.ts` | Read, configure and build for a project whose name contains a space and slash through a stub Fetch transport | Encoded project segment, correct verbs and boolean bodies, decoded inspection and results. A failed POST throws ApiError with message and process output. |

## Browser acceptance after implementation

Use the built UI and `sdlcUI.snapshot()` with actions scoped to the owning row, banner, dialog or card. Use temporary project indexers and disposable config for build and failure scenarios.

| Screen and action | Expected observation |
| --- | --- |
| Projects, open Doctor with a failing code indexer, with and without fix text | Inline Setup Code Indexer opens the selected project's dialog. Healthy rows and unrelated failures have no setup action. |
| Complete setup from Doctor | Returned check turns green immediately and stays visible during refresh. Modal closes, success is announced and focus reaches Run doctor again when the trigger disappears. |
| Settings, inspect healthy state, unrelated warning and code-search warning | Header Code Search opens setup in every state. Only the matching warning offers inline setup. Successful setup refreshes raw config, warnings and resolved values. |
| Open and switch projects while inspection or settings refresh is pending | Modal title, configured/current values, selected badge and cards reflect the current project. A late previous-project response cannot replace them. |
| Open a missing-binary card for each built-in | PATH and disk statuses shown independently. Actions disabled. Copy supplies only the relevant installation command. |
| Inspect installed indexed Graft, unindexed Graft and a custom tool without an index path | Indexed card shows actual path, Use and Rebuild. Unindexed card offers Build. Pathless tool shows No index required, Use and Rebuild if executable. |
| Open installed unindexed Graphify, copy its instruction, create its index externally and refresh | Clipboard contains `/graphify .`; Claude Code context visible. Build and Configure initially disabled. Refresh enables configure without building. Already-indexed Graphify offers Use on opening. |
| Hold build open, dismiss, reopen, then release | Announced busy state, disabled action and copy buttons, one request and one owning-view refresh. Failure shows diagnostic and scrollable preformatted process output and permits retry. |
| Open from each trigger, navigate forward/backward by keyboard and dismiss by Escape, Close and backdrop | Named modal dialog, aria-modal true, focus enters, wraps both ways and returns to trigger or stable fallback. Clicking inside leaves the dialog open. |

## Review and verification

- Review README coverage of both entry points, configure versus rebuild, manual Graphify and a custom argv example. Review test-file scope, unique row names and behavioral assertions directly.
- After implementation run the existing selector-integrity test, typecheck and web build. Capture the changed Doctor, Settings and dialog screens for the PR. Full suite runs in CI.
