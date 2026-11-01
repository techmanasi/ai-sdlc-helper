# Dashboard performance and run register: plan

Status: proposed, nothing implemented. Not a backlog item (the pipeline does not pick it up).
Each step below is its own small PR into `main`; stop after any step.

Claim status tags: **[measured]** run and timed here, **[verified]** read in the code, **[reasoned]** argued, not run,
**[reviewer, unverified]** reported by the independent reviewer, not re-checked by the author, **[design]** a proposal
whose numbers are starting points, **[estimate]** a saving not measured on a built fix.

## 0. Scope and what the user asked or clarified

Scope (the user's clarification): **the web dashboard only**, meaning the time from opening the `ui` address to a usable board.
CLI start-up speed is out of scope.

Where the user's questions or corrections added information, they are kept here and marked in the sections below with "(user)".

| # | The user said or asked | What it added | Where it is handled |
|---|---|---|---|
| U1 | Quote: "Since loading from files, its taking tie to load the UI" | The user's premise: files are the cause. Measured result: it is `git` process spawning, not file reads (F1). | Section 1 |
| U2 | Quotes: "Is there a better light weight db or a better file based index or any other mechanism to load faster" and "Is caching good idea for this setup" | The storage and caching decision (F22): no database or index, caching yes but not on file timestamps alone. | Section 3 (database and caching) |
| U3 | Quote: "why does this have to be in git? Why don't we keep a register of whats happening, what happened, what is pending etc." Paraphrase of the rest: a JSON file per task with the full state and process id, one file updated by one process; maybe in GitHub or another store; no refresh every 2 seconds, reload only on change; detect a crashed process by its process id. | The user's proposal, judged part by part (F23). It is partly built already (F9). | Sections 3, 4, 5 |
| U4 | Quote: "The output I posted is from a run i triggered in terminal" | The slow test log was the user's own run, not a clean run. My own background runs may have overlapped it, which is a possible cause of its flaky failure (F21). | Section 9 |
| U5 | Quotes: "I dont understand why we spawn 17 git process spawns", "Why do we spawn git process", "Help me understand in layman terms, may be draw diagrums" | The audience is not assumed to know git internals. A plain-language explanation with a diagram is part of the plan (F24). | Section 1a |
| U6 | Quote: "the board computes each run's red-tests commit - why? Can't we update this info to the file with a post commit hook?" | The user's hook idea, answered and rejected with reasons (F7, F8). | Section 2 |
| U7 | Quote: "can the server push changes to the board with sse only when there is a change? whats the pros and cons of this" | Clarified that the push already happens only on a difference, but detection still polls (F5, F17). | Sections 1 and 5 |
| U8 | Quotes: "Both still need a slow fallback timer - why?" and "A killed process changes no file - how about keeping a periodic checker on the process health?" | The user's idea of a cheap process-health checker, adopted as the answer for process death (F18). | Section 4 |
| U9 | Quote: "Noisy files can cause constant rebuilds - how to tackle this - can we wait for 10 seconds or task finish before re-building to reduce this" | The user's wait idea, adopted in part: not a flat delay, but different delays by kind of change, and boundary-only refresh for the counts (F20). | Section 5 |
| U10 | Quote: "park this for a quiet time" (the slow test suite investigation). The user's four questions there (paraphrased): why do the tests take this long, is it the number of tests, can they not run in parallel, can same-workflow tests be merged into one flow test | Kept as a parked item with its questions (section 10). | Section 10 |

## 1. Why the board is slow

- **F1** The cost is spawning `git`, not reading files. Two small file reads take 0.3 ms, the board JSON is about 2 KB, the JS
  bundle is 102 KB and is served in 3 ms. [measured]
- **F2** Route times (6 runs each, noisy machine, load average about 3.4, `syspolicyd` busy): `/board` 0.3 to 2.2 s,
  `/settings` 0.1 to 1.0 s, `/backlog/<slug>` 0.04 to 0.4 s. [measured]
- **F3** One cold board with 3 runs makes 17 git calls: 5 per project (3 `rev-parse`, `worktree list`, `for-each-ref`) plus 4
  per run (`merge-base`, `status`, `log --grep`, `diff`). It grows with the number of runs. [measured]
- **F4** One git call costs 7 to 14 ms normally and 75 to 93 ms when macOS exec checks are slow. One idle tab makes about 115
  spawns per 22 s, three tabs about 311. [measured]
- **F5** (user, U7: can the server push only on change?) `/api/events` is already server-sent events and already sends only when the board JSON differs
  (`web/server/index.ts:394`, `text !== last`). It still rebuilds the whole board every `pollMs` = 2000
  (`web/server/index.ts:88, 400`), with change counts only on every 5th read (`:392`). [verified]
- **F6** `/settings` recomputes the board through `activeRuns` (`web/server/index.ts:120`). [verified]
- **F15** `runView` builds more than the board card uses (recovery hint that reads the end of `run.out`, docs listing,
  `testIssues`, `createPr`, `stageFiles`), and `contextFor` rebuilds the project context on every tick (the 3 `rev-parse`).
  The git calls are synchronous, so a tick blocks the server's event loop. [verified that the calls are synchronous]
  The "about 1 s per tick per tab" figure is [reviewer, unverified].
- **F14** Flicker: change counts are null on 4 of 5 ticks, so the board JSON changes and two events are pushed every 10 s with
  nothing changed, and `web/ui/src/Board.tsx:28` hides "N files" for 8 of every 10 s. [verified]

### 1a. In plain words (user, U5)

The dashboard does not understand git itself. When it needs a fact, it starts the `git` program, asks one question, reads the
answer and lets the program exit. That start is a "spawn". Git is where the pipeline keeps its facts: which branches exist
(an item is "in progress" when a branch `sdlc/<slug>` exists, `src/backlog/index.ts:94`, [verified]), which files a run changed, and where each run's folder is.

- **F24**

```
 Browser          Dashboard server                 git program
   |  "show board"      |                               |
   |------------------->|  start git, ask question 1 -->|  answers, exits
   |                    |<------------------------------|
   |                    |  start git, ask question 2 -->|  answers, exits
   |                    |   ... 15 more times ...       |
   |<-------------------|
   |   board (about 2 KB)

 Asked once per project (5 calls):  rev-parse x3, worktree list, for-each-ref
 Asked again for each run (4 calls): merge-base, status, log --grep, diff
 3 runs: 5 + 12 = 17.   10 runs: 5 + 40 = 45.        (purposes inferred from the command text)

 Then the page asks again every 2 seconds, and it does not remember the last answer:
   now ---- 2s ---- 4s ---- 6s ---->   17 calls each time, per open tab
```

Starting a program costs about 7 ms normally and about 80 ms when macOS is busy checking new programs, which is why the same
page took anywhere from 0.3 to 2.2 s. That constant spawning probably also competes with the user's test runs (a link not
proven). [measured / reasoned]

