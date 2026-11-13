# Web performance: the board, the run page and the run register

Status (2026-11-14): **P0, P1, P2, P3, P5, P7 and P9 are merged or done; P4 and P6 are done as the board watcher; P8 is dropped.
The Completed list is fast (#137); rows first, the start-up PR cache fill and the worktree keying fix are in #138.**
Section 12 has what was built, what was measured, and the decision still open. One PR per step, **direct**
(no backlog briefs).
Revised 2026-11-12 after a review against the code: P1 and P2 are redesigned,
P3's cache key and every spawn target are corrected, and the step order is
stated (section 5).
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
| Always-on trace, rotating | `src/trace.ts`, `trace` block in `src/config/settings.ts` | every **traced** spawn (`src/runs/*`, `completed`, `finalise`), timer, request and SSE push, with microseconds. The board's own helpers are not routed through it yet — `Git.run` (`src/pipeline/git.ts`), `for-each-ref` (`src/backlog/index.ts`), `gitTop` (`web/server/index.ts`) — so P0 fixes that before P1 and P3 rely on the numbers |
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
   pid is reported alive, and two writers can leave half a record or fail a
   rename. The same pid check runs on the pid in `status.json`
   (`src/runs/view.ts:213`), and `runView` makes it twice per read.
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
description.

**Order.** The steps are not all independent; this is the real graph:

| Step | Needs | Why |
|---|---|---|
| P0 | — | |
| P1 | P0 | its acceptance counts spawns the trace cannot see before P0 |
| P2 | — | |
| P3 | P0 | same reason as P1 |
| P4 | — | |
| P5 | — | |
| P6 | P4, P5 | uses the registry; the shared poller is its fallback |
| P7 | — | |
| P8 | P6 | only if P6 leaves a backup path |
| P9 | all | |

Suggested sequence: P0, then P1 and P2 (either order), P3, P5, P4, P6, P7, P9;
P8 only if P9 says so.

### P0 — Route the board's spawn sites through the trace — **done (#117)**

- **Files:** `src/pipeline/git.ts` (`Git.run`), `src/backlog/index.ts`
  (`for-each-ref`), `web/server/index.ts` (`gitTop`), `src/runs/view.ts`
  (`mergeFixKept`, which spawns during a board read for a run in Resolve
  conflicts), `src/trace.ts`.
- **Change:** `src/trace.ts` already exports traced `spawnSync` and
  `execFileSync`. `Git.run`, the backlog call and `mergeFixKept` only change
  their import. `gitTop` uses the asynchronous `spawn`, which has no traced
  form: add one (a trace line on `close`, same fields). `runCommand` is left
  alone — it runs the CLI on a user action and is not a repeating spawn.
  `Git.run` is used by every pipeline stage, not only the board; that is safe
  because `trace()` does nothing in a process that never called `startTrace`,
  and the test below proves it.
- **Tests** (`test/trace.test.ts`): each helper writes one `spawn:<program>` line
  with the first argument only and an exit code; a counting shim sees the same
  number of calls the trace reports; `Git.run` with no tracer started writes no
  file and returns the same output.
- **Acceptance (performance):** after P0, the trace report accounts for every
  spawn the shims see during a board read.
- **Risk:** low. Without this step P1's and P3's acceptance cannot be measured.

### P1 — Slim the board card — **done (#118)**

- **Files:** `src/runs/view.ts` (`runView`, `viewState`'s two calls, `boardView`).
- **Change:** three things, all in `runView`'s existing shape:
  1. `boardView` passes `cacheGit: true`. The per-run git cache the run page
     already uses (`gitFactsOf`, keyed on state, stage, attempt and finish time,
     30 s limit while running) then serves the card's counts and the red-tests
     sha, so a repeat board read runs no `git log` and no count for a run that
     did not move. No new option is needed. The every-5th-read rule in
     `events()` stays until P3 replaces it.
  2. `runView` calls `viewState` twice (`src/runs/view.ts:334` and `:352`), and
     each call runs `ps` for a running run. Compute it once.
  3. `boardView` passes `parts: ['live', 'git']`, so the card skips the parts it
     never shows (documents list, recovery hint).
- **What this does not save:** `runView` reads `questions.md`,
  `permissions.json` and `stage-files.json` before it looks at `parts`
  (`src/runs/view.ts:325-327`), and the card needs the question and permission
  counts anyway. Those reads stay; they are file reads, not spawns.
- **Tests** (`test/view.test.ts`): a card's fields equal today's for a fixture
  run, `changes` included; with a counting `git` and `ps` on `PATH`, a second
  board read of an unchanged fixture makes no `git log` and no count call, and
  one `ps` per running run; a stage change makes the counts fresh on the next
  read; `parts: ['live']` still makes no git call at all.
- **Acceptance (performance):** on a fixture board with 10 unchanged runs, the
  second read makes no per-run git call; `ps` calls per running run fall from 2
  to 1.
- **Risk:** low to medium — a card can show counts up to 30 s old for a running
  run. That is the same rule the run page already follows, and decision 4
  accepts it.

### P2 — Make the register honest — **done (#119)**

- **Files:** new `src/runs/proc.ts`, `src/runs/records.ts` (`writeRecord`,
  `isRunning`, `RunRecord`), `src/runs/supervisor.ts` (its own writer, line 57),
  `src/runs/index.ts`, `src/pipeline/status.ts` (it writes the `pid` in
  `status.json`), `src/runs/view.ts` (`viewState` checks that pid, line 213).
- **Change — writes:** a unique temp name per write (`<file>.<pid>.<n>.tmp`) in
  both writers. This guarantees a reader never sees half a record and a rename
  never fails because another writer took the temp file. It does **not** stop
  one writer overwriting another's fields: the CLI (`src/runs/index.ts:311`,
  `:335`, `:398`) and the supervisor both read, change and rewrite the record.
  That is recorded as a known limit; a lock is added only if the two-writer test
  below shows a lost field in practice.
- **Change — liveness:** this is the same work as step A2 of
  `docs/plans/detached-jobs.md` (process identity), so build that step's module
  and names here and do it once: new `src/runs/proc.ts` with `ProcIdentity`
  (`pid`, `start`, optional `bootId`), `procStart`, `identity` and
  `sameProcess`, and the optional record field `supervisor?: ProcIdentity` from
  that plan's record schema. The pipeline stores its own identity next to `pid`
  in `status.json`. One difference from A2 as written: `alive()` already runs
  `ps -o stat= -p <pid>`, so `sameProcess` asks that one call for the start time
  too (`ps -o stat=,lstart=`, with `LC_ALL=C`) instead of spawning a second
  `ps`. `isRunning` and `viewState` use `sameProcess` when the identity is
  present. A record or status without it, a caller that has only a pid
  (`web/server/triage.ts`, `web/server/index.ts:393`), and Windows (no `ps`)
  all keep today's behaviour. The record's existing `started` is the time the
  run was asked for, not the process start, and is not used. A2's group
  helpers (`ownPgid`, `groupMembers`) are not needed here and stay with that
  plan.
- **Can ride along (optional):** `docs/pipeline-edge-cases.md` entry 8 asks the
  record to say who started a run. This PR already adds an optional field and
  touches every writer, so adding `trigger?: 'ui' | 'cli'` here costs one line
  per start path. Leave it out if it makes the PR harder to review.
- **No slow tick here.** Because the start time rides on the `ps` that already
  runs, this step adds no timer. P3 adds the slow tick.
- **Tests** (`test/records.test.ts`, new): two real writers, no unparseable read
  and no failed rename; a reused pid with a different start time is not alive,
  through the record and through `status.json`; an old record without the field
  still works; a record written by the supervisor is read by `status`.
- **Acceptance (SRE):** none of the above passes only by loosening an assertion;
  the counting `ps` shim sees the same number of calls per board read as before
  this step.
- **Risk:** medium — it changes when `ai-sdlc-helper status` says "running", and
  it adds one optional field to the record and to `status.json`. A wrong
  `sameProcess` reports a live run as stopped, so the tests run on macOS and
  Linux in CI.

### P3 — Counts on a slow tick, cached by mtime — **done (#123), built differently: see section 12**

- **Files:** `web/server/index.ts`, `src/backlog/index.ts`
  (`for-each-ref`), `src/runs/records.ts` (`mainTree`, `worktree list`),
  `web/ui/src/Board.tsx` (the stale mark).
- **Change:** this step adds a slow tick of 10 s per project and moves the
  counts onto it (or on demand), replacing the every-5th-read rule.
  `for-each-ref` is asked only for names, so its answer changes only when a ref
  is added, removed or packed. Cache it on the mtimes of `packed-refs`,
  `refs/heads`, `refs/heads/<branch prefix folder>`, `refs/remotes/origin` and
  `refs/remotes/origin/<branch prefix folder>` under the git common dir (the
  mtime of `refs` alone misses a new `sdlc/<slug>` branch, a pack and a fetch).
  Cache `worktree list` on the mtime of the common dir's `worktrees` folder.
  Whatever the mtimes say, the cache is refreshed after 60 s, so a change the
  key misses is late, never lost. The board card shows counts older than one
  slow tick as possibly stale.
- **Tests** (`web/test/server.test.ts`, `test/backlog.test.ts`, and an extension
  of `test/stale.test.ts`, which already covers the DOM-free
  `web/ui/src/stale.ts` helper): with a counting `git`, an idle project makes no
  calls between 60 s refreshes; a new top-level branch, a new branch under the
  prefix folder, and a branch that exists only in `packed-refs` each show within
  one slow tick; `staleLabel` reports a count older than one tick as stale and a
  fresh value as fresh.
- **Acceptance (performance):** an idle board with no running run makes at most
  2 spawns a minute (one `for-each-ref` and one `worktree list` at the 60 s
  refresh); the 10 s ticks in between cost file stats only.
- **Risk:** medium — a stale mark that is not shown turns "behind" into "wrong".

### P4 — One watcher registry — **done as part of the board watcher: see section 13**

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

### P5 — One board poller per project — **done (#121)**

- **Files:** `web/server/index.ts` (`events()`).
- **Change:** one poller per project, shared by every SSE client, computing the
  board once; a late client gets the current board at once; the poller stops with
  the last client. Today each client rewrites `r.changes` on its own board
  object; that merge of kept counts moves into the shared poller, and clients
  receive the finished text and never touch the object.
- **Tests** (`web/test/server.test.ts`): three clients make the same git and
  `ps` calls as one; a late client is served immediately; the poller stops with
  the last.
- **Acceptance (performance):** three tabs cost the same spawns and the same
  number of `timer:board-rebuild` lines as one tab.
- **Risk:** medium — the shared snapshot must never be mutated by a client.

### P6 — Push the board on change — **done: server side is the board watcher (section 13); the client needed nothing (section 14)**

- **Needs:** P4 (the registry) and P5 (the shared poller, its fallback).
- **Files:** `web/server/index.ts`, new `web/server/board-stream.ts` (uses P4's
  registry), `web/server/watch.ts`, `web/ui/src/Board.tsx`, `web/ui/src/App.tsx`.
- **Decide first:** what the left menu's counts use on pages other than the
  board (section 10, point 4); and whether a hidden tab keeps its board stream
  (section 11, point 5).
- **Change:** watch the register folder, the backlog `index.md` and the `logs`
  folder of every active run; debounce 150 ms; push only when the board changed;
  ignore `run.out` (the tail belongs to the run stream), `*.live.json` (the
  supervisor heartbeat that `docs/plans/detached-jobs.md` step B2 will write to
  the register folder every 10 s; `web/server/watch.ts` already ignores it) and
  `*.tmp` (P2's temp files). The board has no 30 s
  tick today — its only timer is the 2 s poller (`web/server/index.ts:98,468`) —
  so this step changes the P5 poller to a 30 s tick, which becomes the
  correctness net; P9 tunes it. After this step the board has two timers: the
  30 s rebuild tick (2 a minute) and P3's 10 s slow tick (6 a minute, file stats
  only). Client side: one stream per page, closed on navigation, with the
  existing `stream.ts` machine for the banner and reconnect.
- **Tests** (`web/test/server.test.ts`; the client side in `test/stream.test.ts`,
  which already drives the DOM-free `web/ui/src/stream.ts` with a fake clock, no
  new dependency and no DOM): a record write reaches a
  client within a stated time; a `run.out` write, a `<slug>.live.json` write and a `.tmp` write each trigger
  nothing; a write made
  with the watchers paused is caught by the 30 s tick; a watcher error falls back
  to polling without losing an update; the board and a run page on the same folder
  share one handle; the machine opens a connection once per page and closes it on
  stop.
- **Acceptance (SRE):** with the watchers forced to fail, the board still
  updates within one tick.
- **Acceptance (performance):** a connected idle board with no running run makes
  no spawns between changes beyond P3's 2 a minute; with a running run, one `ps`
  per run per 30 s tick.
- **Acceptance (frontend):** a stream is opened once per page and closed on
  navigation; a hidden tab opens no connection and polls nothing, and a tab
  shown while its data is fresh makes no extra connection (the existing
  visibility cases in `test/stream.test.ts`).
- **Risk:** medium to high — missed or merged events.

### P7 — Cache the project context — **done (#120)**

- **Files:** `web/server/index.ts` (`contextFor`), a small mtime helper where
  `runContext` reads settings and the registry.
- **Change:** one `RunContext` per project, rebuilt only when the settings file,
  the personal settings or the model registry change; every GET route uses it;
  `start` checks liveness through the same cached answer as the slow tick. A
  request that changes a project (Register, a palette command, a settings save)
  drops that project's cached context at once, without waiting for an mtime.
- **Tests** (`web/test/server.test.ts`): with a counting `git`, 10 run requests
  make the context spawns once — today `runContext` runs three per call:
  `rev-parse --show-toplevel` in `projectRoot`, and `rev-parse --git-common-dir`
  twice (`registryDir` is called from `projectRoot` and again from
  `runContext`); a settings change shows on the next request; a registry change
  shows on the next request.
- **Acceptance (performance):** a repeat run request makes none of those three
  spawns. The old plan's "7 to 4 per request" is an estimate; this PR states the
  measured before and after.
- **Risk:** medium — a stale context is the one failure that is worse than slow.

### P8 — Conditional GET for the backup path (only if P6 leaves one) — **dropped (section 14)**

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

### P9 — Measure, then tune or delete — **done (section 14)**

- **No code, no files, no tests by design** — the one exception to the rule
  above. Run the trace report on four states (section 6), with the counting
  shims. Every repeating row must be **needed**, **a guard**, or a **finding**; a
  finding becomes a change or a written reason. Tune the intervals here, never
  before — including whether P8's fingerprint earns its keep.
- **Acceptance (all lenses):** the four tables are in the PR and replace every
  target in this plan (section 6) and every `[estimate]` in the two superseded
  ones.

## 6. How the numbers are taken

- Start the server with a `PATH` holding logging shims for `git`, `ps` and `gh`
  (the shim is the independent check on the trace).
  `ai-sdlc-helper ui --port <n> --no-open`, then the printed URL.
- Four states, two minutes each: a cold board, an idle board, an idle open run
  page, a running run page.
- Report: `node scripts/trace-report.mjs [trace-file] [--json]`; record events a
  minute, the `changed:false` share, the median and total ms, and the shim's
  spawn count per program.
- Targets, to confirm or revise in P9. These are the only targets; the steps'
  own acceptance lines use the same numbers.
  - Idle board, no running run: at most 2 spawns/min (P3's 60 s refresh),
    2 rebuild ticks/min, 6 slow ticks/min that only stat files, 4 pings/min.
  - Board with running runs: add one `ps` per running run per rebuild tick.
  - Idle open run page: 0 spawns/min, 4 pings/min, 2 ticks/min.
  - No `changed:false` board rebuild outside the 30 s tick.
  - The longest single board rebuild, in ms (`timer:board-rebuild`). Git and
    `ps` calls are synchronous on the server's one event loop, so this is how
    long every other tab and stream waits. Record it per state; P9 sets the
    limit.

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
- **The new tests must not slow the suite.** `web/test/server.test.ts` is
  already the third slowest file (22 tests, 223 s of test time,
  `docs/investigations/test-suite-speed.md`), and P3, P5, P6, P7 and P8 all add
  server tests. So: the poller, the watcher registry and the board stream get
  their own test files, which run in other workers; every tick, debounce and
  refresh interval is injected (as `pollMs` and `opts.stream` are today) and set
  to milliseconds in tests; no test waits for a real 10 s, 30 s or 60 s; tests
  that need a server and a repository share one per file.

## 8. Not in this plan

- The detector's own process isolation, the test runner's `spawnSync`
  (`docs/plans/process-isolation-research.md`) — it affects pipeline runs, not
  the web pane.
- Detached triage/palette jobs (`docs/plans/detached-jobs.md`). Its heartbeat
  will add a timer to the supervisor; it must write its own trace line.
- The parked slow-suite investigation (`docs/investigations/test-suite-speed.md`).
- A database for history, Docker/cgroups, the parked 13-minute suite.
- The other writers that share a `.tmp` name (`src/pipeline/status.ts:95`,
  `src/models/index.ts:112`, `web/server/triage.ts:74` and `:114`). Each has one
  writer today; P2 fixes only the run record, which has two.
- A lock on the run record (see P2's known limit).

## 9. Acceptance criteria by lens

**Performance engineer**
1. Each PR carries before/after tables from the trace report, with the shim's
   spawn counts as the independent check.
2. No repeat is left unjustified: an idle board with no running run makes at
   most 2 spawns a minute, and an idle open run page makes no spawns.
3. No `changed:false` board rebuild appears in the trace after P6, except the
   30 s tick.

**SRE / observability**
4. One `fs.watch` handle per distinct folder (`watchers.stats()`), and every
   handle closes with its last subscriber.
5. With the watchers forced to fail, the board and the run page still update
   within one tick, and the retrying banner appears on the client.
6. A reused pid is never reported as a live run, through the record or through
   `status.json` (P2's test), and a concurrent record write never leaves an
   unparseable file or a failed rename. Two writers changing different fields at
   the same moment is P2's stated limit, not covered here.

**Frontend engineer**
7. One stream per page, closed on navigation; a hidden tab opens no connection
   and polls nothing, and a tab shown while fresh makes no extra connection
   (`test/stream.test.ts`).
8. A "may be stale" mark appears wherever a cached count is shown, and clears on
   the next fresh tick.
9. The backup path is exercised by a test, not only by the happy path.

**Pragmatic maintainer**
10. Each step is one PR, landed in the order of the table in section 5, and can
    be reverted without the steps it does not feed.
11. No step changes stage names, the meaning of an existing run record field, or
    the shape of `runView`'s full answer. P2 adds one optional field
    (`supervisor`, the process identity from `docs/plans/detached-jobs.md`) to
    the record and its counterpart to `status.json`; nothing else is added
    unless the optional `trigger` field is taken.
12. `npm run check` is green; long commands are logged, and only failing parts
    are read.

## 10. The UI redesign (`docs/redesign`, merged in #116)

The redesign is a design only; no code has changed and it has no implementation
plan yet. It does not change what this plan fixes, but it changes four things
this plan must not paint itself into.

1. **Server steps are unaffected and go first.** P0, P1, P2, P4, P5 and P7 touch
   no file the redesign rewrites. Land them regardless of when the redesign is
   built.
2. **Two steps touch pages the redesign replaces.** P3 adds the stale mark to
   `web/ui/src/Board.tsx`; P6 changes `Board.tsx` and `App.tsx`. Keep their
   logic in the DOM-free helpers (`web/ui/src/stale.ts`, `stream.ts`,
   `useStream.ts`), which the redesign keeps, and keep the edits to the page
   files as small as they can be. If the redesigned board lands first, P3 and P6
   attach to the new row instead of the card.
3. **The board row will need more per run.** The redesigned board shows a stage
   progress strip per item, and reviewer stages add one status per parallel
   reviewer. Those must come from files the card already reads (`status.json`)
   or from new files under the run's `logs` folder, which P6 already watches —
   never from a new git call per row. P1's test (a second read of an unchanged
   board makes no per-run git call) is the guard, and whoever adds the strip
   extends that test.
4. **The left menu shows counts on every page.** That means a run page also
   wants board data, which conflicts with "one stream per page" (section 7,
   criterion 7). Decide this before P6: either one stream per tab that carries
   both the board and the open run (preferred — it stays at one connection), or
   menu counts that are fetched once and refreshed on navigation. Two streams
   per page is the option to avoid.

New pages the redesign adds, and what they must reuse rather than rebuild:

| Page | Reuses |
|---|---|
| Projects (counts per repository) | P5's one poller per project, started only while a client shows that project's counts; never a board build for every project on every tick |
| Completed (merged items, PR, merge date) | `getPrStatusCached`; no `gh` on the request path |
| Model picker (long lists per harness) | the model list is asked for once per harness and cached with P7's context cache |

None of this is a step in this plan. It belongs in the redesign's own
implementation plan, which should cite this section.

## 11. What the other docs add

Every file under `docs/` was read for work that overlaps this plan (the
top-level docs, `investigations/`, `incidents/`, `plans/`). What overlaps is
folded into the steps above; this is the list, so nothing is done twice.

**Folded into a step**

| # | Source | What it asks | Where it went |
|---|---|---|---|
| 1 | `plans/detached-jobs.md` A2 (process identity) and the record schema | pid plus start time, so a reused pid is not "alive" | P2 builds that module and field; A2 is then done apart from its group helpers |
| 2 | `plans/detached-jobs.md` B2 (heartbeat file in the register folder every 10 s) | — | P6 ignores `*.live.json`, or every running run would rebuild the board every 10 s |
| 3 | `pipeline-edge-cases.md` entry 8 (who started a run) | a `trigger` field in the record | optional rider on P2 |
| 4 | `findings.md` finding 1 (doctor checks stale after Register) | refresh after an action changes the project | P7 drops the cached context on any changing request; re-running doctor on the card is a small UI follow-up, not in this plan |
| 5 | `plans/process-isolation-research.md`, last section (sync git and `ps` block every tab) | — | section 6 now records the longest board rebuild |
| 6 | `investigations/test-suite-speed.md` | the server tests are among the slowest | section 7's rule for the new tests |

**Decisions these docs force**

5. **Notices while the tab is hidden.** `docs/web-ui.md` promises notices on
   state changes and a count in the tab title, and `web/ui/src/App.tsx` drives
   both from board events. The existing stream machine opens no connection in a
   hidden tab (criterion 7). If P6 puts the board on that machine unchanged, the
   tab title stops counting exactly when the user has looked away. Decide before
   P6: keep the board stream open while hidden (one idle connection per tab;
   the title stays right), or accept a title that is only correct when the tab
   is shown. The run page's stream can stay as it is either way.

**Constraints on later work, not steps here**

- `plans/detached-jobs.md` E2 plans a file tailer that polls every 500 ms **per
  client**. That is the per-client timer P5 removes from the board. When it is
  built it should share one tailer per file and count against the one stream
  per page rule (section 7).
- `plans/detached-jobs.md` C5 adds `orphaned` and `hung` to the card's state.
  Its classifier must run from files (the heartbeat) on the board path, not
  from a new `ps` per card; P1's spawn test is the guard.
- Once the heartbeat exists (B2), a running run's liveness can be read from the
  heartbeat file's age, and the remaining `ps` per running run per tick can go.
  That is a follow-up for after both plans, to be decided in P9.
- `docs/web-ui.md` still describes live updates as `fs.watch` with a 3-second
  poll and one `/api/events` route. The P6 PR updates that paragraph and the
  API table.

**Read and found unrelated to this plan**

`agent-lifecycle-adapters.md`, `web-ui-implementation-plan.md` (its E-9 tokens
and durations, and the history file, stay out as section 8 says),
`investigations/vitest-ontaskupdate-timeout.md`,
`incidents/2026-11-08-codex-usage-limit-false-positive.md`,
`plans/codex-cli-graft-integration.md`, `plans/mvp-node-ts-recovery-matrix.md`,
`plans/opencode-harness-support.md`, `plans/tool-notes.md`, and the test-gate
parts of `plans/process-isolation-research.md` (test slots, result cache,
repeated suite runs), which speed up pipeline runs, not the web pane.

## 12. Status after the first round (2026-11-13)

### What is done, and what is pending

| Step | State | PR | Note |
|---|---|---|---|
| P0 trace the board's spawns | **done** | #117 | `gitTop` left out: it runs once, before the trace starts |
| P1 slim the board card | **done** | #118 | the card uses the run page's git cache; a run that is not running is read again after 60 s |
| P2 honest register | **done** | #119 | `src/runs/proc.ts`; no boot id, no `trigger` field (both still open) |
| P7 context cache | **done** | #120 | done before P3 because the numbers showed it was the larger cost |
| P3 kept branch names and main tree | **done** | #123 | no 10 s slow tick and no live stale age: see below |
| P5 one board feed per project | **done** | #121 | merged 2026-11-13 on its three-window numbers |
| P4 watcher registry | **replaced** | | by the board watcher, section 13: one watcher set per project feed, so no registry is needed |
| P6 push the board on change | **done** | #126, #127 | server side is the board watcher (section 13); the client needed nothing (section 14) |
| P8 conditional GET | **dropped** | | no silent reconnect happened in any measured state (section 14) |
| P9 measure all four states | **done** | | section 14; it found the finished-run re-reads, fixed in the same PR |

#122 is marked merged on GitHub but was merged into the P7 branch, not `main`; #123 is the same change on `main`.

### Built differently from sections 5 and 6

- **P3 has no 10 s slow tick.** After P1 the file counts come from the per-run git cache (60 s limit, 30 s for a
  running run), so nothing was left for a slow tick to refresh. The branch names are kept until `packed-refs` or a
  ref folder changes, 60 s at most; the main working tree for a minute.
- **The stale mark is a tooltip, not a live age.** An age in the board data changes every tick and would defeat
  "push only on change". The card's file count says how old it can be.
- **The every-fifth-read rule for counts** is gone: P5 removed it, since the counts come from the per-run git cache.
- **A new `traceFlushMs` server option** lets tests read the trace soon after an event.

### Measured

The real board of this repository (6 finished runs, none running) open in Chrome, idle, with logging stand-ins for
`git`, `ps` and `gh` on the server's `PATH`. `ps` and `gh` were 0 in every window.

One window, 120 s:

| Build | `git` calls | per second |
|---|---|---|
| Before (P0 only) | 931 | 7.8 |
| + P1 | 431 | 3.6 |
| + P2, P7 | 160 | 1.3 |
| + P3 | 52 | 0.4 |

Three windows side by side (all visible), 60 s:

| Build | `git` calls | board builds |
|---|---|---|
| P7 (before P5) | 197 | 111 |
| + P5 | 84 | 39 |
| + P5 and P3 | 26 | 39 |

What the 52 calls left are: each run that is not running has its counts read again every 60 s (4 calls a run). That
is 26 a minute for 6 runs, against section 6's target of 2 a minute. To reach the target, lengthen
`BOARD_GIT_MAX_AGE_MS` for runs that are done, or read them again only when their worktree changes (P6's watcher).

Not measured yet: a cold board, an idle run page, a running run page, and anything with a run in progress.

### Is P6 still worth it

On `main` today a board build of an unchanged board runs no git command at all. P6 would cut the builds from 30 a
minute to 2 and make a change show at once instead of within 2 s, but it would no longer save any spawns. It is the
riskiest step (medium to high) and needs P4 first. Recommendation: do P9 first (measure the build's milliseconds and
the three states not measured), then decide whether P4 and P6 are still worth building.

### Decisions taken (2026-11-12)

- **Menu counts on every page:** one stream per tab that carries the board and the open run, built in P6; one
  connection per browser as a later step.
- **Hidden tabs:** close the stream while hidden.

### Decided: one connection per browser is a future enhancement; close when hidden stays

Found while measuring: **the board already closes its stream in a hidden tab.** `web/ui/src/App.tsx` opens the board
through `useStream`, whose machine holds no connection while the tab is hidden and reconnects when it is shown; the
server sends the whole board on connect. So "close when hidden" is how `main` behaves today, and costs nothing to
build. The two options overlap, and the user asked for them to be compared before the follow-up step is written.

| | Close when hidden (today) | One connection per browser |
|---|---|---|
| New code | none | a leader tab chosen with the Web Locks API, updates passed to the other tabs over `BroadcastChannel`, a take-over when the leader closes; roughly 150 to 250 lines plus tests |
| Connections used | one per visible tab | one per browser, whatever the number of tabs |
| Cost of hiding and showing a tab | one reconnect and one board sent on return; with P5 that board is the kept text, without it one board build | none: the tab keeps listening to the channel |
| Tab title count while hidden | stale until the tab is shown | correct, but only because the leader keeps its connection while hidden |
| Notices missed while hidden | one notice per run for the state it ended in, not each step | every one, as it happens |
| When the 6-connection limit bites | 5 or more board windows visible at once | never |
| What can go wrong | nothing new | two leaders for a moment, a leader that dies without releasing, a browser without Web Locks falling back to today's behaviour |
| Effect on P5 | P5 helps whenever two windows are visible | P5 only helps across browsers or profiles |

Points to weigh:

- The limit is hard to reach once hidden tabs hold nothing, so the only thing one connection per browser still buys
  is a correct title and live notices in hidden tabs.
- That benefit needs the leader to stay connected while hidden, which is the opposite of the hidden-tab choice above.
  The two decisions cannot both stand as taken.
- A cheaper way to keep the title right is a board fetch once a minute in hidden tabs (no held connection, no leader).

P5 (#121) was merged on 2026-11-13.

**Decision (2026-11-14):** one connection per browser is kept as a future enhancement and is not built now.
Close-when-hidden stays the current behaviour. Revisit only if a stale title or missed notices in hidden tabs turn
out to matter in use.

## 13. The board watcher (replaces P4 and the server side of P6)

Built from the user's design of 2026-11-13: the watcher first, the fingerprint only as its auditor and its stand-in.
The code and its header comment are in `web/server/board-watch.ts`; this is the summary.

- **Watching.** `fs.watch` on the folders the board reads (`boardInputs` in `src/runs/view.ts`). An event rebuilds
  the board after 150 ms. No fingerprint is compared while events keep coming. Changes that cannot alter the board
  (a run's `run.out`, agents' logs, temporary and heartbeat files) are ignored.
- **Audit.** After 30 s without an event the fingerprint (modification time and size of every file the board reads)
  is compared once with the one taken at the last rebuild. Equal: nothing was missed, and the host uses that quiet
  moment, not a timer of its own, to check that a run said to be going still is. Different: the watcher missed a
  change.
- **Waiting.** A folder that does not exist yet (the register before a project's first run, a new run's logs) is
  waited for by name on the nearest folder above it that exists; when it appears the watchers are attached again.
  Found in the browser check: without this a project's first run showed only at the audit, 25 s later, and was
  counted as a failure. With it: 212 ms.
- **Failure.** A missed change, a watcher error, or a watcher that cannot be attached. The board is rebuilt and
  every watcher attached again. Silence alone is never a failure.
- **Cannot attach.** A watcher that cannot be attached is tried again every 5 s, comparing the fingerprint each time; each failed try is one failure, so the fallback is reached after about 50 s, not at once.
- **Fallback.** After 10 failures in a row: no watcher, the fingerprint compared every 5 s, until the process
  restarts. Every start begins with the watcher.
- **Not from a file.** A pull request's status arrives from GitHub in the background; the board is rebuilt when it
  does (`onPrStatusChange`). That is a notification, not a timer. The status is asked for again once an hour
  (`SDLC_PR_POLL_MS`), and only a board build asks; a board that nothing changes is never built, so the same quiet
  moment builds it when a finished run has a pull request and the last build is older than that hour.
- **Done since (pull request status in a file).** The status is written to `pr-status.cache` beside the run records when GitHub answers. The watcher reports it like any other change, so the board no longer listens for it separately, and a restarted server reads it back instead of asking GitHub again for every pull request. The hourly ask still starts from the quiet moment.

The 2 s board rebuild is gone, and so is the `pollMs` server option's effect.

### Measured (`scripts/watch-probe.mjs`, macOS, APFS, two volumes, 400 changes)

| | Result |
|---|---|
| Changes the watcher did not report | 0 of 400 |
| Delay of the first event | 12 ms median, 20 ms worst |
| 50 changes at once | 50 events |
| A watched folder removed and made again | no error is raised; on macOS the old watcher still sees the new folder |
| One audit of this repository's board (169 files, 29 folders) | 1.1 ms median, 2.1 ms worst |
| `git` calls in 60 s, one idle board open (6 finished runs, headless Chrome) | 26 on `main`; 0 with the watcher in a 60 s window (the kept main-tree answer lasts a minute, so about one `git worktree list` a minute is expected over longer periods) |
| A project's first run appears on an open board, no reload | 212 ms |
| How long real runs go without changing a file the board reads | 4 to 16 s at the median, 2 to 33 minutes at the 90th percentile |

Why 30 s and not the 2 minutes first proposed: silence says nothing about the watcher's health (runs are quiet for
minutes), so the period is only the bound on how long a deaf watcher, or a run that died silently, can go unseen. An
audit costs about 1 ms, so a shorter bound is nearly free. 30 s is also the run page's own safety tick. Confirmed by
the user on 2026-11-13 as a setting to tune after monitoring: `SDLC_BOARD_SILENCE_MS` (ms, at least 1000) or the
`silenceMs` constant.

Not reachable from here: Linux is only exercised in CI (where a removed folder kills its watcher silently, which the
audit is there to catch), and Windows is untested.

### Notes kept from the work

- `docs/investigations/web-performance-review-pr-126.md`: the independent review of the board watcher, per
  criterion, with the defects found and what was done about each.
- `docs/investigations/web-performance-side-agent-points.md`: the points raised by side agents during the work.

### Future enhancements

- Tune `silenceMs` (30 s today; 2 minutes was the first proposal) once the trace shows how often an audit finds a missed change.
- Cache the cards of finished runs, keyed on their files' fingerprint. The git part is done (section 14); what is left is skipping the card's file reads (about 17 a run, 8 ms for the whole board).
- A line in the trace report summarising audits, misses and time spent in fallback.
- Back-off between failures, if real faults turn out to come in bursts.
- Linux and Windows measurements with `scripts/watch-probe.mjs`.

## 14. Final measurements (P9), 2026-11-13

A scratch repository with six finished runs and one simulated running run (a real process, its status rewritten every
10 s and its output appended every 2 s), one headless Chrome tab, logging stand-ins for `git`, `ps` and `gh`, 120 s
per state, on `main` after #127.

| State | git | ps | gh | Board rebuilds | Longest rebuild | Audits (missed) |
|---|---|---|---|---|---|---|
| Cold board (first 16 s) | 43 | 0 | 6 | 2 | 286 ms | 0 |
| Idle board | 2 | 0 | 0 | 0 | none | 4 (0) |
| Board, one run running | 64 | 12 | 0 | 12, each after a real change | 276 ms | 0 |
| Idle run page | 2 | 0 | 0 | 0 | none | 4 (0) |
| Running run page | 68 | 28 | 0 | 12, each after a real change | 306 ms | 0 |

Idle: one `git worktree list` a minute, no rebuild, no missed change and no watcher failure. Section 6's target (at
most 2 spawns a minute) is met. Every rebuild followed a real change; no rebuild that changed nothing is left.

**Finding and change.** With a run running, 48 of the 64 git calls were for the six finished runs, read again every
60 s. Now a finished run's counts are read again only when its git files change (HEAD, index, packed refs and its
branch ref), or every 10 minutes, the longest an edit that is neither staged nor committed can go unseen. A running
run is still read every 30 s.

| Board, one run running | git calls | Median rebuild | Longest rebuild |
|---|---|---|---|
| Before | 64 | 19 ms (mostly 12 to 21 ms; 72, 74, 78, 266 and 276 ms when counts were read) | 276 ms |
| After | 20 | 23 ms | 69 ms |

The median did not fall; the gain is the long tail and the spawn count.

- **P6, client side:** nothing to build. The board stream is opened once at the top of the app (`web/ui/src/App.tsx`),
  so the menu counts are live on every page, and a hidden tab closes it (`useStream`).
- **P8, dropped:** the backup poll runs only after a reconnect that stays silent. None happened in any state, so a
  conditional GET would save nothing measurable.
- **Not measured:** Linux and Windows; more than one tab (section 12 has the three-window numbers). The cold start's
  6 `gh` calls are one per finished run and are not repeated after a restart since #127.
- **Decided (2026-11-14):** one connection per browser (section 12) is a future enhancement, not built now; close-when-hidden stays the current behaviour.

## 15. The Completed list (2026-11-14)

Measured with `scripts/completed-probe.mjs` (120 completed tasks, a fake `gh` answering in 850 ms, what a live
`gh pr view` took on this repository; 5 runs each, median), before on `main` 851a137 and after on the same seeded state.

| Load | Before | After | gh calls before / after |
|---|---|---|---|
| Cold (nothing known) | 32.1 s | 2.2 s | 120 / 7 |
| Warm (cache fresh) | 4.0 s | 0.24 s | 0 / 0 |
| Restart (pr-status.cache present) | 32.2 s | 0.18 s | 120 / 0 |
| Expired (poll time passed) | 4.5 s | 0.28 s | 12 in the background, both |

Where the time went, and what changed (`src/runs/completed.ts`):

- **Blocking git per row (the warm 4 s).** `git log -1` for every task without a run record, `pickBase` (up to 8
  `git` calls) and `backlogItems`' `for-each-ref`, all `spawnSync`: the event loop was blocked about 4 s per load.
  Now one asynchronous `git for-each-ref` gives every branch date (`branchDates`, with git's own name lookup order),
  `pickBaseAsync` asks its candidates in one `git cat-file --batch-check`, and the titles come from the index without
  the branch lookup. The longest synchronous stretch during a load is now about 40 ms (cpu profile).
- **A restart forgot every status.** `pr-status.cache` was only read by a board or run view; the list now reads it too.
- **One `gh pr view` per PR on a cold load.** The links are now asked for in one `gh pr list --state all` with the
  same fields (`prefetchPrStatuses`); branches without a link still get their own `gh pr view` (gh picks among a
  branch's PRs), four at a time, while the list runs. The remaining cold floor is those branch calls. Live, the list
  of this repository's 134 PRs takes 5 to 7 s, against about 0.9 s for one `gh pr view`.
- **Failures were silent.** A failed check now keeps gh's whole message: in the task's `logs/errors.log` when it
  happens, on the row (`prError`) and for every task in `prErrors`. `SDLC_PR_TIMEOUT_MS` sets gh's timeout (3 s;
  the list gets 2 + 2 per 100 PRs times that).

- **Off the request path.** The cleanup #136 added for merged runs' briefs (`cleanMergedRunBrief`, from this list
  and from the board) now runs after the answer, with asynchronous git, one brief after another per repository (two
  checkouts at once fight over git's index lock); `settleBriefCleanups` waits for it. A project's context, when it
  must be built, has its three `git rev-parse` calls (about 150 ms) asked asynchronously first (`primeRepoPaths`).
  With 20 merged tasks in worktrees whose briefs need cleaning, the longest synchronous stretch during a load is 34 ms;
  the only longer ones are at the server's start (`gitTop`, triage's `recover`), not during a load.

Section 10 asked for "no `gh` on the request path" for this page. Built since (#138), with the user's decision of
2026-11-14 for rows first: `GET …/completed?rows=first` answers from git and the cache only, and marks a PR it does
not know yet `prPending`. Only when a row is pending does the page then ask for the settled list (`GET …/completed`,
unchanged). That list must stay equal to the list main answered before (the test pins it), and it joins the gh calls
the rows request started instead of repeating them. Rows the settled list leaves out are named in one short line, "N
tasks removed: PR not merged". The server also fills the PR status cache a few seconds after it starts, one registered
project at a time, with the same calls the list makes (`SDLC_WARM_PR_CACHE=0` turns that off; failures go to the
registry's errors.log and one line on stderr), so the first list after a start is warm. And a merged run whose link
the #136 cleanup took out of the main checkout's brief keeps being asked for by its run worktree's link, which is
cached, instead of by its branch. Measured with the same probe (120 tasks, fake gh 850 ms, median of 5): a cold load
shows its rows in 0.18 s instead of 2.10 s and settles in 2.18 s; the first load after a start with the warm-up done
takes 0.24 s with no gh call; with 20 merged runs in worktrees, a warm load went from 1.12 s and 2 gh calls to 0.18 s
and none, and a restart from 2.01 s and 8 calls to 0.18 s and none. In Chrome, a cold load's first row came after
0.36 s instead of 2.37 s.

Still open:

- Create PR clears every cached status (`clearPrCache` in `findOrCreatePr`), so the next load is cold.
- The detail panel's request (`completed/<slug>`) still makes 4 blocking git calls.
- Older PRs outside the `gh pr list` are looked up one by one, and the list itself can wait up to 18 s on a slow gh.

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
