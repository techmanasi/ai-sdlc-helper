# Decisions for add-ui-triage-agent

## Round 1 (2026-10-30)

### Q1: Does the dashboard triage agent write files to disk?
The shipped triage skill (`assets/skills/triage.md`, sections 5 and 7) tells the agent to create `<backlog>/<slug>/brief.md` and add a line to `<backlog>/index.md`. `src/triage.ts` then finds what changed by comparing before and after (`compareBacklog`). The brief's decision is that the draft goes "into the client-side editor state rather than committed immediately", and the user then clicks Save. Save calls `addBacklogItem`. If the agent has already written the brief and index line, Save will clash with them (the slug is taken). The behaviour, the error cases and the clean-up rules all depend on which way this goes.
**Suggested:** In dashboard runs, the agent writes nothing. The server adds an instruction to the prompt, as `triagePrompt` already does for headless runs, telling the agent not to create files. Instead it ends its reply with one machine-readable block holding `slug`, `type`, `priority`, `title` and the full `brief` Markdown. The server parses that block (the parser goes in `src/triage.ts` and is tested in `test/triage.test.ts`) and sends it to the browser. Nothing on disk changes until the user clicks Save or Save and start. If the agent writes files anyway, the run is reported as failed and the files are listed (from `compareBacklog().added/orphans/outside`). They are not deleted.
**Answer:** I want the agent to write the prompt the user entered, questions it created, entry to index, and brief etc to to appropriate files in a git worktree, so even if the UI crashes or not connected, nothing is lost, can save tokens in such cases without re-running. the worktree name should be tracked so when the UI reloads, it can find the status and outputs

### Q2: What happens when one report produces several items, or none?
The triage skill splits a report into one item per independent problem. It creates no item for duplicates or for documentation-only parts. The New Item form holds exactly one item. The spec needs to say what the UI does with 2 or more drafts, and with zero drafts.
**Suggested:** In dashboard runs the prompt asks for exactly one item. If the agent still returns several drafts, the drawer lists them and the user picks one to load into the form. The others are shown read-only so they can be copied. If it returns none (a duplicate, docs-only, or no parsable block), the drawer shows the agent's final reply, and the form is left unchanged.
**Answer:** The triage agent can suggest multiple items from the prompt and the user can accept multiple items or single item, each item should be triaged independantly

### Q3: How are the agent's questions delivered and answered?
In a headless run (`claude -p`), the agent cannot use AskUserQuestion. Today an interactive run takes over the terminal, so the server cannot do it that way. The brief says answers go to `POST /api/projects/:name/triage/answer` and are "delivered to the agent process". The mechanism decides what the endpoint accepts, what counts as a question event, and how a run waits for an answer.
**Suggested:** The agent runs as `claude -p --output-format stream-json --verbose` with the stream converted into SSE events. When the agent needs answers, it ends its turn with a machine-readable questions block (at most 4 questions, as the skill already limits). Each question has an id, the text, and optional choices. The server emits a `question` event, and the run moves to "waiting". The answer endpoint takes `{ runId, answers: { <id>: <text> } }` and continues the same conversation with `claude -p --resume <session id>`, sending the answers as the next message. The stream then goes on over the same SSE connection.
**Answer:** The questions should be written to file prefixed by the slug, can be gitignored as this need not be pushed to repo

### Q4: How is a triage run identified, and how many can run at once?
The answer endpoint must know which run the answers belong to. The spec also needs rules for a second triage request on a project that already has one running, and for a run whose browser tab has gone away.
**Suggested:** `POST /triage` gives each run an id and sends it in the first SSE event (`started`, with `{ runId }`). Only one triage run per project at a time: a second `POST /triage` while one is active returns 409 `{ error: "a triage run is already active for <project>" }`. The run lives in server memory only. If the SSE connection closes (the drawer is closed or the tab is gone), the server kills the `claude` process and forgets the run. After that, an answer for that id returns 404.
**Answer:** `POST /triage` gives each run an id and sends it in the first SSE event (`started`, with `{ runId }`). Only one triage run per project at a time: a second `POST /triage` while one is active returns 409 `{ error: "a triage run is already active for <project>" }`. The id should be persisted to file system in worktree, so the see connection can be restored on refresh/crash-reload/ reopen the browser