## 2. The red-tests commit on the board (user, U6)

- **F7** (the user asked why) The board computes `redCommit` (a `git log --grep` per run, `src/runs/view.ts:177, 236`) although the card never shows
  it. It comes along because `boardView` (`src/runs/view.ts:296`) reuses `runView`. It is used by the run page's resume options
  (`web/ui/src/resume.ts:35, 37`) and by the pipeline (`src/pipeline/stages.ts:200, 205, 387`). [verified]
- **F8** The user proposed updating this into a file with a post-commit hook. Decision: no post-commit hook. [reasoned]
  - The pipeline itself makes the red-tests commit and can record the sha when it does.
  - A hook lives in the shared git folder, runs for every worktree, misses commits made by other tools or clones, and changes
    the user's repository setup.
  - A recorded sha goes stale after an amend or rebase; git finds the commit by its message, which survives a rewrite.
  - Resume decisions keep git as the authority. A recorded sha, if added, is verified with `git cat-file -e` first.

## 3. What already exists: the run register (user's proposal, U3)

- **F23** The user's proposal, judged part by part. [reasoned, partly measured; see F9 to F20]

| The user's idea | Verdict | Pros | Cons | Where |
|---|---|---|---|---|
| Keep a register instead of deriving state from git, one JSON file per task with full state and process id | **Partly built already** (F9). Keep it for process facts; leave code facts with git. | Exists, atomic, outside the worktrees so every checkout sees it, easy to read and watch | Cannot own code facts (changed files, merged, commits) without becoming a stale copy; "one writer" is not true today (F13); a pid alone is unsafe (F11) | F9, F10, Step 4 |
| One file updated by only one process | **Good rule, not true yet.** Both writers share one temp file name (F13). | No merge conflicts | Needs unique temp names and a rule for who owns each file | Step 4 |
| Store it in GitHub or other storage | **Not as the primary store.** Maybe a read-only mirror later. | Sharing across machines, survives disk loss | Network, credentials, rate limits, hundreds of ms against about 12 ms, a pid means nothing remotely | F10 |
| No refresh every 2 seconds; reload the data only when something changed | **Yes, in steps.** First stop rebuilding for nothing (Steps 1 to 3), then optional file watching (Step 6). | Near-zero idle cost, fast updates | No event for process death or uncommitted edits, missed events, noisy files | F17, Steps 1 to 6 |
| Identify a crashed process by its process id | **Yes, with a start-time check** (F11) and a cheap periodic checker (F18). | Already used, `kill(pid, 0)` is microseconds | A reused pid gives a false "running"; the orphaned-pipeline case is not covered (F12) | F11, F18, Step 4 |

