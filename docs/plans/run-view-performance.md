# Run page and run view: plan to stop rebuilding it every 2 seconds

Status: proposed, nothing implemented. Not a backlog item (the pipeline does not pick it up).
Each step below is its own small PR into `main`; stop after any step.
It builds on `docs/plans/dashboard-performance.md`, which covers the **board**; this plan covers the **run page** and the
endpoint it polls, `GET /api/projects/<project>/runs/<slug>`. Where a step there already helps, this plan points at it and does not repeat it.
The design the user asked for: **the server watches for changes and pushes them over SSE, with a heartbeat in between; the client
polls only as a backup when the heartbeat stops.**

Claim status tags: **[measured]** run and timed here, **[verified]** read in the code, **[reasoned]** argued, not run,
**[design]** a proposal whose numbers are starting points, **[estimate]** a saving not measured on a built fix.

## 0. What the user asked or clarified

| # | The user said or asked | What it added | Where it is handled |
|---|---|---|---|
| U1 | Quote: "Is there any change planned to reduce number of api calls to check status of the task" | Answer: none planned. The board plan does not mention this endpoint or its two pollers (R4). | Section 1 |
| U2 | Quote: "What does server do on the get request" | The step-by-step walk of what one request does (R2). | Section 1 |
| U3 | Quote: "Each request takes lot of time, plan a re-build similar to docs/plans/dashboard-performance.md - no need to rebuild every 2 second" | The task of this plan: make a request cheap, and stop asking when nothing changed. | Sections 2 to 5 |
| U4 | Quote: "when the project is running, why do the client need to poll every 2 seconds? Can the server push any chnges as sse? and the polling be kept as a backup only when no sse appear for say 2 minutes?" | The design: push over SSE, polling as a backup. Answer to "why poll": it does not need to (R6). | Sections 2 and 4 |
| U5 | Quote: "why rebuild every 2 seconds? Can the server watch any file change and only when anything changes, rebuild and push to client side? and in between keep sending a heartbeat saying I am still alive." | The server watches files and rebuilds only on a change; a heartbeat in between (R6, sections 3 and 4). | Sections 3 and 4 |
| U6 | Quote: "If client identify no heartbeat for 1 minutes, what to do?" | The reconnect and fallback rules (section 4). The silence limit is now 1 minute, not the 2 minutes of U4. | Section 4 |
| U7 | Quote: "Put everything to the plan first" | This version of the plan. | All |
| U8 | Quotes: "A crashed process writes no file. - check only in 30 seconds" and questions about uncommitted counts, `run.out` and missed events | The liveness check is every 30 s, sharing one tick with the safety rebuild. The answers corrected a claim: `run.out` is not constantly written. | Section 3 |
| U9 | Quote: "Make sure the changes log eah action that repeats with micro time so the actions are visible and verify if the much reccurence is really required." | A trace of every repeating action with microsecond times, a report, and a rule that each repeat must change the result or be a named guard (section 4a; Step 0b). | Section 4a, Steps 0b and 7 |

## 1. What one request costs now

- **R1** One request takes about 0.55 s and starts 7 programs, all `git`, on a machine with load about 3 (6 requests each for
  three runs: 0.47 to 0.58 s, one cold outlier at 1.7 s; the response is 4.6 to 5.8 KB and identical between requests). [measured]
- **R2** Where the 7 spawns come from (per request). [measured spawn log, verified in `web/server/index.ts:249-252`, `src/runs/view.ts:182`]

  | Part | Spawns | Time | What for |
  |---|---|---|---|
  | `contextFor` → `runContext` | 3: `rev-parse --git-common-dir` x2, `rev-parse --show-toplevel` | about 230 to 290 ms with the settings resolve and the record scan | Rebuilds the project context from scratch; the same cost the board plan lists as F15 |
  | `runChanges` | 3: `merge-base`, `diff --name-only`, `status --porcelain` | together about 280 to 350 ms (full view 400 to 490 ms, without these 50 to 125 ms) | Counts the changed files and the uncommitted ones |
  | `redCommitOf` | 1: `log --grep` | about 80 ms, part of the 50 to 120 ms row below | The Red tests commit, for the resume options |
  | The rest of `runView`, with the Red tests commit | 1 (that `log --grep`), plus `kill(pid, 0)` and, for a live pid, `ps` | 50 to 120 ms in all | Status, questions, permissions, tests, stage files, the last 40 lines of `run.out`, the document list, the recovery hint |
  | `getPrStatus` (`gh pr view`) | 0 to 3, cached 60 s | up to 3 s when it runs | Only when a PR is known, the run is done, or the stage is Finalise |

  One `git` call costs 35 to 80 ms here (`rev-parse` 49 to 79 ms, `merge-base` 80 ms, `status` 35 ms, `log --grep` 81 ms). [measured]
