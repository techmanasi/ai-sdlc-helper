# Web performance: the board, the run page and the run register

Status: ready to implement, one PR per step, **direct** (no backlog briefs).
Supersedes `docs/plans/dashboard-performance.md` (the board and the register)
and `docs/plans/run-view-performance.md` (the run page and `runView`). Both stay
in the repo for their evidence — measurements, findings (F-n), reviewer notes and
the user's answers (U-n) are not repeated here.

Grounded on `main` at 2026-11-12, where the trace, the per-run stream and the
cached git facts are already built (section 2). This plan therefore replaces
their "nothing implemented" status lines and starts from what is left.

## 1. Why one plan

They were never two problems. The board and the run page read the same files
through the same `runView`, are served by the same process, and were already
cross-linked three times: run-view's context cache was dashboard Step 3, its
watcher was dashboard Step 6, and its client work assumed the board's stream.
Two plans meant two baselines, two measurement steps, two watcher designs and
two chances to rebuild the same cache.

One plan makes the dependency visible: **the board is the expensive path** (every
tick builds every run), and the run page is already cheap because it has a
watcher. The board gets the same treatment, on the same machinery.

## 2. What is built — do not rebuild it

| Piece | Where | What it gives us |
|---|---|---|
| Always-on trace, rotating | `src/trace.ts`, `trace` block in `src/config/settings.ts` | every **traced** spawn (`src/runs/*`, `completed`, `finalise`), timer, request and SSE push, with microseconds. The board's own helpers are not routed through it yet — `Git.run` (`src/pipeline/git.ts`), `for-each-ref` (`src/backlog/index.ts`), `gitTop` / `runCommand` (`web/server/index.ts`) — so P0 fixes that before P1 and P3 rely on the numbers |
| Report script | `scripts/trace-report.mjs` | events/min, the `changed:false` share, median and total ms per action |
| Per-run stream | `web/server/watch.ts` | one watcher per run shared by every page; 150 ms debounce, 1 s tail throttle, 15 s ping, 30 s safety tick, stops with the last client |
| Run stream route | `web/server/index.ts` (`/api/projects/<p>/runs/<slug>/events`) | snapshot on connect, `run`, `tail`, `ping`, `problem` |
| Client state machine | `web/ui/src/stream.ts`, `useStream.ts` | 60 s silence rule, reconnect, 10→30 s backup polling, "retrying" banner, visibility handling |
| `runView` parts + cached git | `src/runs/view.ts` (`parts`, `cacheGit`, `refresh`) | repeat requests do no git work; the run route already asks for `['live','git']` |
| `gh` off the request path | `getPrStatusCached` in `boardView` | a slow PR check cannot freeze the server |
| Board counts every 5th read | `web/server/index.ts`, `events()` | cards do not flicker between refreshes |

Steps in the two old plans that this table covers: run-view Steps 0b, 3, 4, 5,
dashboard Step 1, and part of run-view Step 3b. Close them there, do not redo
them.

## 3. What is left

1. **The board is polled per client.** `events()` starts one `setInterval` per
   open tab and rebuilds the whole board — every run, through `runView` — each
   tick (`web/server/index.ts:437-471`). Three tabs cost three boards per tick.
2. **A board card builds the full run view.** `boardView` calls `runView` with
   `changes`, `tailLines` and `checkPr` but no `parts`, so it also resolves the
   worktree, reads documents, stage files, questions and permissions for every
   card (`src/runs/view.ts:504-518`).
3. **The register can lie.** The temp file name is shared (`${f}.tmp`,
   `src/runs/records.ts:59`), the record holds no process start time, and
   `alive()` is `kill(pid, 0)` plus `ps` (`src/runs/records.ts:74`), so a reused
   pid is reported alive and a concurrent writer can lose a write.
4. **Counts are refreshed, not cached.** No mtime cache for `for-each-ref` or
   `worktree list`; the only relief is the every-5th-read rule.
5. **The project context is rebuilt per request.** `contextFor` calls
   `runContext` on every GET (`web/server/index.ts:122`).
6. **No conditional GET.** A backup poll rebuilds even when nothing changed.
7. **Nothing has been measured since the stream shipped.** The old plans'
   measurements describe the pre-stream system; every saving they predict is an
   estimate.

## 4. Decisions

Decided with the user on 2026-11-12:

1. **Order: independent fixes first.** Land the small, self-contained steps
   before the measurement-and-tune pass. The disagreement itself (measure first
   or fix first) is recorded as a backlog item, to be picked up after this plan:
   `web-perf-measurement-order`.
2. **One shared watcher registry.** A folder is watched once, refcounted, no
   matter how many streams need it.
3. **Direct implementation**, one PR per step, not backlog briefs.

