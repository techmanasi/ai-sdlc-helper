# Spec: add-ui-triage-agent

Type: feature · Priority: P2 (normal) · Engine request E-8

Sources: `brief.md` and `decisions.md` (Rounds 1–5). Where this spec cites "R<n> Q<m>", that decision is binding.

## 1. Summary

The New Item screen of the web dashboard (`#/new`) enables the button **Draft with the triage agent**. It opens a drawer where the user types a bug or feature report. The web server then runs the triage agent for the project in a dedicated git worktree, in two phases:

1. A **split** session proposes one or more backlog items.
2. One **item session** per kept item writes that item's brief. Item sessions run one after another, never in parallel, and each may ask its own questions.

Progress streams to the browser as Server-Sent Events (SSE). Each finished brief is offered as a **draft**. The user loads it into the New Item form and saves it with the existing Save / Save and start. Every input, question, answer, event and output of the run is written to files in the triage worktree, so a run survives a browser refresh, a closed tab or a crash, and a server restart. Nothing is re-run that already finished.

The CLI `ai-sdlc-helper triage` keeps its current behaviour (R2 Q1).

## 2. Terms

- **Project root**: the project's absolute path as the dashboard lists it (registered or unregistered; both are treated the same, R3 Q2).
- **Backlog dir**: the project's backlog folder (`backlogDirOf`), written `<backlog>` below.
- **Run**: one triage run, identified by a `runId`. At most one active run per project.
- **Run folder**: `<backlog>/.triage/<runId>/` inside the triage worktree.
- **Kept items**: the proposed items the user selected (all of them in a quick run).

## 3. Files and storage

### 3.1 Worktree and branch (R2 Q1, R4 Q2, R5 Q2)
- Path: `<worktree base>/triage-<runId>`. Branch: `<branchPrefix>triage-<runId>`, new, created from the same base `start` uses (`pickBase`).
- `runId` is unique per run and uses only lowercase letters, digits and dashes, so it is valid in a folder name and a branch name.
- Before the split session starts, the server:
  - copies an uncommitted `sdlc.config.json` from the main working tree into the worktree, the same way `start` does;
  - copies the main working tree's current `<backlog>/index.md` into the worktree;
  - copies every `<backlog>/<slug>/brief.md` of the main working tree that is missing from the base into the worktree.
  Nothing else is copied.
- Nothing is ever committed on the triage branch. The project's own `.gitignore` is not touched.

### 3.2 Run folder contents (R2 Q1, R2 Q2, R2 Q3)
Inside `<backlog>/.triage/<runId>/` in the worktree:
- `.gitignore` containing `*` (keeps the whole folder out of git).
- `report.md`: the user's report text, as submitted.
- `run.json`: `runId`, `state`, `quick`, the Claude session id of each session (split and per item), the pid of the running `claude` process (if any), which session is current, the proposed items, the kept slugs, each draft's status (`pending` | `saved` | `skipped`), and timestamps.
- `events.jsonl`: every SSE event the run has sent, one JSON object per line (event name and payload), in order.
- `items.json`: written by the split session: `[{ slug, type, priority, title, summary }]`.
- `<slug>-questions.md`: written by an item session when it has questions (§5.4).

The agent writes, as the triage skill says, one `<backlog>/<slug>/brief.md` per kept item and its line in `<backlog>/index.md`, all inside the worktree.

### 3.3 Registry pointer (R2 Q1, R3 Q2)
- File: `<registry dir>/triage.json` (`registryDir` of the project root), one JSON object keyed by the project's absolute root path: `{ "<root>": { "runId": "...", "worktree": "..." } }`.
- A key is added when a run starts and removed on Discard or when the run becomes `done`.
- When the server reads the file, any key whose worktree folder no longer exists is dropped.
- The server finds the active run of a project only through this pointer. It never scans folders.

## 4. Run states (R2 Q5, R5 Q1)

| State | Meaning | Process running |
|---|---|---|
| `running` | the split or an item session is running | yes |
| `choosing` | split finished; waiting for the user to pick items | no |
| `waiting` | an item session asked questions; waiting for answers | no |
| `ready` | every kept item has a draft; drafts remain to save or skip | no |
| `interrupted` | was `running` when the server stopped | no |
| `stopped` | the user pressed Stop | no |
| `failed` | a session failed (§7) | no |
| `done` | finished; worktree, branch and pointer removed | no |

Every state except `done` is **active**: a new `POST /triage` for that project returns 409.

## 5. Behaviour

