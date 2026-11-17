# Decisions for ui-code-indexer-setup

## Round 1 (2026-11-14)

### Q1: Configuration changes on failure
Should setup save `agent.codeSearch` before building or only after a successful build, and what should happen when the build succeeds but saving configuration fails? This determines whether a failed setup can replace a previously working selection and when the UI may report success.
**Suggested:** Validate configuration before starting; reject malformed or unreadable existing configuration without overwriting it, and allow creation when absent. Save the selection only after the build exits successfully and the selected indexer passes the existing availability check. Preserve unrelated configuration. On build or verification failure, keep the previous selection; on save failure, report that the index was built but configuration was not saved. Leave generated index files in place and report success only after both build verification and persistence succeed.
**Answer:** accept

### Q2: Supported indexer definitions
Should the UI and setup endpoint support only `graft` and `graphify`, or also custom entries returned by `codeIndexers(...)`, and should project overrides of built-in definitions control execution? The existing helper merges project definitions, so reusing it can change the commands and paths used by setup.
**Suggested:** Offer only `graft` and `graphify` in this feature, using their effective definitions from `codeIndexers(...)`, including project overrides. Show any other configured selection as current status without offering it for setup. Accept only one of those two names in setup requests, resolve its command server-side, and reject setup when its binary is unavailable or its build command is missing; display its setup instructions instead. Do not accept commands from the request or install packages automatically.
**Answer:** accept

### Q3: Selecting an existing index
When the selected indexer is installed and already indexed, should the action rebuild it or only change configuration? Settings explicitly supports switching indexers, but the brief describes the action as Build Index or Configure & Build, leaving this case unclear.
**Suggested:** Always run the selected indexer's defined build command when the user invokes Configure & Build, including when its index already exists, then persist the selection after successful verification. Provide no separate configure-only or destructive clean-index action in this feature.
**Answer:** accept

### Q4: Doctor action visibility
Should Doctor offer setup when `agent.codeSearch` is explicitly `none`, or when the active indexer is healthy but the other indexer is missing? Existing behavior treats an explicit `none` as healthy, while the brief says to show setup when an indexer is missing or unindexed.
**Suggested:** Show the Doctor setup action only when its code-indexer check advises action; keep explicit `none` healthy and do not show a warning or setup action merely because an unused indexer is unavailable. Always expose the Settings setup action so users can switch a healthy selection or enable indexing after choosing `none`.
**Answer:** accept

### Q5: Build lifecycle and feedback
What should happen if the user closes the modal or navigates away during a build, submits another setup request for the same project, or the build hangs? The brief permits asynchronous execution or loading feedback but does not define these observable behaviors.
**Suggested:** Run builds without blocking other dashboard operations, show an in-progress indicator, and reject overlapping setup requests for the same project. Allow closing or navigating away without cancelling the build; reopening the modal shows the current operation and its final result while the server remains running. Stop the build after 10 minutes and report a timeout. Show an actionable failure message with bounded command output and allow retry after completion; live streaming, user cancellation, and recovery of operations across server restarts are out of scope.
**Answer:** accept

## Round 2 (2026-11-17)

### Q1: How does the server run graphify's build?
The built-in `graphify` definition's `build` field (`src/config/codeSearch.ts:33`) is the prose `build the graph with /graphify . in Claude Code`, not a runnable command (only `graft build` is). Spawning it would fail every time, so Scenario 5-style success is impossible for graphify as specified. Decisions Q2 says to use the effective `build` definition and Q3 says to always run it. The choice affects the built-in definition, the executable check and the UI.
**Suggested:** Treat `build` as runnable only when it is a plain command line (words split on whitespace, no shell, first word is the indexer's `command`). For `graphify` keep the prose as it is, so the setup endpoint returns 400 `graphify has no build command defined` with its setup text, and the modal shows graphify as selectable but with `Configure & Build` disabled and the instruction `/graphify .` in Claude Code. Only `graft` can be built from the UI in this feature. No change to `CODE_INDEXERS`.
**Answer:** accept

### Q2: How is the build command string executed?
`build` is a single string (e.g. `graft build`, or a project override). Spawning it needs either a shell (`spawn(build, {shell:true})`, which runs whatever a project's `sdlc.config.json` says, with shell metacharacters) or splitting it into program and arguments. The existing `PROGRAM` check in `codeSearch.ts` only allows a bare program name for `command`.
**Suggested:** No shell. Split `build` on whitespace into `[program, ...args]`, require `program` to equal the indexer's `command` (which already passes the `PROGRAM` check and `onPath`), and reject any `build` with shell metacharacters (`; & | < > $ \` ( ) " '`) as "has no runnable build command". Spawn with `spawn(program, args, { cwd: root, env, stdio: ['ignore','pipe','pipe'] })`.
**Answer:** accept
