# Dark Factory

**ai-sdlc-helper** runs an AI-driven SDLC pipeline on your project with Claude Code agents: Spec, Plan, Red tests, Implement, Review and Ship, each stage checked before the next starts.

It works with the project's own language, test framework and database: it detects the test runner (Jest, Vitest, Mocha, node:test, or any runner that writes JUnit XML), reads `sdlc.config.json` for anything detection cannot know, and sets up a test framework for projects that have none.

> Early work: the command and the pipeline engine are here; the Claude Code plugin (slash commands, control pane, guard hooks) and the npm release come next. See [docs/PLAN.md](docs/PLAN.md).

## Requirements
- Node 18 or newer to run the tool. Your project may use any Node version: when it asks for another one (`.nvmrc`, `.node-version`, `.tool-versions`, `volta.node` or `engines.node`), its commands run through fnm, Volta, nvm or npx.
- git, and [Claude Code](https://claude.com/claude-code) (`claude` on PATH) for the pipeline.
- A code indexer is recommended, not required: [graft](https://www.npmjs.com/package/@nanonets/graft), graphify or your own. Without one the agents search with Grep and Glob.
- macOS or Linux. Windows is not tested yet: commands run through Git for Windows' `sh.exe` when it is installed, else `cmd.exe`, and `stop` uses `taskkill`.

## Install
Once it is published to npm:

```bash
npm i -g ai-sdlc-helper
```

Until then, pack it from GitHub and install the tarball (the `prepare` script builds `dist/` while packing), or install the tarball attached to a GitHub release:

```bash
npm pack github:imaimai86/ai-sdlc-helper && npm i -g ./ai-sdlc-helper-*.tgz
npm i -g <tarball URL from a GitHub release>
```

`npm i -g github:imaimai86/ai-sdlc-helper` does not work: npm (seen with 10.9) leaves a dangling global link for any git package with a `prepare` script. Installing from git into a project (`npm i github:imaimai86/ai-sdlc-helper`) works. How releases are made: [docs/RELEASING.md](docs/RELEASING.md); what changed: [CHANGELOG.md](CHANGELOG.md).

## Quick start
```bash
cd my-project
ai-sdlc-helper add                  # register the project: shows the settings, offers sdlc.config.json and a backlog index
ai-sdlc-helper doctor --run-tests   # check Node, git, claude, the settings, the code indexer, the backlog; run the tests once
```

Turn a bug report or feature request into a backlog item. A Claude agent reads the code, asks you what it cannot settle, and writes `Docs/backlog/<slug>/brief.md` and the line in `Docs/backlog/index.md` (`backlogDir` changes the folder); then the tool lists the new items and offers to commit them:

```bash
ai-sdlc-helper triage --report "Add a /health endpoint that reports the database status"
```

`--file <path>` reads the report from a file, `--print` runs the agent without questions (unknowns go under "Open questions" in the brief), and `--commit` commits without asking. You can also write the index line and the brief yourself:

```markdown
- [ ] `add-health-check` - Feature: a /health endpoint that reports the database status
```

Then run its pipeline in its own worktree and branch, and follow it:

```bash
ai-sdlc-helper start add-health-check
ai-sdlc-helper watch add-health-check --follow   # status.json, run state, changed files and the end of run.out
```

When a stage agent was refused an action (a command it may not run), the run pauses (exit 2) and `watch` shows it. Decide the refusals, then start the run again to resume:

```bash
ai-sdlc-helper permit add-health-check allow all   # or: always (also saves the rule), deny
ai-sdlc-helper start add-health-check
```

When the Spec stage has questions, the run pauses too: answer them on the `**Answer:**` lines of `Docs/backlog/<slug>/questions.md` (in the run's worktree) and start it again. `stop`, `restart`, `discard` and `status` control the runs; `changes <slug>` counts the files a run changed.

## The web app
Everything above can be done from a browser instead:

```bash
cd my-project
ai-sdlc-helper ui        # http://127.0.0.1:4477; prints a URL that signs the browser in, and opens it
```

The board shows the backlog and a column per stage, live; tick items and run them. A run's screen shows its stages with
model and effort, its output as it is written, the questions to answer and the refused actions to allow or deny, its
files and run record, and every control: start, resume, resume at a stage, restart, stop, discard. Model, effort and any
other variable (`SDLC_BASE`, `SDLC_LIMIT_RETRY` …) can be set for a run before it starts or resumes. New backlog items
are written in the page, projects are registered and checked there, and ⌘K / Ctrl-K runs any command of the tool.
Light, dark or the system's theme. Settings are read-only for now; editing them and the prompts comes next
([docs/web-ui.md](docs/web-ui.md)).

The server listens on 127.0.0.1 only and answers only the browser that opened its URL (a token, then a cookie);
requests naming another host or sent from another site are refused. Stopping it (Ctrl-C) never stops a run.

## Settings
`sdlc.config.json` at the project root; every setting is optional. `ai-sdlc-helper show` prints what the settings resolve to, and invalid settings are reported with the setting at fault. The test runs, for example:

```json
{
  "tests": { "retry": true, "maxWorkers": "auto" }
}
```

- `tests.retry`: run failed test files once more before a failure counts; tests that pass the second time are reported as flaky. Not set: the pipeline retries and `ai-sdlc-helper run` does not. `run --retry` and `--no-retry` override it.
- `tests.maxWorkers`: the Jest and Vitest worker limit: a number, `"auto"` (half the CPUs, at least 1) or `null` (the runner's own default; the default). It applies to every test run of the pipeline; `run --max-workers` overrides it. Mocha and node:test have no worker limit.

### The full suite in CI
- `tests.fullSuite`: where the full test suite runs, `"local"` (the default: nothing changes) or `"ci"` (GitHub Actions through `gh`). Override it with the personal `fullSuite` (next to `worktreeBase` and `maxParallel`) or `SDLC_FULL_SUITE=local|ci`. Precedence: environment, then personal, then project; an empty `SDLC_FULL_SUITE` counts as unset.
- `ci.waitMinutes`: how long Implement waits for CI on a pushed commit, a whole number of 1 or more (default 60). Overrides: personal `ciWaitMinutes`, then `SDLC_CI_WAIT_MINUTES`, with the same precedence.
- `tests.allowFailures`: failing tests that never block, in CI and in every local gate (project config only). Each entry is a test file or glob from the project root (`test/e2e/*.test.ts`: every test in it) or `<file> > <full test name>` (one test). An allowed failure gets a WARNING. An entry that matches one of the task's red tests is ignored for it, with a WARNING.

With `"ci"`, once Red tests passes its gate the branch is pushed to `origin` and a **draft PR** is opened against the base (always, whatever `createPr` says; an open PR for the branch is reused as it is). Local gates then run only the task's red test files (plus, in Implement, the test files of earlier CI side-effect failures) and `integration.cmd`. Each Implement attempt whose local gate passes is committed as `feat(<slug>): implement (attempt N)`, pushed, and **Implement waits until every check on that exact commit has finished** as success, skipped or neutral. Failed checks are classified: infrastructure (cancelled, timed out, startup failure, no test output), pre-existing (also failing at the merge-base with the base branch), allowed, flaky (passes when the failed jobs are re-run once) and side effects (the rest). Only side effects go back to the next attempt; the others are WARNINGs and lines in `<docs>/logs/ci-failures.md`. A wait longer than `ci.waitMinutes` pauses the run (exit 2): resume with `FROM=implement`, which waits on the same pushed head before any agent runs. Finalise pushes, marks the PR ready (`gh pr ready`) and opens no second PR.

If there is no `origin`, `gh` is missing or signed out, the push or PR fails, the PR is closed or merged, or no check shows up within 3 minutes of the first push, the run prints `CI unavailable (<reason>): running the full suite locally` and runs as with `"local"` from then on.

For test-level classification, have the workflow upload the runner's JSON report as an artifact named `sdlc-test-report` (without it, failures are classified per check):

```yaml
- run: npx vitest run --reporter=json --outputFile=sdlc-test-report.json
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: sdlc-test-report, path: sdlc-test-report.json }
```

### New dependencies
No stage before Implement installs anything, and a brief should never ask the developer to install a package first. The Plan stage confirms a new package's API from its published README and type definitions (WebFetch, WebSearch, context7 when installed, or `ai-sdlc-helper fetch <https-url>`, a GET-only read from the npm registry, unpkg, jsDelivr and GitHub; `AI_SDLC_HELPER_FETCH_HOSTS` replaces the host list) and lists exact versions in `plan-1.md`:

```markdown
## Dependencies
- runtime: pino@9.5.0
- dev: @types/pino@7.0.5
```

The pipeline installs them at the start of Implement, in the suite's package with its package manager and without install scripts (`SDLC_DEP_SCRIPTS=run` allows them). In a worktree, a `node_modules` linked to the main checkout is first replaced by the worktree's own install, so the main checkout's packages never change.

### Usage limits
When an agent's call ends because the account hit its usage limit (or a provider rate limit or quota), the run stops at once, the message names the reset time, and the agent is not run again. Resume it when the limit has reset: `ai-sdlc-helper pipeline <slug> --from <stage>`. To wait instead, set `SDLC_LIMIT_RETRY` to a number of seconds (default `0` = stop): the run then stays `running`, `status.json` carries a `note` such as `usage limit, resets 1:10am (Asia/Dubai)`, and the same agent runs again every `SDLC_LIMIT_RETRY` seconds for up to `SDLC_LIMIT_MAX_WAIT` seconds (default 21600, 6 hours); past that the stage fails. Only a real provider error counts: text in the agent's output or tool results that merely mentions a limit does not.

## Commands
The output of `ai-sdlc-helper help`:

<!-- help:start -->
```
Usage: ai-sdlc-helper <command> [dir] [options]

  detect [dir] [--json]            the test suites detection finds; writes nothing
  show [dir]                       the resolved settings (sdlc.config.json, then detection, then defaults) as JSON, with
                                   testRuns: the retry and worker limit the pipeline and run use
  layout [dir]                     test, source and backlog folders, test patterns and test command, as JSON
  node [dir]                       the Node the project's commands run with, and how
  suggest [dir] [--test-dir <folder>] [--language javascript|typescript] [--json]
                                   for a project without tests: the supported test frameworks, best first
  init-tests [dir] [--test-dir <folder>] [--language javascript|typescript] [--runner <name>] [--yes] [--dry-run] [--no-install]
                                   set up a test framework: confirm the language, pick a framework, apply the changes
  code-search [dir] [--list | --use <name|auto|none>]
                                   the code indexer the agents search with (graft, graphify, your own) or none
  skill <name> [dir]               a skill's text for this project
  fetch <https-url>                one GET request, the body on stdout: the web read stage agents may run (hosts:
                                   the npm registry, unpkg, jsDelivr, GitHub; AI_SDLC_HELPER_FETCH_HOSTS overrides)
  add [dir] [--name <name>] [--worktree-base <dir>] [--max-parallel <n>] [--yes]
                                   register a project (its git root): shows the settings, offers sdlc.config.json and a backlog index
  list [--json]                    the registered projects
  remove <name>                    forget a registered project (its files are kept)
  doctor [dir | --project <name>] [--run-tests]
                                   check what the pipeline needs: Node, git, claude, settings, code indexer, backlog
  run [dir] [--file <f>]... [--test <full name>]... [--suite <name>] [--out <result.json>] [--json]
      [--retry | --no-retry] [--max-workers <n|auto>] [--cwd <checkout>]
                                   run the tests (all suites, or those holding the files) and report one RunResult;
                                   --retry runs failed files once more, --max-workers limits jest/vitest workers
                                   (defaults: tests.retry and tests.maxWorkers in the settings);
                                   exit 0 passed, 1 failed, 3 no report
  parse-report jest|vitest|mocha|node-test|junit <report> [--root <dir>] [--stderr <file>]
                                   a runner's own report as RunResult tests and suiteErrors (JSON)
  testcheck <check> ...            Test repair checks (exit 1 with REJECT lines): precheck <now.json> <test-issues.md> <max>,
                                   diffcheck <red_sha> <test-issues.md>, namecheck <red.json> <now.json>,
                                   redcheck <red.json> <repaired.json>, claimed <test-issues.md>,
                                   unclaimed <now.json> <test-issues.md>, retry-plan [key]..., retry-args [key]...,
                                   merge-retry <now.json> <test-issues.md> <flaky.md> <retry.json>...,
                                   resumecheck <red_sha> <test-issues.md> <slug> [<lock_sha>]
                                   (keys come from stdin when none are given; the test layout from SDLC_TEST_DIRS,
                                   SDLC_KEY_DIR and SDLC_TEST_PATHSPECS, else from the settings)
  changes snapshot|mirror|changed <baseline.json>
  changes mark <stage-files.json> [stage]
                                   the files a cycle changed (run in the project): record, mirror .env keys, list, per stage
  permissions extract|args|mode|list|decide ...
                                   the actions stage agents were refused, and the rules their runs get
  permit <slug> allow|always|deny [n|all] [--project <name>]
                                   decide the actions a pipeline's agent was refused (in its run's worktree when it
                                   has one; always saves the rule in the main working tree); prints how many are still pending
  model path | list [--json] | get <provider> | remove <provider> | test <provider>/<model>
  model add <provider> --endpoint <url> --key-env <VAR> --models a,b [--effort]
  model add-model|remove-model <provider> <model>
                                   the user-level model registry (custom providers)
  backlog [status[,status...]] [--status <list>] [--json]
                                   the backlog items with their status
  start <slug> [--from <stage>] [--project <name>]
                                   start (or resume) the pipeline of a backlog item in its own worktree and branch;
                                   exit 3 too many running, 4 already running, 5 already merged
  stop <slug>                      interrupt a running pipeline and everything it started
  restart <slug> [--from <stage>] [--yes]
                                   stop, discard and start again from scratch (without --yes: show what goes, exit 6)
  discard <slug> [--yes] [--stop]  delete its worktree, branch and run record; the branch tip is saved first
  status [--json]                  one line per recorded run
  watch <slug> [--follow [seconds]]
                                   its status.json, run state, uncommitted files and the end of run.out;
                                   --follow refreshes (every 3 s) until the run ends
  changes <slug> [--json] | changes --all [<slug>...]
                                   files a pipeline changed in its worktree: "<changed> <uncommitted>", or JSON
  (stages: spec, plan, red-tests, implement, test-repair, review; the run commands take --project <name>)
  pipeline [slug] [--from spec|plan|red-tests|implement|test-repair|review] [--cwd <checkout>]
                                   run the SDLC pipeline for a backlog item (default: the first pending one) in the
                                   checkout (default: the current folder); FROM=<stage> in the environment works too.
                                   Exit 0 shipped, 1 failed, 2 paused (questions to answer, refused actions to decide)
  triage [dir] [--report "<text>" | --file <path>] [--print] [--commit] [--model <model>]
                                   turn a report (a bug, a feature request, an error) into backlog items: a Claude agent
                                   reads the code, asks what it cannot settle, and writes <backlog>/<slug>/brief.md and
                                   the index line; then the new items are listed and, on a yes or --commit, committed on
                                   the current branch (never pushed). --print runs the agent headless (no questions:
                                   unknowns go under "Open questions"), also when there is no terminal
  ui [--port <n>] [--no-open]      the local web app on 127.0.0.1 (default port 4477, the next free one if taken): the
                                   board, runs, questions, refused actions, backlog and settings; prints its URL and
                                   opens it unless --no-open. Runs go on when it stops (Ctrl-C).
  help, --help, --version
```
<!-- help:end -->

## Development
```bash
npm ci
npm run check
npm run build
```

To follow work on several branches at once, see [docs/watching.md](docs/watching.md).

MIT licensed.