### 5.1 Starting a run
1. The user clicks **Draft with the triage agent** (no longer disabled or tagged `Future · E-8`). A drawer opens with a report text area, a **Quick (no questions)** checkbox (off by default), and a start button. There is no model picker (R1 Q6).
2. The client sends `POST /api/projects/:name/triage` with `{ report, quick }` and reads the `text/event-stream` response with `fetch` (not `EventSource`).
3. The server validates, creates and sets up the worktree (§3.1) and run folder (§3.2), writes `report.md`, `run.json` and the registry key, and only then starts the SSE response. The first event is `started {runId}`.
4. The server starts the split session.

### 5.2 Agent sessions
- Each session runs `claude -p` in the triage worktree with `--output-format stream-json --verbose`, `--permission-mode acceptEdits` and the tools of `triageTools`, using the same default model as the CLI `triage` (or `model` from the request body when given). The server reads the stream to produce `text` and `tool` events and to learn the session id, which it records in `run.json`.
- The prompt is the project's rendered triage skill plus a dashboard-run instruction for the phase:
  - **Split**: read the report and the backlog (including the duplicate check), choose slugs that are not taken, write `items.json` in the run folder, and write no briefs or index lines.
  - **Item session**: write the brief and index line for exactly the one named item. Instead of AskUserQuestion, write questions to `<run folder>/<slug>-questions.md` (§5.4) and end the turn. In a quick run the session is headless (as `triagePrompt` with `headless: true`): open points go under "Open questions" in the brief.
  - The dashboard-run instruction text lives in `assets/` (user-facing prompts live there, per CLAUDE.md).
- Raw reasoning is not shown. Prose becomes `text` events; each tool call becomes one `tool` event with a one-line summary (for example "Read src/triage.ts") (R1 Q5).
- The `claude` process is a child of the web server. It keeps running when no browser is connected (R2 Q4). It is killed when the server stops (`close()`).

### 5.3 Split phase (R2 Q2)
- After the split session exits 0, the server reads and validates `items.json` (§7.2).
- Valid, with at least one item: the server emits `items {items:[...]}` and records the proposed items.
  - Interactive run: state becomes `choosing`. The drawer lists the items (slug, type, priority, title, summary) with checkboxes. The user posts the selection with `POST /triage/items` `{ runId, slugs }`.
  - Quick run: the choosing step is skipped and every proposed item is kept.
- Valid but empty (the agent proposed nothing, e.g. a duplicate or docs-only report): the run becomes `done` (code 0). The drawer shows the agent's prose so the user can see why.
- Selection of zero slugs: the run becomes `done`; no briefs are written.
- Otherwise the item sessions start, one after another in the order of `items.json`.

### 5.4 Item sessions and questions (R2 Q2, R2 Q3, R5 Q4)
- Questions file: `<run folder>/<slug>-questions.md`, in the format the pipeline already parses (`### Q<n>: <title>`, the question, `**Suggested:**`, an empty `**Answer:**`), at most 4 questions per round.
- When an item session exits 0, in an **interactive** run:
  1. If the questions file has unanswered questions, they win: the server emits `question {slug, questions:[{id:"Q<n>", text, suggested}]}` and the state becomes `waiting`. No `draft` is sent for that slug yet.
  2. Else, if a valid brief exists (§5.5), the server emits `draft` for that slug.
  3. Else, the session failed (§7.2).
- In a **quick** run, a questions file is ignored and no `question` event is ever sent. A valid brief gives a `draft`; no brief is a failure (§7.2).
- Answering: `POST /triage/answer` `{ runId, slug, answers: { "Q1": "...", ... } }`. The server writes the answers into the file ("accept" means the Suggested value, as in the pipeline), sets `running`, and continues the same Claude session with `claude -p --resume <session id>`, sending a message that names the answered file. Answered files stay in place.
- After a `draft`, the next kept item's session starts. When every kept item has a draft, the state becomes `ready` (unless every draft is already saved or skipped, in which case it becomes `done`).

### 5.5 Building a draft (R2 Q6)
- `brief`: the full text of `<backlog>/<slug>/brief.md` in the worktree.
- `type`: from the brief's `Type:` line; must be `bug` or `feature`.
- `priority`: from the brief's `Priority:` line.
- `title`: from the item's line in the worktree's `<backlog>/index.md`: the text after `Bug:` / `Feature:`.
- Event: `draft {drafts:[{slug, type, priority, title, brief}]}`, with exactly the one draft of that item session. The draft's status starts as `pending`.