- **R3** The spawns are synchronous, so the server's event loop is blocked for the whole request (the board plan's F15). One open
  run page therefore keeps the server busy roughly a quarter of the time (0.55 s every 2 s), and every other request waits behind it. [reasoned from R1 and the synchronous calls]
- **R4** Two pages poll it, and neither asks "did anything change". [verified]
  - The run page: `web/ui/src/Run.tsx:275`, every 2 s, from opening the page until leaving it, even for a run that is done or not started.
  - The board's drawer: `web/ui/src/Board.tsx:41`, every 2.5 s, for the selected run. It shows only the title line and the last 12 lines of output (`Board.tsx:48-53`), but it fetches the whole view, git counts and PR check included.
  - Neither stops when the browser tab is hidden.
- **R5** Most of a request is work whose answer did not change. The context, the changed-file counts and the Red tests commit change at a stage boundary or when the developer edits files; the status files change a few times a minute. The part that does change every second is the output tail. [reasoned]
- **R6** (user, U4 and U5: why poll, why rebuild every 2 s) Nothing tells the page or the server that something changed, so both find out by
  asking again. The page polls the run endpoint every 2 s (R4). The board's SSE stream (`/api/events`) is push only on the last hop: the server
  rebuilds the whole board every `pollMs` (2 s) and sends it only when the JSON differs (`web/server/index.ts:392-401`). So the
  polling has moved into the server; it has not gone away. [verified]
- **R7** Today's stream facts the design builds on. [verified in `web/server/index.ts:380-402` and `web/ui/src/App.tsx:112-129`]
  - On connect the server pushes the current board at once (`push()` before the timer), so a new connection is a full snapshot.
  - The server writes `: ping` every 15 s. That is an SSE **comment line**: the browser's `EventSource` does not hand comments to the page's
    JavaScript, so the page cannot see it (standard behaviour [reasoned]; to be proved by the Step 4 test). The ping keeps proxies from closing an idle connection and does nothing for the page.
  - The page sets `es.onerror` to show "Lost the connection to the server; retrying…" and has **no watchdog**: a connection that dies without an error is never noticed.
  - `EventSource` reconnects on its own after an error (about 3 s by default). [reasoned, standard]

## 2. The design in plain words

The server learns about changes from the files the pipeline already writes, rebuilds only the part those files feed, and pushes it.
Between changes it sends a heartbeat so the page knows the connection is alive. The page polls only when the heartbeat stops.

Three kinds of fact, each with its own rule:

| Kind | Examples | Costs | Rule |
|---|---|---|---|
| **Live** | state, stage, attempt, questions, permissions, test counts, stage files, the document list | file reads only (and the cheap process check) | Rebuilt and pushed when a watched file changes (debounced) |
| **Output** | the tail of `run.out` | one file read | Pushed only to a page that has the run open, only when the file grew, at most once a second |
| **Git facts** | changed and uncommitted counts, Red tests commit, PR state | 4 to 7 spawns | Cached; refreshed at a stage change, at run end, when the page opens or gets focus, from a refresh button, and on a slow timer while running; marked as possibly stale |

The user already decided for the board that stale uncommitted counts are acceptable (`dashboard-performance.md`, section 8). The run page extends that, and the plan asks for it to be confirmed (section 7).

Why the git facts must be cached **together with** the watcher: a rebuild after a change would otherwise still cost 0.55 s (R1); the watcher would only change how often, not how much. [reasoned]

## 3. What the server watches, and what a watcher cannot see

