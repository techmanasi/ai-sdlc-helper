# Plan: web UI design canvas, and the web app kept in its own folder

Status (2026-10-19): the canvas is done (source in [design/web-ui/](design/web-ui/), live at
https://claude.ai/artifact/TnKe8fZruDfqws2tMAzZzP) with light, dark and system themes on every screen, as asked after
the first review; the folder layout and engine requests are in [web-ui.md](web-ui.md). Phase 1 is built (see the status under Phase 1 in web-ui.md).

## Context
You asked for a design of the local web app planned in `docs/web-ui.md`. It is for developers, so it should give full control with no restrictions. Anything the engine cannot do yet gets a backend support request, and its UI goes to the future plan. Mid-turn you added that the web server and the UI must sit isolated in one folder. The canvas was created (https://claude.ai/artifact/TnKe8fZruDfqws2tMAzZzP) and its index written in the scratchpad (`…/scratchpad/design/project/canvas.json`), but nothing is published yet. This plan finishes the canvas and records the folder layout and the support requests in the docs.

## 1. Finish the design canvas (Design artifact, scratchpad only)
Look: a developer workbench in light and dark (Light / Dark / System in the top bar of every screen). IBM Plex Sans for text, JetBrains Mono for paths, commands and logs. The ground is graphite (#0f1216, panels #151a21). Status colours come from the existing mod: running cyan #56d4dd, waiting amber #e3b341, failed red #ff7b72, done green #7ee787. "Future" tags are dashed purple. Every board is a fluid page (1440 wide, `expand: fill`) that wraps down to phone width.

Things on every screen, so developers keep full control:
- Each panel names the file it reads (`Docs/backlog/<slug>/logs/status.json` …) and has **Edit raw**.
- Each action shows its CLI equivalent (`$ ai-sdlc-helper start …`) with Copy.
- A ⌘K command palette in the top bar.
- Run environment overrides the engine already reads: `SDLC_BASE`, `MODEL_<STAGE>`/`EFFORT_<STAGE>`, `SDLC_LIMIT_RETRY`, `SDLC_LIMIT_MAX_WAIT`, `SDLC_DEP_SCRIPTS`, `SDLC_MAX_PARALLEL`, `SDLC_ALLOW_MERGED`.
- Controls the engine cannot back yet are drawn but disabled, tagged `Future · E-n`.

The boards (index already written; each file is written and published one at a time):
1. `Main.dc.html` **Board**: project switcher, the Action needed banner, run summary chips, and 127.0.0.1:4477. A kanban board: Backlog | Spec | Plan | Red tests | Implement | Test repair | Review | Ship. Pending items have checkboxes, Run selected and New item. An output drawer at the bottom shows the selected run.
2. `Run.dc.html` **Run (paused)**:
   - The header carries Stop, Resume from Spec, Restart from ▾, Discard, Open worktree, and Copy CLI.
   - The stage rail shows model · effort per stage. Choices made at start come from the environment; changing them on a running run is `Future · E-2`.
   - Tabs: Overview, Output, Files, Docs, Logs, Env.
   - Questions, each with Suggested, Use suggested and an answer box. Refused actions with Allow this run / Allow always / Deny, and Allow all / Deny all.
   - Manual input per stage with Resume at stage.
   - Tests and file counts, files per stage, live output, and the raw run record.
   - Skip a stage or gate is `Future · E-7`.
3. `NewItem.dc.html`: slug, type, priority and title. A brief editor using the triage template, with a live preview. Save, and Save and start. Draft with triage agent is `Future · E-8`.
4. `Settings.dc.html`:
   - A section list on the left: General, Tests, Suites, Worktree, Git, Agent and allow commands, Permissions rules, Ship, Node, Environment, Raw JSON.
   - A form with a source badge per field (config / detected / default) and Reset.
   - A live diff of `sdlc.config.json`, and layer tabs: Project (committed) | Personal.
5. `Prompts.dc.html`:
   - A list of stage prompts, parts and skills, and a mono editor with layer tabs: Shipped | Project | Personal.
   - Placeholders listed, Preview for an item, Diff against the shipped prompt, Reset.
   - Saving overrides is `Future · E-1`; editing skills is `Future · E-5`.
6. `Models.dc.html`: defaults per stage (model and effort, with the source of each: env / default), the Test audit model, and the provider registry (add, edit, test, remove; key shown as set or not set).
7. `Projects.dc.html`: registered projects with the doctor checks, a fix line for each failing check, and Add project with a preview of what `add` writes.
8. `Roadmap.dc.html`: a table of backend support requests (E-1…E-12) and the future UI each one unblocks, with phase and status.

Support requests on board 8, also added to the docs:
- **E-1** per-file prompt overrides (project `.sdlc/prompts/`, then the user directory, then `assets/prompts/`), and the run records which prompts it used.
- **E-2** `stage-models.txt` per run, read before each agent.
- **E-3** `runView` / `boardView`.
- **E-4** `addBacklogItem` / `answerQuestions`.
- **E-5** skill overrides.
- **E-6** the stage input gate, and stopping a stage with input.
- **E-7** skip a stage or gate per run.
- **E-8** a triage / interview agent runner with streamed chat.
- **E-9** tokens and durations per stage, plus `history.jsonl`.
- **E-10** finish a run: merge / push / PR.
- **E-11** a persistent queue.
- **E-12** a pipeline definition in settings (stage order, enable or disable, custom stages).

## 2. Keep the web app in its own folder (`web/`)
Recorded in `docs/web-ui.md`, replacing the current "Shape" paths:
```
web/
  server/        Node 18 http server (TypeScript): routes, token/host/origin checks, SSE
  ui/            Preact + Vite single-page app
  test/          server route tests + one Playwright smoke test
  tsconfig.json  own build → dist/web/server, Vite → dist/web/ui
```
- The server imports the engine only through its public entry, `src/index.ts`, never `src/**` internals. An ESLint `no-restricted-imports` rule in `eslint.config.js` enforces this for `web/**`. Engine additions (E-3, E-4) go in `src/` and are exported from `src/index.ts`.
- `src/` never imports `web/`. The only link is a thin `ui` command in `src/cli/` that loads `dist/web/server/index.js` with a dynamic `import()`. If that file is missing, the command says the web app is not built.
- The UI's dependencies (Preact, Vite) are dev dependencies used only by `web/ui`. `package.json` gets `build:web`, and `files` adds `dist/web`.
- Moving `web/` into its own package later is a folder move, not a refactor.

## 3. Docs
`docs/web-ui.md`:
- Update the "Shape" section with the `web/` layout above.
- Add a "Backend support requests" section listing E-1…E-12, each with the screen it unblocks.
- Add the design canvas link.

Lint, commit and push to `claude/upbeat-wozniak-xtuijn`. Docs only, so `npm run check` must stay green.

## Verification
- Each canvas publish succeeds. Per the type's rules, there are no render checks unless you ask for them.
- `npm run check` passes after the docs edit, and `git log` shows the commit pushed to the branch.