### Database, file index and caching (user, U2)

- **F22** [reasoned from the measurements above; an earlier reviewer called the SQLite argument reasonable but not a measured comparison]
  - **No SQLite, no new file index, no second store.** The data is tiny (about 2 KB of board JSON, 0.3 ms to read the files);
    the time goes to spawning git, so a faster store would not help, and a second copy of git's facts would have to be kept in
    sync.
  - **Caching: yes**, but a cache keyed only on file timestamps is **not enough**. It would show a killed run as "running"
    forever (no file changes, F11), miss stage progress (written to each run's `status.json`, which a simple fingerprint did not
    include), miss brief edits under `<backlogDir>/<slug>/`, and miss uncommitted edits in a run's folder (no git metadata
    changes, F19). The cache must therefore combine: timestamps for records, `status.json`, the index and refs; a cheap pid
    check for liveness (F18); and a slower, stale-marked refresh for uncommitted counts (F19).
  - A fingerprint of 15 paths costs about 23 µs per call, against 17 git calls for a rebuild. [measured]

### Register details (F9, F10)

- **F9** Each run already has a record at `<git common dir>/sdlc-runs/<slug>.json` (slug, worktree, pid, started, state,
  exit_code, interrupted, finished, message, branch, base, root), written atomically (`src/runs/records.ts:59`). Stage, agent,
  model, tests and similar come from `status.json` and other files in `<worktree>/<backlogDir>/<slug>/logs`
  (the `Status` class, `src/pipeline/status.ts:25`, atomic write at `:49`). So the proposal (a JSON file per task, with process id) is partly built. [verified]
- **F10** Ownership split. [reasoned]
  - The register owns **process facts** (pid, state, stage, exit code).
  - Git owns **code facts** (changed files, merged, commits). Copying them into a register makes a stale copy.
  - GitHub or another remote store is **not** the primary store: it needs network and credentials, has rate limits, takes
    hundreds of ms against about 12 ms locally, and a pid means nothing remotely. A read-only mirror could come later.

## 4. Process health and crashes

- **F11** [measured / verified]
  - `kill -9` of a supervisor is detected (`runState`, `src/runs/records.ts:123`).
  - A reused pid gives a false "running": a record naming another live process reads as running.
  - `alive()` (`src/runs/records.ts:74`) already tries `kill(pid, 0)` first and returns at once for a dead pid (about 0.5 µs).
    For a pid that still exists (the case for every running run the board polls) it then starts `ps` to rule out a zombie,
    about 100 ms under load. [measured] The record's `started` is local time without a zone, so compare start times as an epoch.
- **F12** [reviewer, unverified] Killing the supervisor with `kill -9` leaves the pipeline child running while the board says
  "stopped". A late `writeRecord` from start can overwrite the supervisor's final record after its 5 s wait
  (`src/runs/supervisor.ts:48-49`). Also reported: a leftover `.tmp` after a full disk, and records whose `root` was moved.
- **F13** Both writers use one shared temp name `<slug>.json.tmp` (`src/runs/records.ts:59` and the embedded supervisor script,
  `src/runs/supervisor.ts:57`), so concurrent writers can lose or tear a record [reasoned]. The names are [verified]. The loss counts
  (about 650 of 1500 writes per writer failed, 4 torn reads in about 26,000) are [reviewer, unverified]. A truncated record
  reads as `{}`, not as missing.
