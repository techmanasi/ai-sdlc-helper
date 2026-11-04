# Plan: ai-sdlc-helper

Goal: an SDLC pipeline (Spec, Plan, Red tests, Implement, Review, Ship) and its control pane that any Claude Code user
can install, independent of the project's language, database and test framework. Phases 1 to 3 were built inside
`imaimai86/production-retail-and-wholesale` (branch `sdlc-as-package`, as Bash and CommonJS scripts); from phase 4 the
work lives here, in TypeScript.

## What we ship

| Piece | Install | Contains |
|---|---|---|
| **`ai-sdlc-helper` npm package** (the engine) | `npm i -g ai-sdlc-helper` | The `ai-sdlc-helper` command, pipeline engine, test runner adapters, project and model registries, default prompts and skills |
| **Claude Code plugin** (the interface) | `/plugin marketplace add imaimai86/ai-sdlc-helper` | Slash commands, the control pane, the guard hooks, and the working rules as a skill |

The plugin is thin: every action calls the command. It checks at SessionStart that a compatible version is installed.

## Decisions

1. **Settings:** `sdlc.config.json` in the project (committed), then detection, then defaults; a user-level registry
   (`~/.config/ai-sdlc-helper/`) for project paths, personal overrides and models.
2. **Name (2026-10-16):** `ai-sdlc-helper` for both the npm package and the command; repo `imaimai86/ai-sdlc-helper`.
3. **Language:** TypeScript from the start (ES modules, `tsc` to `dist/`). Tests with Vitest; lint with ESLint.
4. **First release:** Node/TypeScript projects (jest, vitest, mocha, node:test) plus `generic-junit` for any runner that
   writes JUnit XML. Python, Go and the rest after launch.
5. **Code indexing:** recommended, not required. graft and graphify are built in, projects can declare others
   (`agent.codeIndexers`); `agent.codeSearch` picks one, `auto` (first available) or `none` (Grep and Glob). Skills and
   prompts that search code have a version per indexer, picked by what is available.
6. **Node versions (2026-10-16):** the tool needs Node 18 or newer (`engines`, CI on 18/20/22/24, `@types/node@18`).
   Projects may use any Node version: the Node a project asks for (`.nvmrc`, `.node-version`, `.tool-versions`,
   `volta.node`, `engines.node`) runs its test and lint commands through fnm, Volta, nvm or npx (`node` setting:
   `version` auto|current|X, `manager` auto|fnm|volta|nvm|npx|none). Test framework suggestions follow the lowest Node
   the project allows (below 18: no Vitest or node:test, Jest 29 and Mocha 10 pinned; below 14: none).
7. **Dev-only Dependabot alerts (2026-10-18):** the alerts in vitest/tinypool are dismissed as dev-only; the fixed
   versions need Node 20 or newer. Revisit when Node 18 support is dropped.
8. **Test runs (2026-10-18):** one `tests` block for the whole project (`retry`, `maxWorkers`), not per suite: both are
   about the machine and the pipeline's load, and the worker limit only applies to Jest and Vitest. Not set, the
   pipeline gates retry a failure once and `ai-sdlc-helper run` does not (an agent checking one file wants the first
   outcome at once).
9. **Shells (2026-10-18):** every command line goes through `src/shell.ts`: `sh -c` (or `bash -c`) on macOS and Linux
   as before; on Windows Git for Windows' `sh.exe`/`bash.exe` when found, else `cmd.exe`. Programs are found by
   walking PATH (with PATHEXT on Windows) instead of `command -v`; `stop` uses `taskkill /T /F` on Windows.

## Phases