- **Watched** (one watcher per server, shared by all clients; `dashboard-performance.md` F16 and Step 6): the run register folder (`<git common dir>/sdlc-runs`), each run's `logs` folder (`status.json`, `permissions.json`, `stage-files.json`, `tests.json`, `finalise-options.json`), `questions.md`, the backlog folder's `index.md` and run documents.
- **Debounce** about 100 to 300 ms; in the measured experiment (macOS, one folder) events arrived in 4 to 14 ms and a burst of 5 writes gave 12 events (`dashboard-performance.md` F16). [measured, easy case]
- **`run.out`:** the pipeline's own console log (stage and attempt lines, warnings, the output of the one-time setup commands). It is **not** written constantly: the largest one here, a whole run of `add-setup-branch-pr`, is 127 lines and 9.5 KB, written at stage and attempt boundaries; the agents' own output goes to separate `<name>.json` and `.log` files, and test output to `tests.log`. [measured on the runs in this repository; the first setup of a worktree (`npm ci`) can write a burst, not measured]
  Only the run page shows its tail, so the board does not watch it (`dashboard-performance.md` F20 calls it noisy; that was not measured there). The run stream watches it like the other files, with a cheap guard (a throttle of one push a second, section 5, Step 4) for a burst.

What a watcher cannot see, and what covers it:

