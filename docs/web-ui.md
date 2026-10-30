# Plan: the local web app

Goal: a developer can run every part of the pipeline (register a project, write backlog items, start, follow, answer,
permit, resume, stop, discard, configure) from a browser, without the terminal. Settings, down to each stage's prompt,
can be changed from a Settings tab. It ships in phases; phase 1 is the smallest app that covers a whole pipeline run.

The web app sits beside the command and the Claude Code plugin (phase 5 of [PLAN.md](PLAN.md)). All three go through the
same engine, so a run started in one shows up in the others.

## Where the features come from

The Claude Code mod in `imaimai86/production-retail-and-wholesale` (`.claude/plugins/sdlc-monitor/hooks/register.tsx`,
PRs #69, #79, #81, #83, #86, #100) is the reference. What it does today, and where each part lands here:

| Mod feature | Source | Web app phase |
|---|---|---|
| Board: pending items and one column per stage (Spec … Review, Commit), a card per run with its state glyph | `boardView` | 1 |
| Tick pending items, **Run selected**; items past the parallel cap wait in a queue that drains as runs end | `runSelected`, `drainQueue` (cap 2) | 1 (queue in 2) |
| Pending item screen: type, priority, title, `brief.md`, **Start** | run view, not-started branch | 1 |
| Run screen: stage strip with each stage's state and `model · effort`, current agent and its clock, the `note` (usage limit wait) | `stageStates`, `stageModel`, `stateLine` | 1 |
| Files changed since base and uncommitted; tests passed and failing | `loadChanges`, `testCounts` | 1 |
| Files changed per stage (8 shown, then "+N more") | `parseStageFiles` | 1 |
| Recent output (end of `run.out`) | `tail` | 1 (live stream) |
| Failure reason box (end of the failed stage's log) with **Copy** | `failureReason`, `reasonBox` | 1 |
| **Stop** (second press confirms), **Resume** at the right stage, **Discard** (confirm) and the command that brings a discarded branch back | `stopRun`, `resumeFrom`, `discardRun` | 1 |
| Spec questions: body, **Suggested**, **Use suggested**, an answer per question, **Submit answers and resume** | `parseQuestions`, `fillAnswers` | 1 |
| Refused actions: **Allow this run**, **Allow always**, **Deny**, **Allow all**, **Deny all**; the protected-path warning | `decidePermission` | 1 |
| Paused with nothing to decide: the hint and **Resume** | `pausedIdle` | 1 |
| "Action needed" banner for paused runs | `attentionBanner` (#100) | 1 |
| Notices on state changes (paused, failed, done) and a status summary | `tick`, `notify`, `$.ui.status` | 1 (in-page toasts, tab title); browser notifications in 2 |
| Manual input per stage and **Resume at <stage>** | `saveManualInput` | 2 |
| Test repair claim (**Show claim**) and the pipeline's REJECT lines | `parseClaims`, `claimRejects` | 2 |
| CONFIG: model providers list, add, edit, remove, **Test** a model; key shown as set / not set, never its value | `loadConfig`, `saveForm`, `testModel` | 2 |
| Runs started outside the wrapper (no Stop or Resume) | `managed` | 1 (shown read-only) |

Backlog items in that repo that were planned for the pane and fit the web app better than a terminal pane:

| Item | What it adds | Phase |
|---|---|---|
| `add-requirements-viewer` | read a pending item's brief with section links | 1 (the brief is shown on the item screen) |
| `add-answer-notes` | accept the suggested answer and add a note to it | 2 |
| `add-stage-model-switch` | pick model and effort per stage before it starts; locked once started | 2 (needs an engine change) |
| `add-base-branch-dropdown` | choose the base branch per run | 2 |
| `add-monitor-fullscreen` | two-column layout and a Files changed view grouped as docs, tests, source | 1 (the layout), 2 (grouped files) |
| `add-stage-input-gate`, `add-stage-stop-with-input` | wait for input before each stage; stop a stage, add input, restart it | 3 (engine changes) |
| `add-framework-config-pane` | pick a test framework, test path, **Deploy** | 3 (`suggest` and `init-tests` exist here already) |

## Design

The screens are drawn in a design canvas: https://claude.ai/artifact/TnKe8fZruDfqws2tMAzZzP (Board in dark and light,
Run, New item, Settings, Prompts and skills, Models, Projects, Engine requests). The design is for developers and holds
nothing back:

- Every panel names the file it reads (`status.json`, `questions.md`, `sdlc.config.json` …) and has **Edit raw**.
- Every action shows its command (`$ ai-sdlc-helper start …`) with **Copy**, and a ⌘K palette runs any command.
- A run's environment (`SDLC_BASE`, `MODEL_<STAGE>`, `EFFORT_<STAGE>`, `SDLC_LIMIT_RETRY`, `SDLC_LIMIT_MAX_WAIT`,
  `SDLC_DEP_SCRIPTS`, …) is editable and applies when the run starts or resumes.
- Settings are a form with the source of every value (config, detected, default), a live diff of `sdlc.config.json`,
  and Raw JSON for anything the form does not cover; unknown keys are kept.
- What the engine cannot do yet is drawn but disabled, tagged `Future · E-n`, pointing to
  [Engine support requests](#engine-support-requests).
- **Themes:** Light, Dark and System, switched in the top bar of every screen and kept per browser. Colours are tokens
  (ground, panel, line, text, muted, and the states running, waiting, failed, done, plus Future), so both themes share one
  layout; text and state colours pass 4.5:1 in both, and states also differ by glyph (● ⏸ ✘ ✔).

## Shape

All of the web app lives in `web/`, apart from the engine:

```
web/
  server/        the Node 18 http server: routes, token, host and origin checks, SSE
  ui/            the Preact + Vite app
  test/          route tests and one Playwright smoke test
  tsconfig.json  builds the server to dist/web/server; Vite builds the app to dist/web/ui
```

- `web/server` imports the engine only through `src/index.ts`, never `src/**` directly; an ESLint
  `no-restricted-imports` rule for `web/**` enforces it. Engine work the UI needs goes in `src/` and is exported there.
- `src/` never imports `web/`. The `ui` command in `src/cli/` loads `dist/web/server/index.js` with a dynamic
  `import()`, and says the web app is not built when the file is missing.
- Preact and Vite are dev dependencies used by `web/ui` only; `package.json` gets `build:web`, and `files` adds
  `dist/web`. Moving `web/` into its own package later is a folder move.

```
browser ──HTTP + SSE──▶ ai-sdlc-helper ui (web/server, Node 18 http server, 127.0.0.1)
                              │ imports the engine through src/index.ts
                              ▼
                 detached pipeline processes (the existing supervisor)
                 writing status.json, run.out, logs/ in each worktree
```

- **Command:** `ai-sdlc-helper ui [--port <n>] [--no-open]`. It starts a server on `127.0.0.1` (default port 4477, the
  next free one if taken), prints the URL and opens the browser. Stopping the server never stops a run: runs are
  detached processes with their own records, as they are today.
- **Server:** Node's own `http` module, no runtime dependency (the package has none today; keep it that way). It calls
  the engine's functions directly (`start`, `stop`, `discard`, `statusRecords`, `runChanges`, `backlogItems`, `decide`,
  `loadRegistry`, `resolve`, `doctor`) rather than spawning the command, so errors come back typed, not as text to parse.
  Everything the mod parses from files (questions, claims, stage files, permissions, test counts, failure reason) moves
  into one engine function, `runView(ctx, slug)`, that both the server and the plugin can use.
- **Live updates:** Server-Sent Events. The server watches each run's `status.json` and `run.out` (`fs.watch`, with a
  3-second poll as the fallback, as `watch --follow` does) and pushes a snapshot when one changes; output lines stream
  as they are written. No WebSocket: the browser only listens, and every action is a plain POST.