### 5.6 Loading and saving drafts (R1 Q7, R2 Q6, R3 Q3, R5 Q3)
- The drawer lists the drafts received so far, each with its status, **Load into form** and **Skip**. A draft can be loaded, saved or skipped as soon as its `draft` event arrives, whatever the run's state, unless the run is `done` or discarded. Saving early never stops or changes item sessions still to come.
- **Load into form** fills slug, type, priority, title and brief:
  - If the form differs from the empty template, the user is asked "Replace the current form with the draft?" first; otherwise it fills straight away.
  - The form's priority options gain `P0 (security or data loss)`. Any draft priority maps to the option with the same `P<n>` prefix. An unknown value falls back to `P2 (normal)` with a visible note.
  - A taken slug is filled as it is; the form's existing "already in the backlog" check blocks Save until it is changed.
- **Save** and **Save and start** use the existing `POST /api/projects/:name/backlog` unchanged, so the item lands in the main working tree. The triage branch is never merged.
- After a successful Save whose slug matches a draft of the run, the client calls `POST /triage/saved` `{ runId, slug }`. **Skip** calls `POST /triage/skip` `{ runId, slug }`. Each marks the draft in `run.json` and emits `marked {slug, status}` (`saved` or `skipped`). `marked` is not `done`, so streams stay open.
- The drawer then offers the next pending draft.
- The run never saves anything on its own.
- When every kept item has a draft and every draft is saved or skipped, the run becomes `done` (§5.8).

### 5.7 Reconnecting (R1 Q4, R2 Q4, R3 Q1)
- `GET /api/projects/:name/triage` returns `{ run: { runId, state, worktree, slugs, drafts: [{ slug, status }] } | null }`. `slugs` are the kept items' slugs.
- When the New Item screen opens and the project has a run, the drawer reopens on its own and attaches with `GET /api/projects/:name/triage/events?runId=<id>`.
- That stream first replays every event in `events.jsonl` (including earlier `done` events), then streams new events. Several viewers may attach at once; each receives every new event.
- The drawer rebuilds its view (progress, items, questions, drafts and their statuses) from the run summary and the replayed events.

### 5.8 `done` events and stream lifetime (R3 Q1)
- `done {code}` means "no agent will run again until the user acts, and none is waiting for a choice or for answers". It is sent once each time the run enters:
  - `ready`: code 0;
  - `failed`: the failing session's exit code (127 for a missing `claude`; 1 for the output failures of §7.2);
  - `stopped`: code 130;
  - `done`: code 0 (including zero items proposed or kept).
- Both the `POST /triage` stream and every `GET /triage/events` stream close after a `done` event.
- `choosing` and `waiting` do not send `done`: streams stay open, and the events that follow `POST /triage/items` or `POST /triage/answer` arrive on them.
- After a stream closed on `ready` (code 0), the drawer still offers the drafts; saving or skipping them works through the JSON endpoints. Viewers that reattach see the replay and then the eventual `done`.

### 5.9 Stop, Resume, Discard and clean-up (R2 Q5, R4 Q1, R5 Q1)
- **Stop** (`POST /triage/stop` `{ runId }`): only allowed while `running`. Kills the process, sets `stopped`, emits `done {code:130}`. The worktree is kept.
- **Resume** (`POST /triage/resume` `{ runId }`): only allowed from `stopped`, `interrupted` or `failed`. It continues the session that was current (the split, or that one item) with `claude -p --resume <session id>`, telling it to carry on where it left off, and sets `running`. Item sessions that had not started then run in order as usual. Returns JSON `{ ok: true, run }` (the run summary of §5.7); the drawer then reattaches with `GET /triage/events`.
- **Discard** (`POST /triage/discard` `{ runId }`): allowed in every state. The UI asks for confirmation first. Kills any process, removes the worktree (`git worktree remove --force`), deletes its branch and removes the registry key. Returns JSON `{ ok: true }`.
- **Done clean-up**: when the run becomes `done`, the server emits `done {code:0}`, then removes the worktree, the branch and the registry key the same way as Discard.

### 5.10 Server restart (R2 Q4, R5 Q1)
- On start-up, the server reads `triage.json`. For each run that was `running` and whose recorded pid is dead, it sets the state to `interrupted` in `run.json`.
- Runs in `choosing`, `waiting` or `ready` keep their state; the browser carries on with them through the normal endpoints.

## 6. API

All routes are under `/api/projects/:name/triage`, need the server token like every other route, and use the server's existing JSON error shape `{ ok: false, error }`. Checks run in this order: bad input (400), then not found (404), then conflict (409). A request that fails changes nothing.