| Gap | Covered by | Cost |
|---|---|---|
| A crashed or killed process writes no file | A liveness checker: `kill(pid, 0)` every **30 s** (the user's choice, U8) for runs marked running only, so a crash can show as "running" for up to 30 s; an event when a pid dies. It needs the start-time check from `dashboard-performance.md` Step 4 so a reused pid does not read as running. It does not cover the orphaned-pipeline case (F12 there). | microseconds per run (`kill(pid, 0)` about 0.5 µs for a dead pid) |
| Uncommitted edits change no git metadata (the committed part of the change count does: the worktree's `HEAD` moves at every commit, and the pipeline commits at each stage's end, so a watcher on it covers that part) | The git facts' refresh points (section 2) and the 30 s tick | the git spawns, only at those points |
| A missed or merged watch event | A safety rebuild of the live part on the **same 30 s tick** as the liveness check, while a client is connected; it pushes only if the result differs | about 50 to 120 ms of file reads per tick, shared by all clients; no spawns (the git facts stay cached) |
| Node 18 on Linux may not watch folders recursively | One watcher per folder; to be checked before relying on it (`dashboard-performance.md` F16, "not tested") | |

## 4. The heartbeat, the silence rule and the fallback (user, U4 to U6)

Rules. [design; every interval is a starting point to be tuned after Step 7]

1. **Heartbeat is a named event.** The server sends `event: ping` (with a counter or time) every 15 s on each stream, in addition to the SSE comment it sends today if a proxy needs it. A comment is invisible to the page (R7).
2. **Every event resets a watchdog.** Any event the page receives, a change or a ping, restarts a timer. The page knows how long it has been since the last one.
3. **No event for 60 s (four missed pings) means the connection is dead.** It may be half-open, so the browser still thinks it is connected. The page then:
   1. closes the `EventSource` and opens a new one (it does not wait for the browser's own retry);
   2. does **not** fetch separately when the new stream opens: the server pushes a full snapshot on connect (R7), which replaces what the page had;
   3. if the new connection fails or stays silent, starts **backup polling** with one `GET` every 10 s, backing off to 30 s, and shows "connection lost, retrying" after a couple of failures;
   4. stops polling and drops the banner when the stream delivers its next event.
4. **A browser error** (the server restarted, the network dropped) makes `EventSource` reconnect on its own; the page keeps showing its last state with the "retrying" banner after the second failure.
5. **Hidden tabs:** browsers slow timers in background tabs, so the 60 s watchdog can fire late or wrongly. When the tab becomes visible the page checks the time since the last event and reconnects if it exceeds 60 s. A hidden tab needs no polling at all.
6. **A finished run** (`done`, `failed`, `stopped`, `refused`, `interrupted`, `not started`) needs no stream and no polling: one load when the page opens, again after the user acts, and on focus.
7. **Silence is not proof of a problem.** An agent that thinks for five minutes writes nothing, so a quiet run is normal; that is why the rule keys on the **heartbeat** and not on "no change for two minutes" (user's first proposal, U4). The server never stays silent longer than the 15 s ping interval, so any silence the page sees is a connection problem.

The 1-minute limit (U6) replaces the 2-minute one (U4); section 7 asks the user to confirm.

## 4a. Make every repeat visible, and prove it is needed (user, U9)

The numbers in section 1 came from a throwaway shim. The user asks that the change itself log each action that repeats, with a
microsecond time, so the repeats can be seen at any time, and that the plan check whether so much recurrence is really required.

**The trace.** [design]
- One helper, `trace(action, detail)` (for example `src/runs/trace.ts`), writes one JSON line per event to `<registry folder>/ui-trace.jsonl`
  (the folder the run records live in). It is **off by default** and switched on with `SDLC_TRACE=1` (or a `ui --trace` flag), because
  writing a line per spawn is itself work; the file is capped and rotated.
- **Microsecond time:** `t` is epoch microseconds taken from `performance.timeOrigin + performance.now()`. `performance.now()` returns
  fractions of a millisecond on this machine (it printed `14.1395`), so the third decimal is microseconds. [measured] Durations use the same clock.
- **Fields:** `t` (µs), `side` (`server` or `client`), `action`, `why` (the cause: a timer name, a changed path, a client id), `run`, `ms` (how long it took), `changed` (did the result differ from the previous one: true, false, or absent), `n` (a counter per action).
- **What is logged** (every action that can repeat): each `git`, `ps`, `gh` spawn (the 24 `spawnSync` calls in `src` outside `src/cli`, by `grep`, spread over `src/runs/records.ts`, `src/pipeline/finalise.ts`, `src/runs/index.ts`, `src/runs/completed.ts`, `src/runs/supervisor.ts` and others, go through one traced helper; [verified] count); each `kill(pid, 0)`; each timer tick (liveness, safety rebuild, throttle); each watch event and whether it led to a rebuild; each rebuild of the board or a run view and its `changed` result;
  each request to `/api/...` and each SSE event sent (`board`, `run`, `tail`, `ping`, `problem`);
  on the page, each request, each stream event received, each watchdog firing, each reconnect and each backup poll (kept in memory and printed with `?trace=1`; the page does not send it to the server).
- **The report.** A small script (for example `scripts/trace-report.mjs`) reads the file and prints one row per `action` + `why`: events per minute, the share with `changed:false`, the median and total milliseconds per minute. Rows are sorted by total time.

**The test of "is this recurrence needed".** [design; the thresholds are starting points]
- A repeating action is justified only if it either **changes the result** often enough to matter, or is a **named guard** with a written reason.
- Each action in the report must be one of:
  - *needed*: most of its runs end with `changed:true`, or it is the heartbeat (4 pings a minute per stream);
  - *a guard*: it mostly ends with `changed:false` on purpose, and the plan names why and its interval (the 30 s liveness and safety tick; the 1 s output throttle);
  - *a finding*: anything else. A finding is slowed, merged with another action or removed, and the report is run again.
- Expected inventory of repeats on a connected, idle run page after Steps 4 and 5: 4 pings a minute, 2 ticks a minute, no spawns, no requests. A running page adds only change-driven events. Anything beyond that is a finding. [design target, not a measurement]
- Today's expected repeats (to be confirmed by the first trace, Step 0b): 30 requests a minute per open run page, each starting 7 spawns (about 210 spawns a minute), with nearly all of them `changed:false`; 30 board rebuilds a minute per connected tab. [estimate from R1 and R4]

## 5. Steps (each its own PR into `main`)

**Step 0: baseline (no code).** Use the throwaway method below. Baseline: 7 spawns and about 0.55 s per request; about 30 requests a minute from one open run page. Method: start `ai-sdlc-helper ui --port <n> --no-open` with a PATH holding logging shims for `git`, `ps` and `gh`, sign in with the printed token, then `curl -w '%{time_total}'` six times per run and count the log lines.

**Step 0b: make the repeats visible (code, first).** Add the trace helper, route the spawn sites through it, log the timers and the requests, add the page's in-memory trace and the report script (section 4a). Nothing else changes.
- Tests (`test/`, `web/test/server.test.ts`): the writer produces one JSON line per call with an integer `t` in microseconds that never goes backwards; the report script, run on a fixture trace file, prints the right counts, `changed:false` shares and sort order (the real script, no mocks); with `SDLC_TRACE=1`, one request for a run writes as many `spawn:git` lines as the counting `git` shim sees for the same request (the shim is the independent check); with the flag off, no file is written.
- Risk: low (off by default; a line per event when on). Check: the first report on an open run page shows the real recurrence; it replaces the estimates above and goes into the PR description.

**Step 1: ask less (client only; no server change).** In `web/ui/src/Run.tsx` and `web/ui/src/Board.tsx`, replace the fixed intervals with one small helper that returns the next delay:
- 2 s while the run is `running`; 5 to 10 s while `paused`; no timer when `done`, `failed`, `stopped`, `refused`, `interrupted` or `not started` (load once, again after the user acts, and on focus);
- no timer while the tab is hidden (`document.visibilityState`); one load when it becomes visible;
- the drawer needs only the title fields and the tail; it calls the same endpoint with `?parts=live,tail` once Step 3 exists, and keeps the full call until then.
- Put the delay rules in a file with no Preact imports (like `web/ui/src/resume.ts`) so tests can import it. This helper is reused by Step 5 for the backup polling.
- Tests (`test/`, next to `resume.test.ts`): the helper returns the delays above for each state and visibility; the real function, no timers.
- Risk: low (a state change by another process shows after the next focus or action). Check: requests per minute from an open page on a finished run fall from about 30 to 0. [estimate]

**Step 2: stop rebuilding the context (depends on `dashboard-performance.md`, Step 3).** That step caches the project context and rebuilds it only when settings or the registry change; the run routes must use it instead of calling `runContext` themselves (`web/server/index.ts:249-252`, `contextFor`).
- Tests (`web/test/server.test.ts`): with a counting `git`, 10 requests for one run make the 3 context spawns once; a settings change shows on the next request.
- Risk: medium (stale settings, shared with that plan). Check: spawns per request fall from 7 to 4. [estimate]

**Step 3: split `runView` and cache the git facts.** In `src/runs/view.ts`, `src/runs/index.ts` (`runChanges`) and `web/server/index.ts`:
- `runView` takes parts (`live`, `tail`, `git`), the way it already takes `changes`, `checkPr` and `tailLines`. The route takes `?parts=` and keeps today's full answer when it is absent.
- Cache the git facts per run (changed and uncommitted counts, Red tests commit, base), refreshed at the points in section 2. Each response says how old they are; the page shows a "may be stale" mark, as the board does.
- The Red tests commit needs no timer: it changes only at the Red tests boundary. A cached sha is verified with `git cat-file -e` before a resume decision uses it (`dashboard-performance.md` F8).
- Tests (`test/view.test.ts`, `web/test/server.test.ts`): with a counting `git`, 10 requests for an unchanged run make the git calls once; a stage change in `status.json` makes the next request refresh them; `?refresh=1` refreshes them; `?parts=live` makes no git call.
- Risk: medium (the stale mark must be shown; resume options must not rely on a stale Red tests commit). Check: spawns per request fall from 7 to 0 for repeat requests of an unchanged run. [estimate]

**Step 4: the per-run stream on the server (watcher, liveness checker, heartbeat).** New `web/server/watch.ts` (shared with the board plan's Step 6) and a route `GET /api/projects/<project>/runs/<slug>/events` in `web/server/index.ts`:
- On connect: a full snapshot (live part, tail, cached git facts with their age). Then an event per change of the live part, `tail` events for output (throttled to once a second as a guard for a burst, only when the file grew), `ping` events every 15 s (section 4), and a `problem` event on an error, as the board stream has.
- The watcher and the liveness checker (section 3) are shared by all clients of a run; they stop with the last client.
- The server rebuilds only the part the changed file feeds, using the cached git facts.
- Tests (`web/test/server.test.ts`): a `status.json` write reaches a client within a stated time; a burst of `run.out` writes is throttled to one push a second and a quiet file sends nothing but pings; the 30 s tick finds a change whose watch event was dropped (simulate by writing with the watcher paused); a `ping` event arrives and is visible to a client that listens for it (this proves R7's comment-line claim); two clients share one watcher and make no more spawns than one; a killed pid produces a state event within the checker's period; the stream stops with the last client; a late client gets a snapshot at once.
- Risk: medium to high (missed or merged events, watcher lifecycle). Check: a connected, idle run page makes about 0 spawns per second apart from the pings and the liveness check. [estimate]
- Open: Node 18 on Linux for recursive watching (`dashboard-performance.md` F16).

**Step 5: the client uses the stream; the watchdog and the fallback.** In `web/ui/src/Run.tsx`, `web/ui/src/Board.tsx` (the drawer) and `web/ui/src/App.tsx`, with the connection logic in a file with no Preact imports (for example `web/ui/src/stream.ts`):
- Open the stream for a running or paused run; apply a snapshot or a change to the page's state; the old interval becomes the backup of section 4 and uses the Step 1 delays.
- The watchdog (60 s), the reconnect, the backoff polling, the "retrying" banner and the visibility check are one small state machine that takes events and a clock, so it can be tested without a browser.
- The board's own stream (`App.tsx:112-129`) gets the same watchdog.
- Tests (`test/`, like `resume.test.ts`): feed the state machine pings and silence with a fake clock: 59 s of silence does nothing, 60 s closes and reopens, a failed reopen starts polling at 10 s and backs off to 30 s, the next event stops it; a hidden tab reconnects on becoming visible only when stale; a finished run opens no stream.
- Risk: medium (a bug here shows as a frozen page, so the backup polling must be exercised). Check: requests per minute from a running run's page fall from about 30 to about 0 while the stream is healthy. [estimate]

**Step 6 (optional): conditional GET for the backup path.** In the run route, build a fingerprint from the `mtime` and size of the run's record, `status.json`, `permissions.json`, `questions.md`, `stage-files.json`, `tests.json`, `finalise-options.json`, `run.out` and the backlog folder, plus the liveness answer; send it as an `ETag` and answer `304` on a match. A fingerprint of 15 paths costs about 23 µs (`dashboard-performance.md` F22). It makes each backup poll nearly free; skip it if Step 5 leaves the backup path rare.
- Tests (`web/test/server.test.ts`): a second request with the tag returns 304 and builds nothing; touching `status.json`, `run.out` or the record returns 200; a killed run changes the tag.

**Step 7: measure again (no code).** Repeat Step 0 and run the report of section 4a on an idle page and on a running run. Every row must be *needed* or *a guard*; each *finding* becomes a change or a written reason. Tune the intervals of section 4 on the built steps, not before.

Order: Step 0b first (the trace; without it nothing below can be judged), then Step 1 (client only, safest), then 2 and 3 (each stands alone), then 4 and 5 together in two PRs (Step 5 depends on Step 4's events), then 6 only if the backup path still matters.

## 6. Conventions for the work (CLAUDE.md)

Node 18 only. Tests live in `test/` or `web/test/`, run the real code and never assert on documentation. Name SDLC stages, never number them. Run `npm run check` before every commit and read its log. PRs go into `main`, and the user confirms each merge, naming the PR and its CI status. Use the `porter` subagent for step work, with a brief that names the exact files, the plan section and the definition of done.

## 7. Decisions and known gaps

Still open (the user decides; not decided here):
1. Is a "may be stale" mark on the run page's changed-file counts acceptable, as it is on the board?
2. The silence limit: 60 s (U6) or the 2 minutes of U4? The plan uses 60 s with a 15 s ping.
3. Should the board's drawer show only the tail (a lighter payload), or keep the full view?
4. Write these steps as backlog briefs for the pipeline, or implement them directly one step at a time?
5. Do Step 2 inside the board plan's Step 3, or as its own PR after it?
6. Do Step 4's watcher together with the board plan's Step 6, as one shared watcher? The plan assumes yes.
7. Is the trace off by default (`SDLC_TRACE=1`) as proposed, or always on with a small rotating file? Always on gives history without asking, but adds a write per spawn.

Known gaps:
- All timings were taken on one macOS machine with load about 3 and an idle server; none was taken in a browser, and none on a built fix.
- The breakdown in R2 sums the parts roughly (the profile ran in one process, the spawn log in the server); treat the milliseconds as orders of magnitude.
- R3 (the server busy about a quarter of the time) is arithmetic from R1 and a synchronous call, not a measurement of the event loop.
- The `EventSource` behaviour in R7 (comments hidden, reconnect after about 3 s) is standard behaviour, not tested here; Step 4's test is the proof.
- Every interval in section 4 is a starting point.
- Not measured: the board with many runs, the first-time setup output burst in `run.out`, Node 18 on Linux, how often a watcher drops events on this machine (the 30 s tick is a guard, not a measured need).