### Q5: SSE over POST, and the shape of the events
The brief says `POST /api/projects/:name/triage` "initiates the triage agent and streams events via SSE". The browser's `EventSource` only supports GET, so the client must read the POST response as a stream with `fetch`. The spec also needs the exact event names and payloads that the tests in `web/test/server.test.ts` will assert on.
**Suggested:** The POST body is `{ report: string, quick?: boolean, model?: string }`, and the response is `text/event-stream` read with `fetch`. Events:
- `started {runId}`
- `text {text}` (agent prose)
- `tool {name, summary}` (one line per tool call, e.g. "Read src/triage.ts")
- `question {questions:[{id,text,options?}]}`
- `draft {drafts:[{slug,type,priority,title,brief}]}`
- `done {code}`
- `error {message}`

Raw reasoning is not shown; prose and tool lines count as "progress". Validation errors (an empty or whitespace-only `report`, an unknown project, a missing triage prompt) return plain JSON 400/404 before any stream starts, using the `{ error }` shape the server already uses.
**Answer:** accept

### Q6: How does the user choose a quick (non-interactive) run?
The brief says the UI handles both interactive runs and quick runs equivalent to `--print`, but not how the user picks one, or what a quick run does when the agent has open points.
**Suggested:** The drawer has a "Quick (no questions)" checkbox, off by default. When it is on, the request sends `quick: true`. The server builds the prompt with `headless: true`, so open points go under "Open questions" in the brief and no `question` events are ever emitted. There is no model picker in the drawer: the server uses the same model the CLI `triage` uses by default.
**Answer:** accept

### Q7: Loading the draft over a form the user has already edited
When the draft arrives, it fills slug, type, priority, title and brief. The user may already have typed into the form. The draft's priority may also not be one of the form's options: the form offers P1/P2/P3, but the skill also allows `P0 (security or data loss)`, and its P3 label is "P3 (nice to have)" while the form's is "P3 (low)". The draft's slug may also already be taken.
**Suggested:**
- If the form differs from the empty template, ask "Replace the current form with the draft?" before overwriting. Otherwise fill it straight away.
- Add `P0 (security or data loss)` to the form's priority options.
- Map any priority to the form option with the same `P<n>` prefix. An unknown value falls back to `P2 (normal)` with a visible note.
- Fill a taken slug as it is. The form's existing "already in the backlog" check then blocks Save until the user changes it.
- The run never saves on its own.
**Answer:** accept

### Q8: Timeouts, stop, and failure of the `claude` process
The spec needs the behaviour for:
- `claude` not being installed (spawn error, code 127 in `runClaude`)
- a non-zero exit
- a run that never finishes
- the user wanting to stop a run halfway
**Suggested:**
- The drawer has a Stop button. It closes the stream, and the server kills the process.
- A spawn failure or a non-zero exit emits `error {message}` (for a missing binary: "claude was not found on PATH") followed by `done {code}`. The form is left unchanged.
- There is no server-side time limit beyond the user's Stop. A wait for answers has no limit either, because the process has exited and nothing runs while it waits.
**Answer:** accept

## Round 2 (2026-10-30)