- **F18** Process-health checker (the user's idea, U8: a periodic check on process health instead of a timer that rebuilds everything).
  [design; intervals are starting points]
  - Every 3 to 5 s, `kill(pid, 0)` for runs marked running only.
  - Rebuild and push only when a pid died. It needs the start-time check from Step 4.
  - It does not cover the orphaned-pipeline case (F12).

## 5. Pushing on change

- **F16** `fs.watch` experiment (macOS, one folder, atomic writes 250 ms apart): 20 of 20 events seen, 4 to 14 ms (median about
  12 ms). A burst of 5 writes gave 12 events, so debounce is needed. [measured, easy case]
  - Not tested: Node 18 on Linux (recursive watching may need one watcher per folder), the real folder layout, Windows.
- **F17** Event-driven updates (user, U7: pros and cons).
  - Pros: near-zero idle cost, about 12 ms updates, one watcher for all tabs, less load on the machine.
  - Cons: no event for process death or uncommitted edits, missed or merged events, debounce, noisy files, watcher lifecycle,
    harder tests, and a field-to-file mapping that must stay complete. [reasoned]
- **F19** Uncommitted-file counts cannot be watched cheaply (watching a worktree is heavy, and its `node_modules` is linked in)
  [reasoned]. Refresh them on a stage change (`status.json`), on run end, and when the board or run page opens or gets focus; show them as
  possibly stale. **Product decision, decided by the user: stale counts are acceptable** (section 8).
- **F20** Noisy files (user, U9: could we wait 10 seconds or until the task finishes?). [design; intervals are starting points]
  - Do not watch `run.out` for the board (only the run page shows it).
  - Debounce about 100 to 300 ms. Throttle to at most 1 rebuild per second, run at the start and again at the end of a burst.
  - Not a flat 10 s or only at task end: that would delay the changes users care about. The user's idea is adopted in part, for
    the counts only (boundary refresh).
  - Priorities by kind of change:
    - **immediate:** start, stop, pause, fail, finish, questions, permissions
    - **slow:** progress details such as test counts
    - **boundary only:** uncommitted counts

## 6. Steps (each its own PR into `main`)

**Step 0: baseline (no code).** Reuse the spawn-logging `git` shim and the SSE and `curl` loops. Baseline: 17 git calls for a
cold board, about 115 per 22 s per idle tab, about 2 events per 10 s when idle.

**Step 1: stop the flicker (F14).** In `events()` (`web/server/index.ts`), keep the last change counts and put them into the next
4 reads.
- Tests (`web/test/server.test.ts`): with a small `pollMs`, an unchanged project gets exactly one board event across more than
  5 ticks; the counts are present on every event.
- Risk: low (counts can be up to 5 ticks old, as today). Check: events per 10 s drop from about 2 to 0 [estimate, target].

**Step 2: slim the board (F7, F15).** Add an option to `runView` (next to `changes` and `checkPr`) that skips `redCommit`, the
recovery hint, the docs listing, `testIssues`, `createPr`, `stageFiles` and the `run.out` tail; `boardView` uses it.
- Tests (`test/view.test.ts`): card fields are identical to before; with a counting `git` on PATH, a board makes no
  `git log` call.
- Risk: low (only a card field accidentally dropped). Check: a cold board goes from 17 to about 14 calls. [estimate]

**Step 3: one shared poller per project (F5, F6, F15).** In `web/server/index.ts` (`events()`, `contextFor`, the `settings` route): one poller per project in the server, shared by all event clients,
computing the board once; cache the project context and rebuild it only when settings or the registry change; stop recomputing
the board inside `/settings`.
- Tests (`web/test/server.test.ts`): 3 clients make the same number of git calls as 1; a late client gets the current board at once; the poller stops with
  the last client.
- Risk: medium (cache invalidation must not show stale settings). Check: idle spawns per tab fall from about 5/s to under 1/s
  in total. [estimate]

**Step 4: make the register safe (F11, F13).** Unique temp names in `src/runs/records.ts` and in the embedded supervisor script;
store the process start time (epoch) in the record; `alive()` compares it with the process's real start time and treats a
mismatch as dead; older records without the field keep working. To avoid a `ps` call on every poll, verify the start time when
a run is first seen and again on a slower interval, with `kill(pid, 0)` in between (the interval is a design choice, F11).
- Tests (`test/runs.test.ts` or a new file `test/records.test.ts`): two real writers lose nothing and no read is unparseable; a
  reused pid with a mismatched start time is not alive; an old record without the field works.
- Risk: medium (it changes what `ai-sdlc-helper status` reports). Check: zero lost writes; the liveness check cheaper than the
  current `ps` call [target].

**Step 5: change counts on a slow tick, marked stale (F19).** In `web/server/index.ts`, `src/backlog/index.ts` (`for-each-ref`) and `src/runs/records.ts` (`mainTree`, `worktree list`): refresh counts on a slow timer or on demand; cache `for-each-ref`
and `worktree list` on the mtimes of the refs and worktrees folders; the board marks counts older than one tick as possibly
stale.
- Tests (`web/test/server.test.ts`, `test/backlog.test.ts`): with a counting `git`, an idle project makes no calls between slow ticks; a new branch shows within one tick.
- Risk: medium. Check: idle spawns fall to about 0.1 to 0.3 per second in total. [estimate]

**Step 6 (optional): push on change (F16 to F18, F20).** In `web/server/index.ts` plus a new `web/server/watch.ts`: one server-side `fs.watch` on the registry folder, each run's `logs`
folder and the backlog `index.md`; debounce; ignore `run.out`; the process-health checker and a slow tick stay as the fallback.
- Tests (`web/test/server.test.ts`): a record write reaches a client within a stated time; a `run.out` write triggers nothing.
- Risk: medium to high (missed or merged events, watcher lifecycle). Check: idle spawns near zero between changes [estimate].
- Open: check Node 18 on Linux before relying on recursive watching.

**Step 7: separate investigation, no code change (F12).** Reproduce the orphaned-pipeline case (`src/runs/supervisor.ts`) and
the late-overwrite case (`src/runs/index.ts`, `start`) with a throwaway script. Output: a written reproduction and a decision on
whether each needs its own step. Risk: none (read-only). Check: both cases reproduced or ruled out.

Order: Steps 1 and 2 first (cheapest, safest), then 3, 4 and 5 (each stands alone), then 6 only if idle cost still matters.

## 7. Conventions for the work (CLAUDE.md)

Node 18 only (no newer Node APIs). Tests live in `test/` or `web/test/`, run the real code and never assert on documentation.
Name SDLC stages, never number them. Run `npm run check` before every commit. PRs go into `main`, and the user confirms each
merge, naming the PR and its CI status. Use the `porter` subagent for phase work, with a brief that names the exact files, the
plan section and the definition of done.

## 8. Decisions

Decided by the user:
1. Stale uncommitted-file counts between refreshes are acceptable (F19). Step 5 may therefore show counts that are up to one slow
   tick old, marked as possibly stale.

Still open (the user decides; not decided here):
2. Write these steps as backlog briefs for the pipeline, or implement them directly one step at a time?
3. Fix the intervals (F18, F20) only after measuring on a built step.

## 9. Known gaps and caveats (F21)

- Every saving above is an estimate; none was measured on a built fix.
- The test log the user posted came from the user's own terminal run (U4); my own background runs may have overlapped it, so its
  flaky failure may be load-induced [reasoned, not proven]. My first "alone" runs of the flaky test were void because other test runs were active; timings in section 1 were taken on a
  busy machine (load about 3.4) and swing widely.
- The reviewer found the author's field table for the board incomplete (missing `items[].archived` and `items[].slug`, several
  fields without a file:line, two wrong line numbers); it was not rebuilt. [reviewer finding]