| Method and path | Body / query | Success | Errors |
|---|---|---|---|
| `POST /triage` | `{ report: string, quick?: boolean, model?: string }` | 200 `text/event-stream` | 400 empty or whitespace-only `report`; 400 missing triage prompt; 400 worktree set-up failure (§7.1); 404 unknown project; 409 `{ error: "a triage run is already active for <project>" }` |
| `GET /triage` | — | 200 `{ run: {...} \| null }` | 404 unknown project |
| `GET /triage/events` | `?runId=` | 200 `text/event-stream` (replay, then live) | 404 unknown project; 404 unknown or stale runId |
| `POST /triage/items` | `{ runId, slugs: string[] }` | 200 `{ ok: true, run }` | 400 `slugs` not a list of strings, or a slug that was not proposed; 404 unknown runId; 409 run not `choosing` |
| `POST /triage/answer` | `{ runId, slug, answers: { "Q<n>": string } }` | 200 `{ ok: true, run }` | 400 any question left unanswered; 404 unknown runId or slug; 409 run not `waiting` |
| `POST /triage/saved` | `{ runId, slug }` | 200 `{ ok: true, run }` | 404 unknown runId or slug with no draft; 409 draft already saved or skipped; 409 run `done` |
| `POST /triage/skip` | `{ runId, slug }` | 200 `{ ok: true, run }` | as `saved` |
| `POST /triage/stop` | `{ runId }` | 200 `{ ok: true, run }` | 404 unknown runId; 409 `{ error: "run <runId> is <state>, not running" }` |
| `POST /triage/resume` | `{ runId }` | 200 `{ ok: true, run }` | 404 unknown runId; 409 run not `stopped`, `interrupted` or `failed` |
| `POST /triage/discard` | `{ runId }` | 200 `{ ok: true }` | 404 unknown runId |

An unknown runId returns 404 on every endpoint. A runId is unknown when it is not the runId in the project's registry key.

### 6.1 SSE events
Each event is written as `event: <name>` and `data: <JSON>`, and appended to `events.jsonl` before it is sent.

| Event | Payload |
|---|---|
| `started` | `{ runId }` |
| `text` | `{ text }` (agent prose) |
| `tool` | `{ name, summary }` |
| `items` | `{ items: [{ slug, type, priority, title, summary }] }` |
| `question` | `{ slug, questions: [{ id: "Q<n>", text, suggested }] }` |
| `draft` | `{ drafts: [{ slug, type, priority, title, brief }] }` |
| `marked` | `{ slug, status: "saved" \| "skipped" }` |
| `error` | `{ message }` |
| `done` | `{ code }` |

## 7. Error cases

### 7.1 Before the stream (R1 Q5, R5 Q2)
Returned as JSON before any SSE output: an empty or whitespace-only report, an unknown project, a missing triage prompt, an active run (409), and any failure while setting up the worktree:
- the repository has no commit (`pickBase` returns nothing): 400 with the same text `start` uses ("the repository has no commit to start the branch from");
- `git worktree add` fails, or the branch or folder already exists: 400 with git's message.

On a set-up failure, nothing is left behind: a half-created worktree and branch are removed and no registry key is written. The project can start a new run straight away.

### 7.2 Session failures (R1 Q8, R2 Q5, R4 Q1)
Each of the following emits `error {message}`, sets the run to `failed` and emits `done {code}`. Item sessions still to come do not start. Drafts already sent stay available to save or skip.
- `claude` cannot be spawned: message "claude was not found on PATH", code 127.
- A session exits non-zero: code = its exit code.
- The split session exits 0 but `items.json` is missing, not valid JSON, not a list of `{ slug, type, priority, title, summary }`, or has a duplicate slug or a slug that is not lowercase letters, digits and dashes: code 1; the message names the file and the problem.
- An item session exits 0 but leaves no brief (and, in an interactive run, no unanswered questions); or the brief has no line in the worktree's index; or its `Type:` is not `bug` or `feature`: code 1; the message names the slug, the file and the problem.

`POST /triage/resume` re-runs only the session that failed, continuing its Claude session id. Discard is always available.

### 7.3 No time limits (R1 Q8)
There is no server-side time limit on a session, and none on `choosing` or `waiting`.

## 8. Engine and UI placement

- `src/triage.ts`: the dashboard-run helpers (prompts for the split and item phases, parsing and validating `items.json`, building a draft from a brief and the index line, reading questions files), exported through the package's public entry `src/index.ts`, since the web server reaches the engine only through it.
- `web/server/index.ts`: the routes of §6, the run lifecycle, SSE, the registry pointer and start-up recovery.
- `web/ui/src/api.ts`: client calls for every route, with the POST stream read through `fetch`.
- `web/ui/src/NewItem.tsx`: the enabled button, the drawer (report, Quick checkbox, progress, items selection, questions and answers, drafts with Load/Skip, Stop, Resume, Discard with confirm), the P0 option and the priority mapping, and reopening on load.
- `assets/`: the dashboard-run instruction texts.
- No new packages are needed.