### Q1: Which worktree and branch does a triage run use, and what gets committed?
Round 1 Q1 says the run writes the report, questions, index entry and brief into "a git worktree", and the worktree name is tracked. Pipeline worktrees today are `<worktree base>/<slug>` on branch `<branchPrefix><slug>` (`start` in `src/runs/index.ts`). A triage run starts before any slug exists, and it can produce several slugs. The spec needs four things: the worktree path, the branch (or a detached HEAD), the base it starts from, and whether anything is committed there. These decide clean-up, the 409 rule and how Save works.
**Suggested:** Each run gets its own worktree at `<worktree base>/triage-<runId>` on a new branch `<branchPrefix>triage-<runId>`, created from the same base `start` uses (`pickBase`). The agent writes as the skill says: one `<backlog>/<slug>/brief.md` per item, plus its line in `<backlog>/index.md`, all inside that worktree. Nothing is committed on the triage branch. Run files go in `<backlog>/.triage/<runId>/` inside the worktree: `report.md` (the user's text), `run.json` (runId, state, Claude session id, pid, slugs, timestamps), `events.jsonl` (every SSE event sent) and the questions files (see Q3). A `.gitignore` containing `*` in that folder keeps them out of git, the same way the pipeline already handles `logs/`. The project's own `.gitignore` is not touched. The server also keeps a pointer file `<registry dir>/triage.json` (`{ runId, worktree }`). This lets it find the active run after a reload or a server restart without scanning folders. The CLI `ai-sdlc-helper triage` keeps its current behaviour.
**Answer:** accept

### Q2: What does "each item triaged independently" mean as a flow?
Round 1 Q2 says the agent can suggest several items from one report, the user accepts one or more of them, and "each item should be triaged independently". This could mean (a) one agent session splits the report and writes every brief, and the user then accepts briefs one by one. Or it could mean (b) a first pass only proposes the split, and then each accepted item gets its own agent session, with its own questions and its own brief. The choice changes the events, the questions files and how long a run takes.
**Suggested:** (b), as two phases inside one run.
1. **Split:** the agent reads the report and the backlog (including the duplicate check) and writes `<backlog>/.triage/<runId>/items.json`, holding `[{ slug, type, priority, title, summary }]`. It writes no briefs yet. The server emits `items {items:[...]}`, and the run state becomes `choosing`.
2. **Selection:** the user ticks the items to keep and posts them to `POST /api/projects/:name/triage/items` with `{ runId, slugs: [...] }`. If they keep zero items, the run ends as `done` and no briefs are written.
3. **Item sessions:** each kept item then gets its own agent session, one after another in list order, never in parallel. Each session writes that item's brief and index line in the worktree, may ask its own questions (Q3), and ends with a `draft` event for that one slug.

With `quick: true`, step 2 is skipped and every proposed item is kept, item sessions are headless (no questions), and each brief puts its open points under "Open questions".
**Answer:** accept

### Q3: Questions file: name, format, and how answers reach the agent
Round 1 Q3 says questions are written to a file "prefixed by the slug" and gitignored. The spec needs the exact path, the file format, how the server learns that questions are waiting, the body of `POST /triage/answer`, and how the agent continues afterwards. The options are resuming the same Claude session or starting a fresh agent that reads the file. Round 1 Q5 already fixed the event as `question {questions:[{id,text,options?}]}`.
**Suggested:** The path is `<backlog>/.triage/<runId>/<slug>-questions.md` (gitignored by Q1's `.gitignore`). It uses the format the pipeline already parses (`### Q<n>: <title>`, the question, `**Suggested:**`, an empty `**Answer:**`), with at most 4 questions per round. The agent writes the file and ends its turn. When the session exits and the file has unanswered questions, the server emits `question {slug, questions:[{id:"Q<n>", text, suggested}]}` (no `options`), and the run state becomes `waiting`. The body of `POST /triage/answer` is `{ runId, slug, answers: { "Q1": "...", ... } }`. The server writes the answers into the file, where "accept" means the Suggested value as in the pipeline. It returns 400 if any question is left unanswered, 404 for an unknown runId or slug, and 409 if the run is not `waiting`. It then continues the same session with `claude -p --resume <session id>`, sending a message that names the answered file. Answered files stay in place for the record.
**Answer:** accept

### Q4: Lifetime of the claude process, and how the browser reconnects
Round 1 Q4 says the run id is persisted so the SSE connection "can be restored on refresh/crash-reload/reopen the browser". This replaces the suggestion that a closed connection kills the process. The spec still needs four things: whether the agent keeps running with no browser attached; what happens if the web server itself stops; which endpoint the browser uses to reattach (`POST /triage` only starts runs, and `EventSource` only does GET); and whether past events are replayed.
**Suggested:**
- **Browser gone:** the agent keeps running when no browser is connected. Every event is appended to `events.jsonl` (Q1).
- **Finding the run:** `GET /api/projects/:name/triage` returns `{ run: { runId, state, worktree, slugs } | null }`. When the New Item screen opens and a run exists, the drawer reopens on its own.
- **Reattaching:** `GET /api/projects/:name/triage/events?runId=<id>` is an SSE stream. It first replays every stored event, then streams new ones until `done`. It returns 404 for an unknown or stale runId. Several viewers may attach at once.
- **Server stops:** the agent is a child of the web server and is killed when the server stops. On the next start the server sees that the recorded pid is dead and marks the run `interrupted`. `POST /api/projects/:name/triage/resume` with `{ runId }` then continues it from the last session id. Work already written in the worktree is kept, so nothing is re-run that already finished.
**Answer:** accept

### Q5: When does a run stop blocking new runs, and who removes the worktree?
The decision "one triage run per project, 409 otherwise" (Round 1 Q4) needs a definition of "active", now that runs survive disconnects and leave a worktree behind. Round 1 Q8's Stop button "closes the stream and the server kills the process", but closing the stream no longer stops anything. The spec needs the Stop and Discard actions, plus the clean-up rule for the worktree and branch.
**Suggested:**
- **States:** a run is `running`, `choosing`, `waiting`, `ready` (drafts available), `interrupted`, `stopped`, `failed` or `done`. Every state except `done` counts as active and makes a new `POST /triage` return 409.
- **Stop:** `POST /triage/stop` with `{ runId }` kills the process and sets `stopped`. The worktree is kept, so the run can be resumed or discarded.
- **Discard:** `POST /triage/discard` with `{ runId }` kills any process, then removes the worktree (`git worktree remove --force`), its branch and the registry pointer. It needs a confirm in the UI.
- **Done:** once every kept draft has been saved through the form or skipped, the run becomes `done`, and the server removes the worktree, the branch and the pointer in the same way.
- **Failures:** a spawn failure or non-zero exit emits `error` then `done {code}` as in Round 1 Q8, but the run state becomes `failed`, which stays active until it is resumed or discarded.
**Answer:** accept

### Q6: How a draft in the worktree reaches the form, and how several are saved
Round 1 Q7 (accepted) says the form is filled from the draft and the run never saves on its own. The brief says Save goes through the existing form. Save writes to the main working tree via `addBacklogItem`. The briefs, though, now live in the triage worktree, and there may be several. The spec needs the source of the draft's fields, the order in which several drafts go through the single-item form, and what marks a draft as saved.
**Suggested:**
- **Building the draft:** the server builds each `draft` from the worktree. `brief` is the full `<backlog>/<slug>/brief.md`; `type`, `priority` and `title` are parsed from the brief's `Type:` and `Priority:` lines and from the item's index line (the text after `Bug:`/`Feature:`). A brief whose `Type:` is not `bug` or `feature` emits `error` for that slug and is not offered.
- **Saving:** the drawer lists the drafts. "Load into form" fills one of them, with the Q7 replace prompt and priority mapping. Save and Save and start use the existing `POST /backlog` unchanged, so the item lands in the main working tree, never by merging the triage branch. After a successful Save of a slug that matches a draft, the client calls `POST /triage/saved` with `{ runId, slug }`, which marks it saved in `run.json`. "Skip" marks it skipped.
- **Moving on:** the drawer then offers the next unsaved draft.
**Answer:** accept

## Round 3 (2026-10-30)

### Q1: When is `done {code}` sent, now that one run has several agent sessions?
Round 1 Q8 and Round 2 Q5 say a spawn failure or non-zero exit sends `error` and then `done {code}`. Round 2 Q4 says the reattach stream (`GET /triage/events`) sends events "until `done`". But a run now has a split session and one session per kept item. It also pauses in `choosing` and `waiting` with no process running, and it can move to `ready`, `stopped` or `done`. The spec has to say which of these moments sends `done`, what `code` holds each time, and whether the SSE streams (the `POST /triage` response and `GET /triage/events`) close after it. If they close, the drawer has to reattach after Items, Answer and Resume. `web/test/server.test.ts` will assert on this event order.
**Suggested:** `done {code}` means "no agent will run again until the user acts, and none is waiting for a choice or for answers". It is sent once when the run enters `ready` (code 0), `failed` (the session's exit code, 127 for a missing `claude`), `stopped` (code 130) or `done` (code 0, including when zero items are proposed or kept). Both streams close after `done`. `choosing` and `waiting` do not send `done`: the streams stay open, and the run's next events (after `POST /triage/items` or `POST /triage/answer`) arrive on them. `POST /triage/resume` returns JSON `{ ok: true, run }`, and the drawer then reattaches with `GET /triage/events`. That stream replays every stored event, including earlier `done` events, and then stays open until the next `done`.
**Answer:** accept

### Q2: Is the registry pointer `triage.json` one file per project, or one file keyed by project?
Round 2 Q1 (accepted) puts the pointer at `<registry dir>/triage.json` with `{ runId, worktree }`. The registry dir is shared by every project, and each project may have its own active run (the 409 rule is per project). One `{ runId, worktree }` object can hold only one run. The dashboard also lists unregistered projects (the git repository `ui` was started in), and these have no registry entry.
**Suggested:** `triage.json` is one object keyed by the project's absolute root path: `{ "<root>": { runId, worktree } }`. The server adds a key when a run starts and removes it on Discard or `done`. A key whose worktree folder no longer exists is dropped when the server reads the file. Registered and unregistered projects are treated the same.
**Answer:** accept

### Q3: Can a draft be saved or skipped while later items are still being triaged?
Item sessions run one after another (Round 2 Q2), and each sends its own `draft` event. Round 2 Q6 has the drawer list drafts with "Load into form" and "Skip", and `POST /triage/saved` marks one saved. The spec does not say if that is allowed only once the run is `ready` (every kept item has a draft), or as soon as a draft arrives while the run is still `running` or `waiting` on a later item. The answer decides when `POST /triage/saved` and the skip call return 409, and what the drawer enables.
**Suggested:** A draft can be loaded, saved or skipped as soon as its `draft` event arrives, whatever state the run is in, unless the run is `done` or discarded. `POST /triage/saved` and the skip endpoint `POST /triage/skip` (`{ runId, slug }`) return 404 for an unknown runId or a slug with no draft, and 409 if that draft is already saved or skipped. The run becomes `done` only when every kept item has a draft and every draft is saved or skipped. Saving early never stops or changes the item sessions still to come.
**Answer:** accept

## Round 4 (2026-10-30)

### Q1: A session that exits 0 but leaves nothing usable
Round 1 Q8 and Round 2 Q5 define failure only as a spawn error or a non-zero exit. Round 2 Q6 says a brief whose `Type:` is not `bug` or `feature` "emits `error` for that slug and is not offered". Round 3 Q3 says the run becomes `done` only when every kept item has a draft and every draft is saved or skipped. Nothing says what happens when a session exits 0 but its output is missing or broken:
- the split session writes no `items.json`, or one that is not valid JSON or not the `[{ slug, type, priority, title, summary }]` shape, or has a duplicate or non-slug `slug`;
- an item session writes neither `<backlog>/<slug>/brief.md` nor an unanswered `<slug>-questions.md`;
- an item session writes a brief with no index line, or with a bad `Type:` (the Round 2 Q6 case). Here the item never gets a draft, so the run could never reach `done`.
This decides the run state, the event order that `web/test/server.test.ts` asserts on, and whether later item sessions still run.
**Suggested:** Treat each of these like a non-zero exit. The server emits `error {message}` naming the file and the problem (for an item session, the slug too), sets the run to `failed`, and sends `done {code: 1}`. Item sessions still to come do not start. Drafts that were already sent stay available to save or skip. `POST /triage/resume` re-runs only the session that failed (the split, or that one item), continuing its Claude session id. Discard is still available.
**Answer:** accept

### Q2: Uncommitted state of the main working tree in the triage worktree
Round 2 Q1 creates the triage worktree from `pickBase`, the base `start` uses. `start` (`src/runs/index.ts`) also copies an uncommitted `sdlc.config.json` from the main working tree into the worktree. The triage skill checks the backlog for duplicates and picks slugs that are not taken. But backlog items saved through the form are written to the main working tree uncommitted ("writes in the main working tree · not committed"), so they are not in the base. An agent working in the worktree would not see them. It could propose a duplicate, or a slug that is already taken.
**Suggested:** When the server creates the triage worktree, it copies an uncommitted `sdlc.config.json` the same way `start` does. It also copies the main working tree's current `<backlog>/index.md`, and every `<backlog>/<slug>/brief.md` missing from the base, into the worktree before the split session starts. The duplicate check and the slug choice then see the same backlog the form does. Nothing else is copied.
**Answer:** accept

## Round 5 (2026-10-30)

### Q1: Stop, Resume and server restart when no agent process is running
Round 2 Q5 defines Stop as "kills the process and sets `stopped`", and Round 2 Q4 says that on restart the server "sees that the recorded pid is dead and marks the run `interrupted`". A run also spends time with no process at all: `choosing`, `waiting` and `ready`, plus `failed`, `stopped` and `interrupted`. The spec has to say four things. Is `POST /triage/stop` allowed in those states? Does a server restart change them? Which states may `POST /triage/resume` be called from? And what does Resume of a `stopped` or `interrupted` run continue? `web/test/server.test.ts` will assert on the status codes.
**Suggested:**
- Stop is only allowed while the run is `running`. In any other state it returns 409 `{ error: "run <runId> is <state>, not running" }`.
- On start-up, the server marks a run `interrupted` only if it was `running` and its recorded pid is dead. Runs in `choosing`, `waiting` or `ready` keep their state, and the browser can carry on with them through the normal endpoints.
- Resume is allowed only from `stopped`, `interrupted` or `failed`. Any other state returns 409. Resume continues the session that was running (the split, or that one item) with `claude -p --resume <session id>`, telling it to carry on where it left off. Item sessions that had not started yet then run in order, as usual.
- An unknown runId returns 404 on every endpoint.
**Answer:** accept

### Q2: Failures while creating the triage worktree
`POST /triage` has to create the worktree and branch (Round 2 Q1) and copy the config and backlog (Round 4 Q2) before the split session can start. This can fail in several ways: the repository has no commit (`pickBase` returns nothing; `start` refuses with "the repository has no commit to start the branch from"), `git worktree add` fails, or the branch or folder already exists. The spec has to say whether these errors come back as plain JSON before the stream starts (like the Round 1 Q5 validation errors) or as `error` + `done` events inside the stream. It also has to say what is left behind.
**Suggested:** The worktree is fully set up before the SSE response starts. Any failure returns JSON 400 `{ ok: false, error }` with git's message, or for no commit the same text `start` uses. Nothing is left behind: a half-created worktree and branch are removed, no `triage.json` key is written, and the project can start a new run straight away.
**Answer:** accept

### Q3: Telling saved and skipped drafts apart after a reload
Round 2 Q6 and Round 3 Q3 record saved and skipped drafts in `run.json` through `POST /triage/saved` and `POST /triage/skip`. When the drawer reattaches (Round 2 Q4), it rebuilds itself from `GET /triage` (`{ runId, state, worktree, slugs }`) and the replayed events. Neither of those says which drafts are already saved or skipped. Without that, the drawer would offer finished drafts again after a refresh, and a second viewer would not see the change.
**Suggested:** Each draft in the `GET /triage` run summary also carries a status: `drafts: [{ slug, status: "pending" | "saved" | "skipped" }]`. Saved and Skip also send a `marked {slug, status}` event, which is stored in `events.jsonl`. Replay and other viewers then see it too. Neither event is `done`, so the stream stays open.
**Answer:** accept

### Q4: An item session that leaves both a brief and unanswered questions
Round 2 Q3 says that when a session exits and `<slug>-questions.md` has unanswered questions, the server emits `question` and the run waits. Round 2 Q6 builds a `draft` from `<backlog>/<slug>/brief.md`. Round 4 Q1 covers a session that leaves neither file. It does not cover a session that leaves both. The same gap exists for a quick run, where no `question` events may be sent (Round 1 Q6), but the agent might still write a questions file.
**Suggested:**
- In an interactive run, unanswered questions win. The server emits `question`, the run goes to `waiting`, and no `draft` is sent for that slug until a later turn of the session ends with no unanswered questions.
- In a quick run, a questions file is ignored. The brief alone decides: a valid brief gives a `draft`. With no brief, the Round 4 Q1 failure applies.
**Answer:** accept