- Not measured: first paint in a browser, the cost of a slow timer, the board under many runs.
- F12 and the loss counts in F13 are the reviewer's findings, not re-run.

## 10. Not part of this plan (pointers only)

- The parked investigation of the 13-minute test suite (791 s in the user's log) and the flaky `web/test/triage.test.ts` timing race (saved in memory as
  `parked-slow-suite-investigation`), parked by the user for a quiet time (U10). The user's questions to answer there: why do the
  tests take this long, is it the number of tests, can they not run in parallel, and can tests of the same workflow be merged
  into one test that walks the flow so a failure breaks the whole flow? Early hypotheses, not verified: per-test setup (a fresh
  git repo, worktree, server and spawned processes) dominates; the 4-worker cap in `vitest.config.ts` is deliberate; the longest
  file sets the floor; the flaky test races a fixed 1.5 s sleep.
- `README.md` still lacks the new `--push` and `--pr` flags for `ai-sdlc-helper add`.
- The deleted `docs/backlog/add-setup-branch-pr` brief shows as an uncommitted deletion.

## Appendix: coverage of the discussion

| IDs | Section |
|---|---|
| F1 to F6, F14, F15 | 1 |
| F7, F8 | 2 |
| F9, F10 | 3 |
| F11, F12, F13, F18 | 4 |
| F16, F17, F19, F20 | 5 |
| F21 | 9 |
| F22, F23, F24 | 3, 3 (database and caching), 1a |
| U1 to U10 (the user's questions) | 0 |
| S0 to S7 | 6 (Steps 0 to 7) |
| Conventions | 7 |
| Open decisions | 8 |
| Pointers | 10 |