- **Client:** a single-page app in `web/ui/` (Preact and Vite, dev dependencies only), built into `dist/web/ui/` and
  served as static files. Light, dark and system themes; the state colours follow the mod's palette (running cyan,
  waiting amber, failed red, done green).
- **Several projects:** the project registry (`projects.json`) is the project switcher. Each project has its own board;
  a badge on the switcher counts the runs that need action across all of them.

### Safety

The server can start agents and change files, so it must be reachable by the developer's browser only:

- Bind to `127.0.0.1` only; `--host` is not offered in phase 1.
- A random token is made at start and put in the URL the command opens (`/?t=…`); the page keeps it in a session cookie
  (`HttpOnly`, `SameSite=Strict`). Every API call without it gets 401.
- Requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` are refused (DNS rebinding), and POSTs whose
  `Origin` is another site are refused (CSRF).
- API keys are never read or shown: providers store the variable's name, the page shows only whether it is set.
- Paths come from the registry and the run records, never from the request: an API call names a project and a slug,
  both checked against `NAME` and `SLUG`.

### API (phase 1)

| Method and path | Engine call |
|---|---|
| `GET /api/projects` | `readRegistry` |
| `POST /api/projects` `{ path, name? }` | `add` (with `--yes`) |
| `GET /api/projects/:p/doctor` | `doctor` |
| `GET /api/projects/:p/board` | `backlogItems` + `statusRecords` + `allChanges` |
| `POST /api/projects/:p/backlog` `{ slug, type, title, brief }` | new: writes the index line and `brief.md` |
| `GET /api/projects/:p/runs/:slug` | new `runView` |
| `POST /api/projects/:p/runs/:slug/start` `{ from? }` | `start` |
| `POST …/stop`, `…/discard` `{ stop? }`, `…/restart` `{ from? }` | `stop`, `discard`, `restart` |
| `POST …/answers` `{ answers: { [n]: text } }` | fills `questions.md`, then `start` |
| `POST …/permissions` `{ which, choice }` | `decide`, then `start` when nothing is left pending |
| `GET /api/projects/:p/settings` | `resolve` (the resolved settings and where each value came from) |
| `GET /api/events?project=:p` | SSE: board snapshots, run snapshots, output lines |

## Phase 1: the smallest usable app

**Status (2026-10-19): built.** `ai-sdlc-helper ui`, `web/server`, `web/ui`, and the engine's `runView`, `boardView`,
`answerQuestions` and `addBacklogItem` (E-3, E-4) are in. Different from the plan below: the Settings screen shows the
resolved settings and the file but not yet the rendered stage prompts; files open read-only; a command palette (any
command of the tool, run as a separate process) was added; the Playwright smoke test is not in the suite yet (the server
tests drive every route against throwaway repositories and a stand-in pipeline, and the screens were checked by hand in
Chromium, in both themes and at phone width).

A developer with a registered project, or a folder they can add from the page, takes a backlog item from idea to
shipped commit without opening a terminal.

**Screens**

1. **Projects.** The registered projects; **Add project** takes a folder path, shows what `add` would write
   (`sdlc.config.json`, backlog index) and registers it. Each project shows the `doctor` checks (Node, git, `claude`,
   settings, backlog) with a plain fix for each failing one. A project whose checks fail cannot start runs.
2. **Board** (the mod's two-column layout). Left: pending backlog items (tick boxes, **Run selected**, **New item**)
   and runs grouped by state (needs action, running, failed, done). Right: the selected item or run. The top bar has the
   project switcher, the "Action needed" banner and a summary (`2 running · 1 paused`). Runs past the parallel cap are
   refused with the engine's message (exit 3); the queue comes in phase 2.
3. **New item.** Slug (checked against `SLUG` and the existing items), type (feature or bug), title, and the brief in a
   Markdown editor with the sections the triage skill writes (Problem, Expected behaviour, Decisions, Scope, Tests,
   Docs, Open questions) as a starting template. Saving writes the index line and `brief.md` in the main working tree.
4. **Item screen** (not started): type, priority, title, the brief rendered, **Start**.
5. **Run screen:**
   - stage rail: Spec, Plan, Red tests, Implement, Test repair, Review, Ship (`status.json` names it `Commit`), each
     with its state and `model · effort`;
   - the current agent, its clock, the `note` while a usage limit is waited out;
   - files changed and uncommitted, tests passed and failing, files changed per stage;
   - live output (follows the end of `run.out`, pause on scroll, **Copy**);
   - when failed: the reason box and **Resume from <stage>** (the mod's rule: Plan and Red tests resume at their stage,
     later stages at Implement);
   - when paused on questions: each question with its suggestion, **Use suggested** or a typed answer, and
     **Submit answers and resume** (enabled once every question has an answer);
   - when paused on refused actions: each action with **Allow this run**, **Allow always**, **Deny**, and **Allow all**,
     **Deny all**; a protected path says that allowing it runs the stage without permission checks;
   - **Stop** and **Discard** with a confirm step; after a discard, the saved branch tip and how to get it back;
   - when done: the commits on the run's branch and its worktree path. Merging stays with the developer (phase 2
     adds a button).
6. **Settings (read-only).** The resolved settings with the source of each value (`sdlc.config.json`, detected,
   default) and the stage prompts as rendered for this project. Read-only in phase 1, so the tab exists and is
   useful before editing lands.

**Toasts** when a run pauses, fails or finishes, while the page is open, and the count of runs needing action in the tab
title.

**Engine work in phase 1** (in `src/`, tested like the rest):

- `runView(ctx, slug)`: one object with everything the run screen shows (the mod's `loadRun` and its parsers, moved out
  of the plugin), and `boardView(ctx)` for the board. The plugin in phase 5 uses the same functions.
- `addBacklogItem(place, { slug, type, title, brief })`: writes the index line and the brief; refuses a slug that
  exists.
- `answerQuestions(docsDir, answers)`: the mod's `fillAnswers`, with the check that every question has an answer.
- `web/server/` (routes, token, host and origin checks, SSE), `web/ui/` (the screens, both themes), and the thin `ui`
  command in `src/cli/`.

**Tests** (Vitest, the real code): the server started on a free port against the throwaway repos and the recorded
`claude` stand-in the pipeline tests use; each route's success and refusal (no token, wrong host, wrong origin, bad
slug); a run started through the API reaches `done`, and one pauses on questions and resumes after `POST answers`; SSE
delivers a snapshot after `status.json` changes. One Playwright smoke test (Chromium is available in CI) drives a run
from the board to done. `runView` and `addBacklogItem` get their own unit tests.

**Not in phase 1:** editing settings or prompts, model providers, manual input per stage, the run queue, model choice
per stage, merging, triage with an agent, remote access.

**Done when:** on a sample project from `e2e/projects`, a developer registers it, writes an item, starts it, answers the
Spec questions, allows a refused command, sees it ship, and discards another run, all in the browser.

## Phase 2: control

- **Settings editing.** A form per block of `sdlc.config.json` (tests, lint, worktree, git, agent, ship, node, ui),
  checked with `validate` before it is saved, the error shown on the field at fault. A JSON view for anything the form
  does not cover.
- **Prompts editor.** Each stage prompt (`prompt-spec.md` … `prompt-review.md`, `prompt-test-repair.md`,
  `prompt-test-audit.md`) and the parts (`parts/tools.md`, the code search parts) in a Markdown editor, with the
  placeholders (`{{TEST_CMD}}`, `{{SLUG}}` …) listed and a **Preview** that renders it for a chosen item. **Reset to
  default** removes the override; a diff against the shipped prompt is shown. Needs an engine change: prompts resolve
  per file from `<project>/.sdlc/prompts/` (committed, the team's), then the user's config directory (personal), then
  `assets/prompts/` (today the whole directory is replaced by `promptsDir`). A run records which prompt files it used.
- **Model choice per stage**, as `add-stage-model-switch` decides: a `stage-models.txt` in the run's folder, read before
  each agent starts, never waited for; a stage that has started is locked (stop and resume to change it).
  Defaults per project in settings.
- **Model providers** (the mod's CONFIG pane): list, add, edit, remove, test.
- **Manual input per stage** and **Resume at <stage>**; **answer notes** (accept the suggestion and add a note).
- **Run queue:** ticked items past the cap wait and start as runs end (kept by the server; lost when it stops, which the
  page says).
- **Base branch** per run (`add-base-branch-dropdown`); **Restart from <stage>**.
- **Test repair claim** with the REJECT lines; files changed grouped as docs, tests and source, with a diff viewer per
  file.
- **Finish a run:** show the branch's diff against its base; **Merge** into the base (fast-forward or merge commit) or
  **Push branch**, each after a confirm naming the branch.
- Browser notifications (opt-in), and the server as a background service (`ui --detach`, `ui stop`).

## Phase 3: everything else

- **Triage and interview with an agent:** a chat on the page that runs the `triage` or `interview` skill through
  `claude` and writes the briefs, so items need not be written by hand.
- **Stage input gate** and **stop a stage, add input, restart it** (`add-stage-input-gate`, `add-stage-stop-with-input`).
- **Test frameworks** (`add-framework-config-pane`): `suggest`, then `init-tests` with a confirm; the code indexer
  choice (`code-search`); permission rules (`.claude/sdlc-permissions.json`) as an editable list.
- **Skills editor**, like the prompts editor, for `assets/skills/`.
- **History and cost:** finished runs with their stages, durations, models and token use, and a per-run timeline.
- **Pull requests:** open a pull request for a shipped run through `gh` when it is installed, and show its CI.
- Remote access behind an explicit `--host` with the token required, for a dev box reached over SSH or a tunnel.

## Triage in the dashboard

**New item → Draft with the triage agent** opens a drawer above the form. Paste a report and start; tick **Quick** to
draft every item without questions.

1. A *split* session reads the report and the backlog and writes the proposed items (`items.json`). In an interactive run
   you pick the items to draft; a quick run drafts all of them.
2. Each item is drafted by its own session. In an interactive run the agent may write questions
   (`<slug>-questions.md`); the drawer shows them with **Use suggested**, and the answers resume the same session.
3. Every draft appears in the drawer with **Load into form** (the form asks before it replaces text you have typed) and
   **Skip**. A saved item is marked automatically. When every draft is saved or skipped, the run ends and its worktree and
   branch are removed. A draft whose priority is not P0–P3 loads as P2 with a note.

The agent works in its own worktree on the branch `sdlc/triage-<runId>`, made from the base without committing anything
(uncommitted settings, the backlog index and briefs are copied in). Its files are in
`<backlogDir>/.triage/<runId>/` there (`report.md`, `items.json`, `run.json`, `events.jsonl`, git-ignored). The active run
is named in `<git dir>/sdlc-runs/triage.json`, so a reload, or a restart of the server (the run becomes *interrupted*),
finds it again. One run per project at a time.

| Route | Does |
|---|---|
| `POST /api/projects/:name/triage` `{ report, quick?, model? }` | starts a run; the response is an event stream |
| `GET …/triage` | the active run, or `{ run: null }` |
| `GET …/triage/events?runId=` | replays the stored events, then streams new ones |
| `POST …/triage/items` `{ runId, slugs }` | the items to draft |
| `POST …/triage/answer` `{ runId, slug, answers }` | answers a waiting item (`Q1`, `Q2` …; `accept` takes the suggestion) |
| `POST …/triage/saved`, `…/skip` `{ runId, slug }` | marks a draft |
| `POST …/triage/stop`, `…/resume`, `…/discard` `{ runId }` | stops the agent, continues its session, or removes the run |

Events: `started`, `text`, `tool`, `items`, `question`, `draft`, `marked`, `error`, `done` (`code` 0 finished, 130 stopped,
127 `claude` not found, other: its exit code).

## Engine support requests

What the UI needs from `src/`. Until a request lands, its controls are drawn disabled and tagged `Future · E-n`.

| # | Engine support | Unblocks in the UI | Phase |
|---|---|---|---|
| E-3 | `runView()`, `boardView()`: the mod's file parsing as engine functions (done) | Board, Run screen | 1 |
| E-4 | `addBacklogItem()`, `answerQuestions()` (done) | New item, Submit answers | 1 |
| E-1 | Prompt overrides per file: project `.sdlc/prompts/`, then personal, then shipped (today `promptsDir` replaces the whole folder); a run records the prompts it used | Prompts: Save to project / personal | 2 |
| E-2 | `stage-models.txt` per run, read before each agent starts (`add-stage-model-switch`) | Stage pickers on a running run | 2 |
| E-13 | Model defaults per project in settings (`agent.models`); today only `MODEL_<STAGE>` / `EFFORT_<STAGE>` in the environment | Models: Save as project default | 2 |
| E-10 | Finish a run: diff against its base, merge, push the branch | Run: Merge into base | 2 |
| E-11 | A run queue past the parallel cap that survives a restart | Board: Run selected beyond the cap | 2 |
| E-5 | Skill overrides, as E-1 | Prompts: skills editor | 3 |
| E-6 | Stage input gate; stop one stage, add input, restart it | Run: gate screen, Stop stage | 3 |
| E-7 | Skip a stage or a gate for one run | Run: Skip on the stage rail | 3 |
| E-8 | Triage agent runs with a streamed conversation (done: see [Triage in the dashboard](#triage-in-the-dashboard); the interview agent is not part of it) | New item: Draft with the triage agent | 3 |
| E-9 | Tokens and duration per stage in `status.json`; `history.jsonl` on finish | Run: Usage; history and cost | 3 |
| E-14 | Read an issue (GitHub through `gh`) into a draft brief | New item: Import from issue URL | 3 |
| E-12 | A pipeline definition in settings: stage order, stages on or off, custom agent stages | Settings: Pipeline stages | later |

## Storage

No database: the web app reads and writes the files the command already uses, so a run started from the command, the
plugin or the page shows in all three, and the server keeps only a cache it can rebuild.

| Data | Where |
|---|---|
| Backlog items | `<backlogDir>/index.md` (one line each, status marker) and `<backlogDir>/<slug>/brief.md`; committed |
| Settings | `sdlc.config.json`; committed |
| A run's documents | `<backlogDir>/<slug>/` in its worktree: specs, plan, test cases, review, `questions.md`, `manual-inputs.md`, `test-issues.md` |
| A run's progress | `<backlogDir>/<slug>/logs/` in its worktree: `status.json`, `run.out`, `tests.json`, `permissions.json`, `baseline.json` |
| Run records | `<git common dir>/sdlc-runs/<slug>.json`, shared by every checkout |
| The code | the run's worktree and branch |
| Permission rules | `.claude/sdlc-permissions.json`; committed |
| Projects, model providers | the user's config directory (`~/.config/ai-sdlc-helper/`); keys by variable name only |

Phase 2 adds `queue.json` (the run queue, so it survives a server restart) and prompt overrides in
`<project>/.sdlc/prompts/` and the user's config directory, both files too.

## Future enhancements

To consider after phase 3; none is planned yet.

### A database for history and search

A store such as SQLite beside the files, for what the files do not keep well: runs after their worktree is discarded,
durations, models and token use per stage, and search across runs and projects. The files stay the source of truth for
live runs; the database would hold a copy written when a run changes state or ends.

Pros:
- History outlives `discard`, which deletes the worktree and its logs today.
- Fast queries for the history, cost and timeline views (phase 3) and across projects, instead of reading every
  record and log on each request.
- Transactions for the server's own state (queue, notifications seen, preferences) as it grows.

Cons:
- A second copy of the run state that can drift from the files the command and plugin write; something must
  reconcile them (rebuild from the files on start).
- Node's built-in `node:sqlite` needs Node 22 or newer (the tool supports 18); `better-sqlite3` is a native module that
  must build or download for each platform, the package's first runtime dependency.
- Schema migrations to ship and test with every release that changes it.
- Harder to inspect, diff and fix by hand than JSON and Markdown, and not shareable through git as the backlog is.

Lighter option first: an append-only `history.jsonl` in the user's config directory, one line per finished run (slug,
project, stages with durations, models, tokens, outcome). It covers the history view without a dependency; move to a
database only when queries over it are too slow, or when Node 22 is the minimum.

## Open questions

- Port: a fixed default (4477) with fallback, or always a free one? The plan takes the fixed default so bookmarks work.
- Should the Claude Code plugin's pane (phase 5 of the main plan) open the web app instead of drawing its own board, or
  keep both? The engine functions are shared either way.
- Prompt overrides: keep them in the project (`.sdlc/prompts/`) so the team shares them, in the user directory only, or
  both as planned?
