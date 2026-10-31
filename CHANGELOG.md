# Changelog

All notable changes to `ai-sdlc-helper` are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is below 1.0.0, a minor version may
change commands or settings in ways that are not backward compatible.

The release workflow publishes the section whose heading matches the tag (`## [0.1.0]` for `v0.1.0`) as the GitHub
release notes. Keep new work under `## [Unreleased]`, and rename that heading to the version before tagging.

## [Unreleased]

## [0.1.1] - 2026-11-01

### Fixed

- **UI performance & mobile hotspot load times.** Eliminated synchronous `gh pr view` network calls from the board polling loop, added a 60-second in-memory TTL cache for PR status lookups, and made Google Fonts non-blocking so the web UI renders instantly offline and on cellular connections.

## [0.1.0] - 2026-11-01

The first release: the SDLC pipeline rewritten in TypeScript as a CLI and web app that works on any Node or TypeScript project, with guaranteed forward progress and zero dead-ends.

### Added

- **Node.js & TypeScript Zero Dead-End Recovery System.** Guaranteed forward progress across all 7 pipeline stages
  (Spec, Plan, Red tests, Implement, Test repair, Review, Finalise). Every pause, refusal, or failure produces a
  structured diagnosis and 3 actionable resolution paths: Autonomous (1-click / flag fix), Human-in-the-Loop (guided
  pointers to questions.md, test-issues.md, etc.), and Escape Hatch (stage rewinds, bypasses, or git checkpoint recovery).
- **Web UI Stage Recovery Action Card.** Displays high-visibility diagnostics on paused, failed, or refused runs with
  one-click resolution buttons, file inspection links, and bailout controls.
- **The web app: `ai-sdlc-helper ui`.** A local server (127.0.0.1, token-protected) and a browser app to run the whole
  pipeline without the terminal: a live board, runs with their questions, refused actions, output and files, start,
  resume, restart, stop and discard, per-run environment (model and effort per stage), new backlog items, projects and
  doctor, a command palette, light and dark themes. It lives in `web/` and uses the engine only through its public entry.
- **`runView`, `boardView`, `answerQuestions`, `addBacklogItem`** in the library, for monitors of the pipeline.
- **`ai-sdlc-helper triage`** turns a report into backlog items: a Claude agent follows the shipped triage prompt
  (interactive, so it can ask; or headless with `--print`), writes each `brief.md` and index line, and the tool lists
  the new items and commits exactly those files on the current branch when asked (`--commit`). It never pushes.
- **New dependencies are installed by the pipeline.** The Plan stage may read a library's published docs (WebFetch,
  WebSearch, context7, or the new `ai-sdlc-helper fetch <https-url>`, a GET-only read from package-doc hosts) and
  lists exact versions under `## Dependencies` in the plan; Implement installs them first, without install scripts.
- **Usage limits are waited out.** An agent that hits the account's usage limit runs again after the reset
  (`SDLC_LIMIT_RETRY`, `SDLC_LIMIT_MAX_WAIT`); `status.json` has a `note` meanwhile.
- **Read-only commands for every stage agent** (`cat`, `grep`, `git show`, `npm view` and the like), so harmless reads
  are not refused.

### Fixed

- The run logs (`<backlog>/<slug>/logs/`) are never committed and never show in `git status`: the folder ignores
  itself. A project without its own ignore entry had them in the Red tests and feature commits.
- A refused `npm run <script>` (and pnpm, yarn, bun `run`/`exec`) asks for a rule naming that script, not one that
  allows every script.
- `status` and `changes --all` list only this project's runs; the run registry is shared by every checkout of the
  repository.
- When graft (or graphify) is installed but the project has no index yet, the warning says to build the index, not
  to install the tool.
- The run controls work on the checkout they are run in. A project that is one worktree of a bigger repository
  used the main working tree's settings (its `git.base`, backlog and links were ignored, so runs started from the wrong
  branch); saved permission rules went there too. A command run inside a pipeline's own worktree still maps back to the
  checkout that started it (recorded as `root` in the run record).
- The shipped `triage` and `sdlc` skills no longer refer to production-retail's scripts (`scripts/sdlc.sh`,
  `sdlc-mod.sh`, `Engineering/bugs.md`) or its API conventions, and triage no longer pushes a branch itself.
- A Test repair claim that cites the plan is accepted.
- A refused command line such as `cd x; sed …` asks for the rule of the part that was not allowed (`sed`), not an
  allowed one, and is not asked again once allowed.
- The files per stage credit a stage with an earlier stage's file that it changed and committed.
- **Settings and detection** (#1). The `ai-sdlc-helper` command reads `sdlc.config.json` from your project, then
  detects what it can, then falls back to defaults. It finds Jest, Vitest, Mocha, node:test and any runner that writes
  JUnit XML (`generic-junit`), with their test files and test command.
  - `detect`, `show`, `layout` and `node` show what was found and the resolved settings.
  - `suggest` and `init-tests` set up a test framework for a project that has none, picked to fit the lowest Node
    version the project allows.
  - When the project asks for its own Node version (`.nvmrc`, `.node-version`, `.tool-versions`, `volta.node`,
    `engines.node`), its commands run through fnm, Volta, nvm or npx.
  - `code-search` picks the code indexer the agents search with (graft, graphify, your own, or none), and `skill`
    prints a skill's text for your project.
- **Project registry** (#2). `add`, `list`, `remove` and `doctor` keep a list of your projects in
  `~/.config/ai-sdlc-helper/` (`%APPDATA%` on Windows) and check that a project has what the pipeline needs.
- **Guide to watching several worktrees** (#3), with how to install `watch` on each operating system.
- **Test runs and test checks** (#4). `run` runs a suite, or a single test file with `--file`, and writes one result
  format for every runner; `parse-report` reads JUnit XML; `testcheck` holds the checks the pipeline uses between
  stages (test diffs, test locking, resume and retry). An opt-in guard for flaky suites reruns failed files once and
  limits workers.
- **Changes, permissions, models and backlog** (#5). `changes` lists what a run changed; `permissions` and `permit`
  decide the actions a stage agent was refused; `model` manages your providers and models in
  `~/.config/ai-sdlc-helper/models.json` (an existing `sdlc/models.json` is still read); `backlog` lists the backlog
  by status.
- **Run controls** (#6). Each backlog item's pipeline runs in its own git worktree and branch, with `start`, `stop`,
  `restart`, `discard`, `status`, `watch` (`--follow`) and `changes`, and a cap on how many run at once.
- **The pipeline** (#7). `pipeline [slug]` runs Spec, Plan, Red tests, Implement, Test repair, Review and Ship with
  Claude Code agents, pausing for your answers to Spec and Plan questions and resuming with `--from <stage>`.
  - A resumed run never trusts the previous run's test log.
  - Agents get a command that runs one test file, so they do not run the whole suite for each change.
  - The gates retry a failing suite once and report tests that look flaky.
- A library entry point (`import { detect, resolve } from 'ai-sdlc-helper'`) for settings, detection, test framework
  set-up and code search.

[Unreleased]: https://github.com/techmanasi/ai-sdlc-helper/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/techmanasi/ai-sdlc-helper/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/techmanasi/ai-sdlc-helper/releases/tag/v0.1.0