Carried over from the old plans (already the user's, unchanged):

4. Stale changed-file counts are acceptable if marked "may be stale".
5. Silence limit 60 s with a 15 s ping.
6. The board drawer shows only the tail; the full view loads on the run page.
7. The trace stays always on with a rotating file.

## 5. Steps (each its own PR into `main`)

Each PR records its own before/after with the trace report (section 6) in the
description. No step waits for another unless stated.

### P0 — Route the board's spawn sites through the trace

- **Files:** `src/pipeline/git.ts` (`Git.run`), `src/backlog/index.ts`
  (`for-each-ref`), `web/server/index.ts` (`gitTop`, `runCommand`),
  `src/runs/view.ts` (`mergeFixKept`, which spawns during a board read for a run
  in Resolve conflicts).
- **Change:** the trace helper wraps these the way it already wraps the run
  paths, so the board's spawns appear in the report at all. Nothing else changes.
- **Tests** (`test/trace.test.ts`): each helper writes one `spawn:<program>` line
  with the first argument only and an exit code; a counting shim sees the same
  number of calls the trace reports.
- **Acceptance (performance):** after P0, the trace report accounts for every
  spawn the shims see during a board read.
- **Risk:** low. Without this step P1's and P3's acceptance cannot be measured.

### P1 — Slim the board card

- **Files:** `src/runs/view.ts` (`runView`'s options, `boardView`, the `RunCard`
  fields it fills).
- **Change:** `parts: ['live', 'git']` alone is not enough: `runView` computes
  `redCommit` whenever the `git` part is wanted (`src/runs/view.ts:335-348`), so
  the card would still run `git log --grep`. Add a finer option (`redCommit?:
  false`, or a `git-facts` part separate from the red-tests sha) and have
  `boardView` skip the docs list, stage files, the question and permission
  **bodies**, recovery hint and the red-tests sha; the card keeps the counts it
  shows today (`questions.length`, `permissions.length`,
  `deniedPermissions.length`).
- **Tests** (`test/view.test.ts`): a card's fields equal today's for a fixture
  run, `changes` included; with a counting `git` on `PATH`, a board read makes no
  `git log` call; `parts: ['live']` still makes no git call at all.
- **Acceptance (performance):** a cold board's spawn count falls by one `git log`
  per run; a fixture board with 10 runs makes one `git for-each-ref`, no
  `git log`, and still shows each card's counts.
- **Risk:** low — only a card field dropped. The test above is the guard.

### P2 — Make the register honest

- **Files:** `src/runs/records.ts`, the embedded supervisor in
  `src/runs/supervisor.ts` (it writes records too), `src/runs/index.ts`.
- **Change:** a unique temp name per write (`<file>.<pid>.<n>.tmp`); store the
  process start time when a run starts; `alive(pid, startedAt)` is false when
  the running process's start time differs (a reused pid); records without the
  field keep today's behaviour. Check the start time when a run is first seen and
  again on a slow tick of 10 s that this step adds; `kill(pid, 0)` in between. P3
  reuses that same slow tick for its counts; it does not introduce one.
- **Tests** (`test/records.test.ts`, new): two real writers, no lost or
  unparseable read; a reused pid with a mismatched start time is not alive; an
  old record without the field still works; a record written by the supervisor
  is read by `status`.
- **Acceptance (SRE):** none of the above passes only by loosening an assertion;
  the trace shows no extra `ps` per poll (the start time is checked on the 10 s
  slow tick only).
- **Risk:** medium — it changes what `ai-sdlc-helper status` reports.

### P3 — Counts on a slow tick, cached by mtime

- **Files:** `web/server/index.ts`, `src/backlog/index.ts`
  (`for-each-ref`), `src/runs/records.ts` (`mainTree`, `worktree list`),
  `web/ui/src/Board.tsx` (the stale mark).
- **Change:** refresh the counts on the slow tick P2 added (10 s) or on demand;
  cache `for-each-ref` and `worktree list` on the mtime of `.git/refs` / the
  worktree list; the board card shows counts older than one tick as possibly
  stale.
- **Tests** (`web/test/server.test.ts`, `test/backlog.test.ts`, and an extension
  of `test/stale.test.ts`, which already covers the DOM-free
  `web/ui/src/stale.ts` helper): with a counting
  `git`, an idle project makes no calls between slow ticks; a new branch shows
  within one tick; `staleLabel` reports a count older than one tick as stale and
  a fresh value as fresh.
- **Acceptance (performance):** idle board spawns fall to about 0.1–0.3/s in
  total (the estimate from the old plan becomes a measurement).
- **Risk:** medium — a stale mark that is not shown turns "behind" into "wrong".

### P4 — One watcher registry

- **Files:** new `web/server/watchers.ts`; `web/server/watch.ts` uses it.
- **Change:** refcounted `fs.watch` per folder, never recursive (Node 18 on
  Linux does not support it), one debounce per subscriber, an `error` closes and
  drops the handle so the next tick re-attaches, and `stats()` for the trace and
  tests. Two streams needing the same folder get one handle.
- **Tests** (`web/test/watchers.test.ts`, new): two subscribers, one handle,
  closed when the last leaves; a watcher error drops it and the tick re-attaches;
  a folder removed under the watcher does not throw; a write reaches every
  subscriber once.
- **Acceptance (SRE):** the handle count in `stats()` equals the number of
  distinct folders, not the number of subscribers.
- **Risk:** medium — a refcount bug leaks handles or closes a folder still in use.

### P5 — One board poller per project

- **Files:** `web/server/index.ts` (`events()`).
- **Change:** one poller per project, shared by every SSE client, computing the
  board once; a late client gets the current board at once; the poller stops with
  the last client.
- **Tests** (`web/test/server.test.ts`): three clients make the same git calls
  as one; a late client is served immediately; the poller stops with the last.
- **Acceptance (performance):** idle spawns per tab fall from about 5/s to under
  1/s in total for three tabs.
- **Risk:** medium — the shared snapshot must never be mutated by a client.

### P6 — Push the board on change

- **Files:** `web/server/index.ts`, new `web/server/board-stream.ts` (uses P4's
  registry), `web/server/watch.ts`, `web/ui/src/Board.tsx`, `web/ui/src/App.tsx`.
- **Change:** watch the register folder, the backlog `index.md` and the `logs`
  folder of every active run; debounce 150 ms; push only when the board changed;
  ignore `run.out` (the tail belongs to the run stream). The board has no 30 s
  tick today — its only timer is the 2 s poller (`web/server/index.ts:98,468`) —
  so this step changes the P5 poller to a 30 s tick, which becomes the
  correctness net; P9 tunes it. Client side: one stream per page, closed on
  navigation, with the existing `stream.ts` machine for the banner and reconnect.
- **Tests** (`web/test/server.test.ts`; the client side in `test/stream.test.ts`,
  which already drives the DOM-free `web/ui/src/stream.ts` with a fake clock, no
  new dependency and no DOM): a record write reaches a
  client within a stated time; a `run.out` write triggers nothing; a write made
  with the watchers paused is caught by the 30 s tick; a watcher error falls back
  to polling without losing an update; the board and a run page on the same folder
  share one handle; the machine opens a connection once per page and closes it on
  stop.
- **Acceptance (SRE):** with the watchers forced to fail, the board still
  updates within one tick.
- **Acceptance (performance):** a connected idle board makes about 0 spawns
  between changes, plus the slow tick from P3 and the 30 s tick.
- **Acceptance (frontend):** a stream is opened once per page and closed on
  navigation; a hidden tab opens no connection and polls nothing, and a tab
  shown while its data is fresh makes no extra connection (the existing
  visibility cases in `test/stream.test.ts`).
- **Risk:** medium to high — missed or merged events. P5 must land first so a
  watcher failure always has a working fallback.

### P7 — Cache the project context

- **Files:** `web/server/index.ts` (`contextFor`), a small mtime helper where
  `runContext` reads settings and the registry.
- **Change:** one `RunContext` per project, rebuilt only when the settings file,
  the personal settings or the model registry change; every GET route uses it;
  `start` checks liveness through the same cached answer as the slow tick.
- **Tests** (`web/test/server.test.ts`): with a counting `git`, 10 run requests
  make the 3 context spawns once; a settings change shows on the next request; a
  registry change shows on the next request.
- **Acceptance (performance):** spawns per run request fall from 7 to 4.
- **Risk:** medium — a stale context is the one failure that is worse than slow.

### P8 — Conditional GET for the backup path (only if P6 leaves one)

- **Files:** the run route in `web/server/index.ts`.
- **Change:** fingerprint the run's record, `status.json`, `permissions.json`,
  `questions.md`, `stage-files.json`, `tests.json`, `finalise-options.json`,
  `run.out` and the backlog folder (9 inputs), plus liveness; answer `304` on a
  match.
- **Tests** (`web/test/server.test.ts`): a second request returns 304 and builds
  nothing; touching any file returns 200; a killed run changes the tag.
- **Acceptance (performance):** a backup poll costs a stat of 9 paths. The old
  plan measured 15 paths at ~23 µs (F22); 9 paths is fewer, and this step states
  its own measurement rather than borrowing that figure.
- **Risk:** low. Drop this step if P6 leaves the backup path rare.

### P9 — Measure, then tune or delete

- **No code, no files, no tests by design** — the one exception to the rule
  above. Run the trace report on four states (section 6), with the counting
  shims. Every repeating row must be **needed**, **a guard**, or a **finding**; a
  finding becomes a change or a written reason. Tune the intervals here, never
  before — including whether P8's fingerprint earns its keep.
- **Acceptance (all lenses):** the four tables are in the PR and replace every
  `[estimate]` in this plan and in the two superseded ones.

## 6. How the numbers are taken

- Start the server with a `PATH` holding logging shims for `git`, `ps` and `gh`
  (the shim is the independent check on the trace).
  `ai-sdlc-helper ui --port <n> --no-open`, then the printed URL.
- Four states, two minutes each: a cold board, an idle board, an idle open run
  page, a running run page.
- Report: `node scripts/trace-report.mjs [trace-file] [--json]`; record events a
  minute, the `changed:false` share, the median and total ms, and the shim's
  spawn count per program.
- Targets, to confirm or revise in P9: idle board under 1 spawn/min; an idle run
  page 0 spawns/min, 4 pings/min and 2 ticks/min; no `changed:false` board
  rebuild.

## 7. Risks and constraints

- **Node 18.** No recursive `fs.watch` on Linux; never use it. Watch folders one
  by one; the safety tick covers what a watcher misses. Windows stays untested
  (the repo's existing gap).
- **HTTP/1.1 connection limit.** A browser opens at most ~6 connections per
  host; a board stream plus a run stream in one tab is 2. Keep one stream per
  page and close it on navigation (P6 checks the client side).
- **Watcher storms.** A busy `run.out` is excluded from the board watcher and
  throttled to 1 s in the run stream; debounce is per subscriber, not global.
- **Errors must not take the server down.** Every watcher path has a fallback:
  poller (P5), tick (P6), and the run stream's own 30 s tick.
- **No new dependencies.** Everything here is Node's own `fs`, `http` and timers.

## 8. Not in this plan

- The detector's own process isolation, the test runner's `spawnSync`
  (`docs/plans/process-isolation-research.md`) — it affects pipeline runs, not
  the web pane.
- Detached triage/palette jobs (`docs/plans/detached-jobs.md`). Its heartbeat
  will add a timer to the supervisor; it must write its own trace line.
- The parked slow-suite investigation (`docs/investigations/test-suite-speed.md`).
- A database for history, Docker/cgroups, the parked 13-minute suite.

## 9. Acceptance criteria by lens

**Performance engineer**
1. Each PR carries before/after tables from the trace report, with the shim's
   spawn counts as the independent check.
2. No repeat is left unjustified: an idle board makes under 1 spawn/minute, and
   an idle open run page makes no spawns.
3. No `changed:false` board rebuild appears in the trace after P6.

**SRE / observability**
4. One `fs.watch` handle per distinct folder (`watchers.stats()`), and every
   handle closes with its last subscriber.
5. With the watchers forced to fail, the board and the run page still update
   within one tick, and the retrying banner appears on the client.
6. A reused pid is never reported as a live run (P2's test), and a concurrent
   record write is never lost or unparseable.

**Frontend engineer**
7. One stream per page, closed on navigation; a hidden tab opens no connection
   and polls nothing, and a tab shown while fresh makes no extra connection
   (`test/stream.test.ts`).
8. A "may be stale" mark appears wherever a cached count is shown, and clears on
   the next fresh tick.
9. The backup path is exercised by a test, not only by the happy path.

**Pragmatic maintainer**
10. Each step is one PR that stands alone and can be reverted without the others
    (P6 excepted, which needs P5).
11. No step changes stage names, run record fields that `status` reads, or the
    shape of `runView`'s full answer.
12. `npm run check` is green; long commands are logged, and only failing parts
    are read.

## Appendix: mapping from the two superseded plans

| Old step | Here |
|---|---|
| dashboard Step 0 (baseline) | folded into every PR's measurements, P9 |
| (not in either plan) route the board's spawns through the trace | P0 |
| dashboard Step 1 (counts do not flicker) | built — see section 2 |
| dashboard Step 2 (slim the board) | P1 |
| dashboard Step 3 (shared poller, context cache) | P5 and P7 |
| dashboard Step 4 (register safety) | P2 |
| dashboard Step 5 (slow-tick counts) | P3 |
| dashboard Step 6 (push on change) | P4 and P6 |
| dashboard Step 7 (orphan reproduction) | out of scope here; belongs with the detached-jobs plan |
| run-view Step 0b (trace) | built |
| run-view Step 1 (client delays) | built into `web/ui/src/stream.ts`; the fallback delays are P9's to tune |
| run-view Step 2 (context cache) | P7 |
| run-view Step 3 (parts, cached git) | built |
| run-view Step 3b (async `gh`) | built (cached `getPrStatusCached`) |
| run-view Step 4 (server stream) | built |
| run-view Step 5 (client stream) | built |
| run-view Step 6 (conditional GET) | P8 |
| run-view Step 7 (measure again) | P9 |