Out of scope: E-14 (import from GitHub issue URLs); any change to the CLI `ai-sdlc-helper triage`; any change to `POST /backlog`.

## 9. Acceptance criteria

The tests run real code; the agent is a stand-in `claude` (for example a script on the PATH passed through the server's `env`, or an injected runner) that writes the files a real agent would and prints stream-json.

### `test/triage.test.ts`
1. A valid `items.json` parses to its items; each invalid case of §7.2 (missing, not JSON, wrong shape, duplicate slug, bad slug) is rejected with a message naming the problem.
2. A draft built from a worktree brief and index line has the brief text, `type`, `priority` and the title after `Bug:`/`Feature:`; a brief with a bad `Type:` or no index line is rejected.
3. Unanswered questions in `<slug>-questions.md` are detected; after answers are written ("accept" → Suggested), none remain.
4. The split and item prompts contain the report and the rendered triage skill; the quick item prompt is headless.

### `web/test/server.test.ts`
5. `POST /triage` with an empty or whitespace-only report → 400 JSON; unknown project → 404; no worktree, branch or registry key created.
6. A second `POST /triage` while a run is active → 409 with "a triage run is already active for <project>".
7. Repository with no commit → 400 with `start`'s text, nothing left behind, and a later `POST /triage` is not 409.
8. Interactive run, happy path: events in order `started`, progress (`text`/`tool`), `items`; state `choosing`; `POST /triage/items` keeps a subset; the item sessions run in `items.json` order; `draft` per kept item; then `done {code:0}` with state `ready`; streams close after `done`.
9. Worktree at `<worktree base>/triage-<runId>` on branch `<branchPrefix>triage-<runId>`; the run folder holds `.gitignore` (`*`), `report.md`, `run.json`, `events.jsonl`; nothing committed on the branch; the registry key `{ runId, worktree }` exists under the project root.
10. The worktree has the main tree's uncommitted `sdlc.config.json`, current `index.md`, and its uncommitted briefs before the split runs.
11. An item session that writes questions → `question {slug, questions}` and state `waiting`, no `draft` for that slug; `POST /triage/answer` with a missing answer → 400; with all answers → the file is updated, the session is resumed with `--resume <session id>`, and its `draft` follows on the same stream. Answering a run that is not `waiting` → 409.
12. Quick run: no `items` selection step, no `question` events even if a questions file is written; every proposed item gets a `draft`.
13. Zero items proposed, or zero kept → `done {code:0}`; worktree, branch and registry key removed.
14. `POST /triage/saved` and `POST /triage/skip` → `marked` events and statuses in `GET /triage`; a second mark → 409; unknown slug → 404; marking works while later items are still running; when every kept draft is marked, the run is `done` and cleaned up.
15. `GET /triage/events` replays all stored events (including an earlier `done`) then streams new ones; two viewers both receive new events; an unknown runId → 404.
16. Stop while `running` → process killed, `done {code:130}`, state `stopped`, worktree kept; Stop in any other state → 409 with "run <runId> is <state>, not running".
17. Resume from `stopped`/`interrupted`/`failed` → `{ ok: true, run }`, the current session is continued with `--resume`; Resume from any other state → 409.
18. Discard → process killed, worktree removed, branch deleted, registry key removed; afterwards the runId → 404 and a new `POST /triage` is allowed.
19. Missing `claude` → `error` "claude was not found on PATH", `done {code:127}`, state `failed`; non-zero exit → `error`, `done {code}`; bad `items.json` or a missing brief → `error` naming the file, `done {code:1}`, later items not started, earlier drafts still markable.
20. Closing the client's stream does not kill the agent: the run continues and its events are in `events.jsonl`.
21. Restart: a server started with a registry key whose run is `running` with a dead pid reports it `interrupted`; a `waiting` run keeps `waiting`. A registry key whose worktree is gone is dropped.
22. Every new route returns 401 without the token.

### Manual verification (`web/ui`)
23. The button is enabled and opens the drawer; a real interactive run shows progress, the item list, questions with answer fields and drafts.
24. Load into form fills the fields (with the replace prompt when the form was edited, P0 offered, priority mapped by `P<n>`); Save marks the draft saved; the next pending draft is offered.
25. Refreshing the page or reopening the browser mid-run reopens the drawer with the same state; Stop, Resume and Discard (with confirm) work.

## 10. Docs
- `docs/web-ui.md`: describe the triage drawer and the new routes; E-8 is done.
- `docs/design/web-ui/Roadmap.dc.html`: mark E-8 as completed.