1. **Settings and detection** (done, in production-retail-and-wholesale).
2. **Runner adapters and one result format** (done there): every run produces `{ ok, exitCode, command, tests, suiteErrors }`.
3. **No hard-coded paths** (done there): the pipeline, guard, prompts and slash commands read the settings.
4. **This repo, in TypeScript.** One pull request per part, each leaving `main` working:
   1. Done (#1): scaffold, settings, detection, Node versions, test framework set-up, code search, skills; commands
      `detect`, `show`, `layout`, `node`, `suggest`, `init-tests`, `code-search`, `skill`. CI on Node 18, 20, 22 and 24.
   2. Done (#4): runner adapters and the test checks (`testcheck`: diff, resume and retry checks, test locking).
   3. Done (#5): changes, permissions, the model registry and the backlog listing.
   4. Done (#7): the pipeline engine (`sdlc.sh` and `sdlc-ship.sh` in TypeScript): stages, prompts, agent runs, resume.
   5. Done (#2, #6): the project registry (`add`, `list`, `remove`, `doctor`; #2), and worktrees and run controls
      (`sdlc-mod.sh` in TypeScript: `start`, `stop`, `restart`, `discard`, `status`, `watch`, `changes`; #6). The guide
      to watching several worktrees came with #3.
   6. Pending, after one real pipeline run with the package: production-retail-and-wholesale switches to the package
      and drops its copies of the scripts.
   Follow-ups (test run settings, Windows shells, test pool limit, README): `feat/followups`.
5. **Plugin and marketplace.** Commands, pane and hooks move here; `/sdlc-init`; the rules skill;
   `.claude-plugin/marketplace.json`. Move the pane from production-retail-and-wholesale `main` at 33a2934 or later, so it
   includes its #98 (a paused run with nothing to decide offers Resume at its stage; a run failed at Plan or Red tests
   resumes there), #99 (the `Implement · waiting: usage limit, resets …` line, paused-state descriptions, Show claim for
   Test repair) and #100 (the "Action needed" banner for paused pipelines, in the pane and above the prompt).
6. **End-to-end checks.** Sample projects (Node + Jest, TypeScript + Vitest, Node + Mocha, a JUnit-only project) run
   the whole pipeline in CI with a recorded stand-in for `claude`; one real run per release.
7. **Local web app.** `ai-sdlc-helper ui`: the whole pipeline from a browser, with a Settings tab down to each stage's
   prompt, in three phases; see [web-ui.md](web-ui.md).
8. **Release.** npm publish with provenance, GitHub release, README, semver, CHANGELOG; the plugin declares the
   versions it supports. Optionally a self-contained binary that needs no Node install, built with Node's
   single-executable apps or `bun build --compile`.

### Ported from production-retail-and-wholesale `main` (2026-10-19)
Its PRs merged after `sdlc-as-package` branched (#92, #94, #97–#100), applied here:
- #94 (never signal pid 0 or a finished run's pid): already in `src/runs` (`alive` takes positive pids only; stop and
  discard signal only a record in state running).
- #97: Plan gets WebFetch, WebSearch and mcp__context7; every stage gets read-only commands (`READ_ONLY_COMMANDS`) and
  the GET-only `ai-sdlc-helper fetch` (replacing `sdlc-fetch.sh`); Implement installs the plan's exact `## Dependencies`
  first (`src/pipeline/deps.ts`, any package manager, the suite's package); prompts and skills state the rule.
- #98: a Test repair claim citing the plan is justified; `SDLC_BASE` was already kept out of the pipeline; a refused
  command line is named by its first part no allow rule covers, and is not asked again once allowed.
- #99: a usage limit is waited out (`SDLC_LIMIT_RETRY`, `SDLC_LIMIT_MAX_WAIT`) with a `note` in status.json.
- `changes mark` credits a stage with an earlier stage's file it changed and committed.
- #92 (husky lint in that repo) and the pane parts of #98–#100 (phase 5) are not code in this package.

## Still open

- **Windows is untested.** The shell and lookup helpers are unit-tested with the platform injected, never on Windows.
  Without a POSIX shell (no Git for Windows), command lines run in `cmd.exe`, where the runner adapters' single-quoted
  arguments and the Node switch (`fnm exec -- sh -c ...`, nvm through bash) do not work; the run controls' detached
  supervisor and `taskkill` have not been tried. CI runs on Linux only.
- **Global install from GitHub:** `npm i -g github:imaimai86/ai-sdlc-helper` leaves a dangling global link (an npm
  bug with git packages that have a `prepare` script, seen with npm 10.9); until the npm release, `npm pack` from
  GitHub and install the tarball, or install a GitHub release's tarball (see README.md and docs/RELEASING.md).
- **One real run** of the TypeScript pipeline on a real project before part 6.
- **Detached triage and palette jobs:** see docs/plans/detached-jobs.md (built on the research in
  docs/plans/process-isolation-research.md).

## To build in (found by running the scripts on real projects)

From a real agent run (`add-db-health-check`, 2026-10-16):
- **Resume reads a stale `tests.log`:** a resumed run must not trust the previous run's test log; rerun or discard it.
- **One test file for agents:** give the stage agents a command that runs a single test file (the adapter's file
  filter), so they do not run the whole suite to check one change.
- **Full suite flaky under load:** load-sensitive timeouts; run the suite with limited workers in the pipeline and
  retry a failure once before calling it real. (Done: the gates retry, and `tests.maxWorkers` limits the workers.)
- **Discard must use the run record's worktree path,** not a path rebuilt from the current settings.

From trying detection and `init-tests` on other projects:
- Expo projects (`jest-expo` preset) should be detected as Jest.
- JavaScript folders without a `package.json` are reported, not ignored silently.
- Mention existing test files found outside any runner's patterns.
- Offer the `__tests__` folder convention when the project already uses it.
- Label CommonJS projects as such in the project summary (not only "not ES modules").
