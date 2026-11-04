# Move triage and palette onto supervised jobs

Dashboard triage and the command palette should become **jobs**: finite processes started by the existing detached supervisor ([src/runs/supervisor.ts:32-122](../../src/runs/supervisor.ts)), writing every byte to files under `<git common dir>/sdlc-runs/`, and read back by a server that holds no state of its own. Most of the machinery already exists. Every triage turn is already a headless `claude -p` with stdin ignored, `--resume <session_id>` for follow-ups, and pauses only while no agent runs ([web/server/triage.ts:204-279, 308-368](../../web/server/triage.ts)). The palette already spawns `node dist/bin.js …` with no terminal ([web/server/index.ts:143-155](../../web/server/index.ts)). What ties them to the server is hosting. The phase machine runs in a child's `close` handler, events fan out from memory, output arrives over pipes, and `close()` SIGKILLs the agents. The plan moves triage's phase machine into a hidden `triage-run` CLI driver, the same shape as `pipeline`: it exits 0 when done, 2 at a gate, 1 on failure. Palette commands become supervised command jobs with file output and a byte-offset SSE tail. Both share the five safeguards: start-time identity, a supervisor heartbeat, a SIGINT→SIGTERM→SIGKILL escalation on the child's process group, a per-job lock, and an orphan reconcile on server start that can resume a pipeline whose agent finished but whose checks never ran. Pipelines keep their file names, record fields and exit codes. The work splits into **29 PRs in 8 phases**. Foundations, agent fixes, the file tailer and the triage driver core can run in parallel.

---

## 1. Summary and target design

### One job model, three kinds

A **job** is one supervised process tree with a record, a heartbeat, an interrupt marker, an optional lock and output files. Its `kind` is `pipeline` (today's runs, files unchanged), `triage` (one invocation of the triage driver, which runs agent turns until it reaches a gate or the end), or `command` (one palette command line). The server never parents a job. It starts the job through `startSupervisor` and returns at once. It reads state only from files, stops a job by signalling its verified supervisor, and after a restart rebuilds its view from the records, the heartbeats and the output files.

A user steps in only when a file asks them to. That matches the pipeline. Spec and Plan agents write `questions.md` and the pipeline exits 2 ([src/pipeline/stages.ts:118-172](../../src/pipeline/stages.ts)). Refused actions go to `permissions.json`, also exit 2 ([src/pipeline/agent.ts:197-203](../../src/pipeline/agent.ts)). Triage items write `<slug>-questions.md` ([assets/prompts/triage-item-questions.md](../../assets/prompts/triage-item-questions.md)). When `SDLC_AUTO_ACCEPT` (or the run's `autoAccept`) is set, the suggested answers are accepted and no pause happens, as in [src/pipeline/stages.ts:80-95](../../src/pipeline/stages.ts). **Decision (user, 2026-11-04): triage has no gate of its own.** Picking which items to keep is no longer a separate `choosing` gate. It becomes one more question in the run's questions file, with options to pick from (see "Triage as an asynchronous, file-driven conversation" below). The only thing that pauses triage is a question file with unanswered questions. Quick mode and auto-accept answer it with the suggested choice (keep all).

### Triage as an asynchronous, file-driven conversation

The user may answer at once, an hour later or after a server restart. No process waits while triage waits for an answer: the run's files hold everything needed to continue.

**Files in the triage run folder** `<wt>/<backlogDir>/.triage/<runId>/`, each with a single writer:

| File | Written by | Holds |
|---|---|---|
| `run.json` | the driver (the server writes only inside `before`, under the lock) | state, phase, `current`, `sessions` `{ split: <uuid>, items: { <slug>: <uuid> } }`, `turn` count, `rehydrated` count |
| `context.md` | the agent (told to by the prompt), on every turn | the requirement as given, the brainstorm, decisions taken so far and their reasons, progress (what is done and what is next). It is the agent's own memory for a fresh session. |
| `questions.md` (split) and `<slug>-questions.md` (items) | questions: the agent or the driver. Answers: the server, for the user. | `### Q<n>` blocks with `**Suggested:**` and `**Answer:**`, in the pipeline format, plus an optional `**Options:**` list |
| `items.json` | the agent | the proposed backlog items |
| `marks.json` | the server | saved and skipped marks |

**The loop.**
1. **Start.** The user gives a requirement. The server writes `run.json` (state `running`, the requirement in `context.md`) and kicks the driver job.
2. **Turn.** The driver starts the coding agent's first turn with a plain headless command: no `--session-id`, no `--resume`. It **captures the agent's own session id from the agent's output** (table below) and saves it to `run.json.sessions` the moment it appears, so a crash later in the turn still keeps it. Every later turn in the same scope resumes that id with the harness's own resume command, adding the answers and any extra context to the prompt.
   - The prompt tells the agent to keep `context.md` up to date and to put every question for the user in the questions file, each with a suggested answer, and then end its turn.
3. **Pause.** If the questions file has an unanswered question, the driver writes state `waiting` and a `question` event, and exits 2. The supervisor exits too, so nothing is running.
4. **Answer, now or later.** The UI shows the questions with the suggested answers filled in and, when there is an `**Options:**` list, checkboxes or radio buttons. On submit, the server writes each choice under `**Answer:**` (inside `before`, under the lock) and kicks a new driver job.
5. **Resume.** The driver runs `--resume <session id>` with the answered-questions prompt (`triageAnsweredMessage`), which names the questions file. Answered questions are moved to a `## Decided` section in `context.md`, as the pipeline's `recordAnswers` does for `decisions.md`.
6. **Pick items.** When the split turn ends with `items.json` and no open questions, the **driver** (not the agent, so the format is always right) appends one question:
   ```
   ### Q<n> Which items should go into the backlog?
   **Options:** (multi)
   - [x] add-login-rate-limit — Rate-limit the login endpoint
   - [x] audit-session-expiry — Check session expiry rules
   **Suggested:** all
   **Answer:**
   ```
   Then it pauses as in step 3. The user's ticks become the answer: the kept slugs, one per line. On resume, the driver passes the choice to the same split session, then runs one item turn per kept slug. Skipped slugs get `skipped` marks.
7. **End.** When every kept item has a draft and its questions are answered, the state is `ready`. The UI loads the drafts as it does today.

**When the session can't be resumed, start a new one.** A resume can fail because the session file is gone (`~/.claude` cleared, another `HOME` or machine, a different CLI) or because the id was never written.
- **Detect it.** For agy and codex, the failure text is not yet known (V15). Treat a resume turn with no session id in its output and a non-zero exit as failed-to-resume. On Claude Code 2.1.318, an unknown id exits **1** with an empty stdout and `No conversation found with session ID: <id>` on stderr (checked 2026-11-04). The driver treats a resume turn as failed-to-resume when its stderr matches `/No conversation found with session ID/`, or when it produced no result line and no assistant events. Anything else is an ordinary failure.
- **Rehydrate.** Start a new session (a plain first turn, its id captured from the output) with a *rehydrate prompt*. The prompt holds `context.md`, the questions file with its answers, the user's item choice if made, `items.json`, and the drafts written so far. It ends with: "You are continuing an earlier session that could not be loaded; carry on from the progress above."
- **Record it.** Save the new id in `sessions`, increment `rehydrated`, and log a `session-restarted` event, which the UI shows as a note.
- **No loops.** Allow one rehydrate per turn. If the new session also fails, the run fails with the stderr shown.
- **Fallback for a missing `context.md`.** Rebuild context from `events.jsonl` and the turn files instead.
- **Codex and agy** resume natively too, with the commands in the table below. The rehydrate path is only for a missing or unloadable session, whatever the harness.

**Session ids per harness** (user-supplied, 2026-11-04; the local `--help` output was checked for flag names the same day):

| Harness | First turn | Where the session id comes from | Resume with answers |
|---|---|---|---|
| `claude` | `claude -p "<prompt>" --output-format json` (triage: `stream-json --verbose` for live events) | `.session_id` on the result. With stream-json it is also on the first `system`/`init` line, so it's captured early. | `claude -p "<answers + context>" -r <session_id>` (same as `--resume`) |
| `agy` | `agy -p "<prompt>" --output-format json` | `.conversation_id` on the JSON payload | `agy -p "<answers + context>" --conversation <id>` (`--conversation` is listed in `agy --help`) |
| `codex` | `codex exec --json "<prompt>"` | the first JSONL event, `{"type":"thread.started","thread_id":"<uuid>"}` ([codex exec_events.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs)) | `codex exec resume <id> --json "<answers + context>"` |

- **Codex caveat:** `codex exec resume --help` lists no `-C` and no `-s`/sandbox flag. So set the folder through the spawn's `cwd`, and pass the sandbox as `-c sandbox_mode="workspace-write"`. Don't reuse `compileStageArgs`' argv as it stands.
- **Never use "most recent session" options** (`claude --continue`, `agy --continue`, `codex exec resume --last`): parallel jobs make "most recent" ambiguous.

**Session scope: one stage, one session.** No two pipeline stages share a session (user rule, 2026-11-04).
- **Pipeline:** every stage (Spec, Plan, Red tests, Implement, Test repair, Review, Finalise) starts with a new session. A session is resumed only *within* its stage: after the user answers that stage's questions, after a refused action is decided, or for that stage's own retries (Implement attempts, if the stage chooses to).
  - Store it as `status.json.sessions[<stage>]`.
  - Clear it when a stage starts fresh, including `--from <stage>`. A resume of a stage whose stored session belongs to an earlier run of that stage starts new and rehydrates from `docs/<slug>/` (spec, plan, `decisions.md`).
- **Triage:** the split is one scope and each item is one scope (`sessions.split`, `sessions.items[<slug>]`). An item never resumes the split's session, and the split never resumes an item's.
- **Handover between stages stays through files** (spec, plan, `decisions.md`, `context.md`), never through a shared conversation.

### File layout under `<git common dir>/sdlc-runs/`

```
sdlc-runs/
  .start.lock                      unchanged (parallel-cap mutex, held for milliseconds)
  <slug>.json                      pipeline record (unchanged; new optional fields only)
  <slug>.wrapper.log               unchanged (+ one "== <ts> swept N leftover process(es)" line when a sweep fires)
  <slug>.interrupt                 unchanged
  <slug>.setup-pending             unchanged
  <slug>.live.json                 NEW  heartbeat; written ONLY by that run's supervisor
  locks/<slug>.lock                NEW  per-pipeline lock (owner identity inside)
  locks/triage-<runId>.lock        NEW  per-triage-run lock (spans driver invocations)
  triage/pointers.json             MOVED from triage.json (legacy file read once, then removed)
  jobs/<id>/job.json               NEW  triage/command record
  jobs/<id>/live.json              NEW  heartbeat (supervisor only)
  jobs/<id>/supervisor.log         NEW  supervisor's own log
  jobs/<id>/interrupt              NEW  stop marker
  jobs/<id>/stdout.log, stderr.log NEW  command jobs' output
```

Triage keeps its run folder inside the triage worktree. It is `<wt>/<backlogDir>/.triage/<runId>/` ([src/triage.ts:90, 103](../../src/triage.ts)) and holds `run.json`, `events.jsonl`, `items.json` and `<slug>-questions.md`. It gains `driver.out` (the driver's stdout and stderr, which are the supervisor's `outFile`), `turns/<n>-<phase>[-<slug>].ndjson` (each agent turn's stream-json), and `marks.json` (saved/skipped marks, written only by the server). Job ids are `t-<runId>-<n>` for triage (n counts driver invocations) and `c-<yyyymmddHHMMss>-<rand6>` for commands. Both match `SLUG`, sort by time, and live in a subfolder. That matters because `recordedSlugs` lists only `*.json` in the registry root through a non-recursive `readdirSync` ([src/runs/records.ts:64-68](../../src/runs/records.ts)), so jobs never count as pipeline runs. `<slug>.live` contains a dot and never matches `SLUG`, so `<slug>.live.json` is ignored as well.

### Record schema (strict, optional extension of `RunRecord`)

```ts
// src/runs/proc.ts
export interface ProcIdentity { pid: number; start: string /* LC_ALL=C ps -o lstart= */; bootId?: string }

// src/runs/records.ts — RunRecord ([src/runs/records.ts:10-31]) gains only optional fields; JobRecord is the job sibling.
export interface RunRecord { /* existing fields … */ v?: 1; kind?: 'pipeline'; supervisor?: ProcIdentity }
export interface JobRecord {
  v: 1; kind: 'triage' | 'command'; id: string; root: string;           // root = project root (per-project listing)
  argv: string[]; cwd: string; outFile: string; errFile?: string;
  pid: number; supervisor?: ProcIdentity;                               // pid kept for the supervisor's handshake
  state: 'running' | 'exited'; exit_code: string; interrupted: boolean;
  started: string; finished: string; message: string;
  timeoutMs?: number;                                                    // command jobs (default 120000)
  result?: { subtype: string; is_error: boolean; session_id: string;     // agent turns, parsed from the last NDJSON line
             terminal_reason?: string; stop_reason?: string | null; num_turns?: number; denials: number };
  owner?: { runId?: string; slug?: string; phase?: string };             // triage back-pointer
}
// <job>/live.json and <slug>.live.json — supervisor is the ONLY writer (tmp+rename), every 10 s:
export interface LiveFile { at: string; seq: number; supervisor: ProcIdentity;
  child?: ProcIdentity & { pgid: number }; phase: 'setup' | 'main' | 'sweeping' | 'stopping' }
// status.json StatusLine ([src/pipeline/status.ts:7-22]) gains: agent_pid?, agent_start?, agent_out? (absolute path)
// triage run.json gains: job?: { id: string }, autoAccept?: boolean
```

Each file has one writer at a time. The starter writes the `running` record, and the supervisor writes the final one, using the existing wait-for-my-pid handshake ([src/runs/supervisor.ts:45-60](../../src/runs/supervisor.ts)). Only the supervisor writes `live.json`. Only the pipeline writes `status.json`. Only the lock holder writes triage `run.json` and `events.jsonl`: the driver while it runs, the server at a gate. Only the server writes `marks.json`.

### Lifecycle

```
 starter (server route / CLI)                 supervisor (detached, own pgid)            child (detached on POSIX: pid == pgid)
 ───────────────────────────                 ───────────────────────────────            ───────────────────────────────────────
 takeLock(lockFile, me)  ─ EEXIST & owner alive → refuse (pipeline exit 4 / HTTP 409)
   └ stale owner (sameProcess false) → rename lock.stale.<ts>, retry once
 before() under lock (e.g. write kept slugs)
 startSupervisor(job) ───────────────────────► write live.json(phase setup|main)
 lock owner := supervisor identity             setInterval(heartbeat 10 s).unref()
 write running record {pid, supervisor}        run setup steps (pipelines only)
 return (HTTP 200/202)                          spawn child {detached:!win32} ──────────────► runs (pipeline / triage-run / CLI cmd)
                                               live.json.child = {pid, pgid, start}           writes its own files (status.json,
                                                                                              events.jsonl, NDJSON, stdout.log)
 ── stop ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 write interrupt; verify supervisor identity
 SIGTERM supervisor (one pid) ───────────────► escalate on -pgid: SIGINT ─10 s─ SIGTERM ─10 s─ SIGKILL; ps-tree sweep fallback
 wait for record 'exited' (≤ 25 s)
 └ supervisor dead/hung → stopper escalates on live.json.child.pgid itself, then writes final record interrupted:true
 ── child exits ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                               sweep -pgid (SIGTERM, SIGKILL after 2 s) if members remain
                                               parse result (agent jobs), write final record (handshake),
                                               delete lock + live.json, exit(child code)
 ── server start / start() / stop() ───────────────────────────────────────────────────────────────────────────────────────────
 reconcile(): running records → running | hung | orphaned | agent-finished-checks-not-run | supervisor-lost (decision table §2 C4)
```

This design differs from the notes in one way. In the notes, the *stopper* runs the 20-second escalation itself. Here the stopper signals the verified supervisor and lets it escalate, and takes over only when the supervisor is dead or its heartbeat is stale. The reason is that a server killed in the middle of a stop then still leaves a finished stop behind. Today, by contrast, `stopProcess` SIGTERMs the supervisor's whole tree at once, so the agent gets a SIGTERM directly and records no result ([src/runs/index.ts:295-302](../../src/runs/index.ts); [src/runs/records.ts:112-120](../../src/runs/records.ts)).

---

## 2. Implementation plan

Each subtask is one PR into `main`. IDs are stable, and §3, §5 and §6 refer to them. Line ranges were verified on `main` at 87c07a7 on 2026-11-04. Before each brief is handed out, the orchestrator re-checks the spans with `graft_file_api` (§7).

### Dependency graph and parallel lanes

```
A0 ─┬─► A1 ─────────────────────────────────────────────────────────────┐
    ├─► A2 ─┬─► A3 ─┐                                                    │
    │       └─► A4 ─┼─► B2 ─► B3 ─► C1 ─► C2 ─► C3 ─► C4 ─► C5            │
    ├─► B1 ─────────┘            │            └────────► D3 ─► D4        │
    ├─► D1   (independent)       └─► E1 ─┬─► F1 ─► F2                    │
    ├─► D2 ──────────────► (C3 needs D2) │                               │
    ├─► E2   (independent)  ─────────────┴─► G2 ─► G3 ─► G4              │
    └─► G1   (independent; driver core)  ─────► G2                       │
                                                         H1 (last) ◄────┘
```

Lane 1 (can start as soon as A0 merges, all in parallel): **A1, A2, B1, D1, D2, E2, G0, G1, G1b**. **P1** after G0 and D1. Lane 2: **A3 ∥ A4** after A2. **B2** after A2, A4 and B1. After B3, the jobs API **E1** and pipeline hardening **C1** can run in parallel. **F1** and **G2** both need E1 and E2. They touch different files (`web/server/index.ts` against `web/server/triage.ts`), so they can run in parallel with each other. **D3** needs C3 and D2. Merge in dependency order. Rebase each PR on `main` after its parent merges.

---

### Phase A: Foundations (registry hygiene, identity, group kill, lock)

#### A0: Commit the plan where briefs can point
<!-- model: sonnet --> Reason: a copy and two lines of docs, nothing to decide.
- **Goal:** Copy this report to `docs/plans/detached-jobs.md`. Add one bullet under `## Still open` in `docs/PLAN.md` (after line 91): "Detached triage and palette jobs: see docs/plans/detached-jobs.md". Every later brief cites "docs/plans/detached-jobs.md §2 <ID>".
- **Files:** new `docs/plans/detached-jobs.md`; `docs/PLAN.md:86-96`.
- **Done:** both files committed, `npm run check` green.
- **Tests:** none (docs only).
- **Depends:** none.

#### A1: Keep triage's pointer out of the run registry
<!-- model: sonnet --> Reason: a path move plus a filter, fully specified.
- **Goal:** `recordedSlugs` never returns `triage`, and the triage pointer moves to `<reg>/triage/pointers.json`.
- **Files:**
  - [src/runs/records.ts:64-68](../../src/runs/records.ts): add `.filter(s => s !== 'triage')` for legacy files.
  - [web/server/triage.ts:66-101](../../web/server/triage.ts): change `pointerFile` to `path.join(registryDir(root), 'triage', 'pointers.json')`. `readPointers` falls back to the legacy `triage.json`. `writePointers` creates the folder and deletes the legacy file after it writes the new one.
  - Test helper `plant()` in [web/test/triage.test.ts:555-565](../../web/test/triage.test.ts): write the new path. Add one case that writes the legacy path.
- **Done:** existing triage tests pass. A legacy pointer is migrated. `boardView` and `statusLines` show no `triage` card while a pointer exists.
- **Tests:** §5 A1.
- **Depends:** A0. Run §4 V1 first and record what the board shows today in the PR description.

#### A2: Process identity primitives
<!-- model: opus --> Reason: PID-reuse semantics, locale and boot-id edge cases; a wrong `sameProcess` leads to signalling an unrelated process.
- **Goal:** add a new module `src/runs/proc.ts` with:
  - `procStart(pid): string`: `spawnSync('ps', ['-o', 'lstart=', '-p', pid], { env: { ...process.env, LC_ALL: 'C' } })`, trimmed, `''` if the process is gone.
  - `bootId(): string`, cached: `sysctl -n kern.boottime` on darwin, `/proc/sys/kernel/random/boot_id` on linux, `''` otherwise.
  - `identity(pid): ProcIdentity`.
  - `sameProcess(id?: ProcIdentity): boolean`: `alive(id.pid) && procStart === id.start && (!id.bootId || id.bootId === bootId())`. When `start === ''` (Windows, or ps missing), fall back to `alive`.
  - `ownPgid(): number`, cached from `ps -o pgid= -p <process.pid>`.
  - `groupMembers(pgid): number[]`, from one `ps -A -o pid=,pgid=` listing.
  - Win32: `procStart` returns `''` without spawning anything, so identity is skipped as decided in the notes.
- **Files:** new `src/runs/proc.ts`. Reuse `alive` from [src/runs/records.ts:74-82](../../src/runs/records.ts). Do not move it.
- **Done:** functions exported and tested on darwin and linux CI. No new Node APIs (Node 18).
- **Tests:** §5 A2.
- **Depends:** A0.

#### A3: Guarded group kill and the escalation helper
<!-- model: opus --> Reason: process-group signals are the most dangerous code in the change; the guards must keep the intent of `killTree`'s `pid <= 1` refusal.
- **Goal:** add to `src/runs/proc.ts`:
  - `killGroup(pgid, signal, expect?: ProcIdentity): boolean`. All of these must hold:
    1. `Number.isInteger(pgid) && pgid > 1`;
    2. `pgid !== ownPgid()`;
    3. either `sameProcess(expect)` holds, or `groupMembers(pgid).length > 0`.

    The last guard rests on POSIX: a pid is never reused while a process group with that id is active ([POSIX fork](https://pubs.opengroup.org/onlinepubs/9699919799/functions/fork.html); [POSIX kill](https://pubs.opengroup.org/onlinepubs/9699919799/functions/kill.html)). Otherwise the function returns false and sends nothing.
  - `escalate(target: { pgid?: number; child?: ProcIdentity; treeRoot?: number }, waitMs = 10000): Promise<boolean>`: SIGINT, wait, SIGTERM, wait, SIGKILL on `-pgid`. It polls `groupMembers` every 200 ms and returns early when the group is empty. It finishes with a `processTree(treeRoot)` sweep. When there is no pgid (legacy record) it falls back to `killTree(treeRoot)`, as `stopProcess` does today.
  - Leave `killTree` and its guard untouched ([src/runs/records.ts:112-120](../../src/runs/records.ts)).
- **Files:** `src/runs/proc.ts`; export from [src/index.ts:38](../../src/index.ts).
- **Done:** tests pass. `killTree` behaviour is unchanged ([test/runs.test.ts:81, 333](../../test/runs.test.ts); [test/shell.test.ts:95-101](../../test/shell.test.ts)).
- **Tests:** §5 A3.
- **Depends:** A2.

#### A4: Identity-owned per-job lock
<!-- model: opus --> Reason: a lock/stale-break race; it must never break a live owner's lock on mtime.
- **Goal:** add a new module `src/runs/lock.ts` with:
  - `takeLock(file, owner: ProcIdentity): { ok: true } | { ok: false; owner: ProcIdentity }`:
    - Create the lock with `openSync(file, 'wx')` ([Node 18 fs flags](https://nodejs.org/docs/latest-v18.x/api/fs.html#file-system-flags)) and write the owner's JSON into it.
    - On `EEXIST`, read the owner. If `sameProcess(owner)` holds, refuse.
    - If the owner is dead or unreadable for more than 2 s (a half-written file), rename the lock to `<file>.stale.<ts>` and retry `wx` once.
  - `setLockOwner(file, owner)`: tmp+rename.
  - `releaseLock(file, owner)`: delete only when the owner pid matches.
  - Leave `withStartLock` as it is ([src/runs/index.ts:128-141](../../src/runs/index.ts)).
- **Files:** new `src/runs/lock.ts`.
- **Done:** tests pass. No mtime-based break.
- **Tests:** §5 A4.
- **Depends:** A2.

### Phase B: The generic supervisor

#### B1: Generalise the `Job` type and record (no behaviour change)
<!-- model: sonnet --> Reason: type widening and wording only; the pipeline path must stay byte-identical.
- **Goal:**
  - In [src/runs/supervisor.ts:15-30](../../src/runs/supervisor.ts), `Job` gains `kind?`, `errFile?`, `liveFile?`, `lockFile?`, `timeoutMs?` and `result?: 'claude-stream' | 'claude-json' | 'none'`. `setup` and `setupMarker` become optional (`setup ?? []`). `record` widens to `RunRecord | JobRecord`.
  - Add `JobRecord` to [src/runs/records.ts:10-31](../../src/runs/records.ts) as in §1.
  - In `SOURCE`, `job.setup` becomes `(job.setup || [])` at lines 96 and 102. The message at line 105 says "could not start the " + (job.kind === 'command' || job.kind === 'triage' ? 'job' : 'pipeline"), so the pipeline text stays the same. Line 58 logs `job.slug || job.id`.
  - Open `errFile` separately when it is set (line 40, stdio at line 89).
- **Done:** `test/runs.test.ts` passes unchanged, and every existing record and log line is unchanged.
- **Tests:** §5 B1.
- **Depends:** A0.

#### B2: Heartbeat, own process group, identity in live.json, sweep on exit
<!-- model: opus --> Reason: changes the process topology of every pipeline run; the ordering of live.json writes against the final record is race-prone.
- **Goal:** add to `SOURCE` in [src/runs/supervisor.ts:32-107](../../src/runs/supervisor.ts):
  - **Heartbeat.** `writeLive(phase)` writes `job.liveFile` with tmp+rename, and a `setInterval(writeLive, 10000).unref()` that starts before setup.
  - **Own group.** The main child (line 104 `runStep(job.argv…)`) is spawned with `detached: process.platform !== 'win32'`. Setup steps stay non-detached.
  - **Child identity.** Right after the spawn, record `live.child = { pid, pgid: pid, start: lstart(pid) }`. The `lstart` is an inline `spawnSync('ps', …)` with `LC_ALL=C`, because SOURCE cannot import TS.
  - **Sweep on exit.** In `finish()`, before the record is written, run `ps -A -o pid=,pgid=` and look for members of `child.pgid`. If there are any, log `== <ts> swept N leftover process(es)`, SIGTERM the group, wait up to 2 s with `Atomics.wait` polls, then SIGKILL.
  - **Cleanup.** After the final record is written, delete `liveFile` and `lockFile` (`lockFile` only when it names this pid).
  - **Starter side.** `start()` passes `liveFile: regFile(ctx, slug, 'live.json')` (the `regFile` helper is at [src/runs/index.ts:112](../../src/runs/index.ts)).
  - **Windows.** No detach and no lstart. The heartbeat still runs.
- **Done:** pipeline runs still produce identical `run.out` and `wrapper.log`, apart from the optional sweep line. `live.json` exists while a run is running and is gone after it ends. `AI_SDLC_HELPER_PIPELINE_CMD` (`sh -c`) runs still work, with `sh` as the group leader.
- **Tests:** §5 B2.
- **Depends:** A2, A4, B1.

#### B3: Escalating stop, timeout and result parsing inside the supervisor
<!-- model: opus --> Reason: signal escalation and the SIGINT-exits-0 trap.
- **Goal:** replace `stop()` at [src/runs/supervisor.ts:75-82](../../src/runs/supervisor.ts):
  - On POSIX it writes `live.phase = 'stopping'`, sends SIGINT to `-child.pgid`, then SIGTERM after 10 s and SIGKILL after 20 s (timers `unref`'d, cleared on child exit). It keeps the existing `tree()` walk as a final sweep. Win32 keeps `taskkill /T /F`.
  - The guards are inline copies of A3's guards (pgid > 1, not the supervisor's own pgid).
  - `job.timeoutMs` starts a timer that writes the interrupt file and calls `stop()`.
  - On exit, when `job.result` is `claude-stream` or `claude-json`, parse the last non-empty line of `outFile` (JSON) into `record.result` (§1 shape). `denials` is the length of `permission_denials`.
  - An agent job's message is `'stopped'` when the result's `terminal_reason === 'aborted_streaming'`, or `'killed (no result)'` when there is no result line.
  - The signal handlers at line 82 stay.
- **Done:**
  - A stub that traps SIGINT gets SIGINT first.
  - A stub that ignores SIGINT and SIGTERM is SIGKILLed by about 20 s. Tests inject `escalateMs` through `job.escalateMs`, default 10000.
  - A command job past its `timeoutMs` ends `interrupted: true`.
  - Pipelines still stop within the old 20 s budget plus 5 s.
- **Tests:** §5 B3.
- **Depends:** B2.

### Phase C: Pipeline hardening (identity, lock, orphans)

#### C1: `start()` takes the per-slug lock and records identity
<!-- model: opus --> Reason: the lock and the parallel-cap lock nest; refusal codes must not change.
- **Goal:**
  - In [src/runs/index.ts:204-292](../../src/runs/index.ts), inside `withStartLock`, call `takeLock(<reg>/locks/<slug>.lock, identity(process.pid))` before the `isRunning` check. When it refuses, return the existing `fail(4, …already running…)`.
  - After `startSupervisor` (line 278), `setLockOwner(lock, identity(pid))` and pass `lockFile` in the job.
  - The `running` record (line 287) gains `supervisor: identity(pid)`, `v: 1` and `kind: 'pipeline'`.
  - Every refuse path after the lock was taken releases it.
  - `isRunning` ([src/runs/records.ts:85](../../src/runs/records.ts)) uses `sameProcess(rec.supervisor)` when that field is present, and `alive(rec.pid)` otherwise.
  - Add `occupied(reg, slug, rec)`: `isRunning`, or the group in `<slug>.live.json` still has members. `start()` uses `occupied` for the exit-4 check and for the cap count at line 217.
- **Done:** the exit codes 0/1/3/4/5 behave as in [test/runs.test.ts:253-277](../../test/runs.test.ts). A planted stale lock with a dead owner is broken. A live owner refuses with 4.
- **Tests:** §5 C1.
- **Depends:** A2, A4, B3.

#### C2: Identity-checked stop that reaches orphans
<!-- model: opus --> Reason: it decides whom to signal; a wrong branch kills an unrelated tree or leaves an orphan editing.
- **Goal:** replace `stopProcess` and `stopRun` in [src/runs/index.ts:294-323](../../src/runs/index.ts) with `stopSupervised({ recordFile, interruptFile, liveFile, rec })`, exported for E1. It:
  1. writes the interrupt marker;
  2. if `sameProcess(rec.supervisor)` holds (or, for a legacy record, `alive(rec.pid)`) and the heartbeat is fresh (< 45 s), sends SIGTERM to that one pid and polls the record until it is `exited` (≤ 25 s);
  3. otherwise, or on timeout, runs `escalate({ pgid: live.child.pgid, child: live.child, treeRoot: rec.pid })`;
  4. for a legacy record without a live file, runs `killTree(rec.pid)` and escalates as `stopProcess` does today;
  5. closes a record still left `running` with `interrupted: true`, as lines 309-312 do.

  `stop()` (line 317) treats "supervisor dead but group alive" as running instead of returning "not running".
- **Done:** [test/runs.test.ts:303-337](../../test/runs.test.ts) passes. A supervisor SIGKILLed alone, with its pipeline still alive, is stopped by `stop` (the new test), and no `sleep` grandchild remains.
- **Tests:** §5 C2.
- **Depends:** C1.

#### C3: Orphan classification (pure function)
<!-- model: opus --> Reason: the orphan decision logic; every branch has a data-loss or double-run consequence.
- **Goal:** add `src/runs/reconcile.ts` with `classify(input): { state: 'running' | 'hung' | 'orphaned' | 'agent-finished' | 'supervisor-lost'; message: string }`. It is a pure function of:

  ```
  supervisorAlive (sameProcess, or alive for legacy)
  heartbeatAgeMs (from live.at, else mtime; null if missing)
  groupMembers.length
  agentAlive (sameProcess({pid: agent_pid, start: agent_start}))
  agentResult (last line of agent_out: subtype, is_error, permission_denials.length)
  agentOutMtimeMs
  agentStartedMs
  ```

  It implements this table (from the notes):

  | supervisor | heartbeat | group / agent | agent output | → state |
  |---|---|---|---|---|
  | alive | fresh (< 45 s) or missing (legacy) | any | any | running |
  | alive | stale | any | any | hung |
  | dead or identity differs | n/a | members > 0 or agentAlive | any | orphaned |
  | dead | n/a | empty | `success` && !is_error && denials 0 && mtime > agentStarted | agent-finished ("agent finished, checks not run") |
  | dead | n/a | empty | anything else | supervisor-lost ("supervisor lost") |

  Also add `gather(reg, slug, rec, statusFile)`, which reads the files (and runs lsof only when asked, see A3 guard 5 in the notes) and calls `classify`.
- **Files:** new `src/runs/reconcile.ts`. Read `status.json` through `watchDir` ([src/runs/index.ts:401-412](../../src/runs/index.ts)) or `runView`'s dir logic ([src/runs/view.ts:182](../../src/runs/view.ts)).
- **Done:** every row is covered by a unit test with literal inputs. No I/O in `classify`.
- **Tests:** §5 C3.
- **Depends:** C2, D2.

#### C4: Reconcile on server start, in `start()` and in `stop()`
<!-- model: opus --> Reason: it is the lease owner that writes synthetic final records; it must never write while a supervisor lives.
- **Goal:** add `reconcile(ctx): ReconcileReport[]` to `src/runs/reconcile.ts`. For each `recordedSlugs` record with `state: 'running'`:
  - `supervisor-lost` and `agent-finished` write the final record `state: 'exited', interrupted: true, message` with tmp+rename. They first re-check `sameProcess` at the moment of writing, to close a race with a late supervisor.
  - `orphaned` and `hung` write nothing (the UI asks). Auto-kill stays off.

  Call `reconcile` from:
  - `startServer` before `triage.recover()` at [web/server/index.ts:472](../../web/server/index.ts), once per registered project;
  - `start()` before the `occupied` check;
  - `stop()`.
- **Done:** a planted record with a dead pid and a success agent output becomes `agent finished, checks not run` after `startServer`. A planted orphan (a live `sleep` in a detached group named in `live.json`) stays `running` with view state `orphaned`, and `start` refuses with exit 4.
- **Tests:** §5 C4.
- **Depends:** C3.

#### C5: Show `orphaned` and `hung` on the board and the Run page
<!-- model: sonnet --> Reason: UI wiring against a finished classifier.
- **Goal:**
  - Extend `ViewState` in [src/runs/view.ts:16](../../src/runs/view.ts) and [web/ui/src/api.ts:4](../../web/ui/src/api.ts) with `'orphaned' | 'hung'`.
  - `viewState` ([src/runs/view.ts:131-140](../../src/runs/view.ts)) maps them from `gather` (only for `running` records, cheap path, no lsof).
  - Add both to the `recovery` list at [src/runs/view.ts:263](../../src/runs/view.ts).
  - Run page ([web/ui/src/Run.tsx:700-720](../../web/ui/src/Run.tsx)): for `orphaned`, a card "agent pid N running since T, no supervisor" with **Wait** (a no-op poll) and **Kill** (`POST /runs/:slug/stop`). For `hung`, "supervisor not responding" with **Stop**.
  - The toasts and the failed count in [web/ui/src/App.tsx:120, 134](../../web/ui/src/App.tsx) do not count them as failed.
- **Done:** typecheck passes. A server test reads the board for an orphaned fixture.
- **Tests:** §5 C5.
- **Depends:** C4.

### Phase D: Agent-level safeguards in the pipeline

#### D1: A SIGINT-ended agent must not look successful
<!-- model: opus --> Reason: abort handling in `runAgent`; a missed check lets an interrupted Implement agent proceed to its gate.
- **Goal:**
  - In `runAgent` ([src/pipeline/agent.ts:171-191](../../src/pipeline/agent.ts)), call `stopIfAborted(ctx)` right after `await ctx.spawnAgent(...)` and `await tick()` (after line 177, before `usageLimit`).
  - In `spawnClaude` ([src/pipeline/agent.ts:80-94](../../src/pipeline/agent.ts)), add `killSignal: 'SIGINT'` to the spawn options ([Node 18 spawn killSignal](https://nodejs.org/docs/latest-v18.x/api/child_process.html#child_processspawncommand-args-options)), so an abort ends the turn with a recorded result.
  - Do the same in `runAudit` (line 212-235): check after its spawn returns.
  - **Judge the agent by its result line, not only its exit code.** `extract()` ([src/permissions/index.ts:138](../../src/permissions/index.ts)) already parses `<log>/<name>.json`. Have it, or a small `agentOutcome(jsonFile, harnessId)` helper next to it, also return the outcome. Then `runAgent` fails the stage when `rc !== 0` **or** the outcome is a failure.
    - For the `claude` harness, a run succeeds only on `type === 'result' && subtype === 'success' && is_error === false`.
    - Any `error_*` subtype, `is_error: true`, or an empty or unparseable file counts as a failure even with exit 0.
    - For `codex` and `agy`, keep the exit-code rule until their final-event shape is checked (V-list).
    - Usage-limit results are still caught first by `usageLimit()`.
- **Done:**
  - A stub agent that exits 0 after an abort makes the pipeline stop with `STOPPED: the run was stopped` and exit `128+n`. It does not continue to the gate.
  - A stub agent that exits 0 but writes an `error_during_execution` result, or writes nothing, fails the stage with exit 1.
  - Existing pipeline tests pass.
- **Tests:** §5 D1.
- **Depends:** A0 (independent of everything else).

#### D2: Agent identity in status.json
<!-- model: sonnet --> Reason: an additive callback and three fields.
- **Goal:**
  - `AgentRequest` ([src/pipeline/agent.ts:65-73](../../src/pipeline/agent.ts)) gains `onSpawn?: (pid: number) => void`, called right after `spawn` in `spawnClaude` (line 90) when `child.pid` is set.
  - `runAgent` passes `onSpawn: pid => { ctx.status.agentPid = pid; ctx.status.agentStart = procStart(pid); ctx.status.agentOut = at(ctx, base + '.json'); ctx.status.write(); }`, and clears the three fields after the loop.
  - `Status` and `StatusLine` ([src/pipeline/status.ts:7-45](../../src/pipeline/status.ts)) gain `agent_pid`, `agent_start` and `agent_out`, appended last so the field order of existing keys stays the same.
  - `runAudit` does the same with `test-audit`.
- **Done:** while a stub agent sleeps, status.json shows its pid and an absolute `agent_out`. After it ends, the fields are empty. Readers that ignore unknown keys are unaffected.
- **Tests:** §5 D2.
- **Depends:** A2 (for `procStart`). It can be merged with `agentStart: ''` before A2 lands if necessary.

#### D3: `pipeline --after-agent` resume
<!-- model: opus --> Reason: changes stage control flow; it must skip exactly one agent spawn and nothing else.
- **Goal:**
  - Add the flag `--after-agent` to the `pipeline` CLI ([src/cli/pipeline.ts:9-40](../../src/cli/pipeline.ts)) and `afterAgent?: boolean` to `PipelineOptions` ([src/pipeline/run.ts:37](../../src/pipeline/run.ts)).
  - At start, `runPipeline` reads the previous status.json. If `agent_out` exists, its last JSON is `success && !is_error` with 0 denials, its mtime is newer than `agent_started`, and its agent name equals `status.agent`, then it sets `ctx.afterAgent = { name: status.agent }`.
  - In `runAgent`, when `ctx.afterAgent?.name === name`, the spawn loop is skipped (`rc = 0`), `ctx.afterAgent` is cleared, and the function continues to `extract` and the exit-code checks. Every later agent runs normally.
  - `start()` passes `--after-agent` through `pipelineArgv` ([src/runs/index.ts:148-155](../../src/runs/index.ts)) when `opts.afterAgent` is set.
- **Done:** a resumed run with a planted success output for the Implement agent goes straight to the Implement gate. The stub's call log shows no Implement spawn. A planted error output reruns the agent.
- **Tests:** §5 D3.
- **Depends:** C3 (the shared result reader), D2.

#### D4: "Resume after the agent" route and button
<!-- model: sonnet --> Reason: route and UI wiring.
- **Goal:** `POST /runs/:slug/resume` accepts `{ afterAgent: true }` and calls `start(ctx, slug, { from: status.stage, afterAgent: true })` (next to the answers route at [web/server/index.ts:293-323](../../web/server/index.ts)). The recovery card for `message === 'agent finished, checks not run'` shows **Resume after the agent** next to the existing "Resume at…" picker ([web/ui/src/Run.tsx](../../web/ui/src/Run.tsx)).
- **Done:** a server test: reconcile, then the route; the pipeline stub sees `--after-agent`.
- **Tests:** §5 D4.
- **Depends:** C4, D3.

### Phase E: Generic jobs API and file tailer

#### E1: `src/runs/jobs.ts`
<!-- model: sonnet --> Reason: composes A2–A4, B3 and C2 helpers behind a specified API; no new process logic.
- **Goal:**
  - `startJob(reg, spec): { id, pid } | { busy: ProcIdentity }`:
    - claims `jobs/<id>/` with `mkdirSync(dir)` (non-recursive, so it fails if the id exists);
    - takes `spec.lockKey ? <reg>/locks/<lockKey>.lock` with `takeLock`;
    - runs `spec.before?.()` under the lock;
    - `startSupervisor({ kind, id, recordFile: job.json, interruptFile, logFile: supervisor.log, liveFile, lockFile, outFile, errFile, cwd, argv, timeoutMs, result, record })`;
    - then `setLockOwner` and writes the `running` record with `supervisor: identity(pid)`.
  - `readJob(reg, id)`, and `listJobs(reg, { kind?, root? })`, which adds `heartbeatAgeMs` and `state` from `classify`.
  - `stopJob(reg, id)` through C2's `stopSupervised`.
  - `pruneJobs(reg, { keep: 50, maxAgeDays: 7, kind: 'command' })`, which never prunes a running or occupied job.
  - Export from `src/index.ts`.
- **Done:** jobs start, list, stop and prune with stub argv. No job appears in `recordedSlugs`, `boardView().runs` or the `maxParallel` count.
- **Tests:** §5 E1.
- **Depends:** B3, C2.

#### E2: Byte-offset file tailer and SSE helper
<!-- model: sonnet --> Reason: a well-specified poller; no process logic.
- **Goal:** add `web/server/tail.ts`:
  - `serveTail(req, res, file, { from, isDone: () => DoneInfo | null, mapLine?: (line, offset) => {event, data} | null, pollMs = 500, capBytes = 262144, pingMs = 15000 })`.
  - SSE headers as at [web/server/index.ts:383](../../web/server/index.ts).
  - The start offset comes from the `Last-Event-ID` header, else `?from=`, else 0.
  - Each tick: `fstat`; on `size < offset`, reset to 0; read `[offset, min(size, offset + cap))`, prepend the partial line, emit each complete line with `id: <offset after line>`, keep the trailing partial.
  - When `isDone()` returns a value and `offset === size`: emit `event: done`, end, clear timers.
  - On `req.on('close')`, stop. Polling instead of `fs.watch` avoids its platform caveats ([Node 18 fs.watch caveats](https://nodejs.org/docs/latest-v18.x/api/fs.html#caveats)). Resuming from `Last-Event-ID` is standard SSE ([WHATWG SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)).
  - Also `lineIdTail` for `events.jsonl`, where the id is the line index (triage replay without duplicates).
- **Done:** unit tests over a real temp file pass. There are no server routes yet.
- **Tests:** §5 E2.
- **Depends:** A0.

### Phase F: Palette on command jobs

#### F1: Server: palette commands become command jobs
<!-- model: sonnet --> Reason: routes, validation and a refusal table, specified below.
- **Decision (user, 2026-11-04):** `pipeline <slug>` stays allowed in the palette. It runs as an ordinary command job in the main checkout, with no worktree and no run record, and that is the user's responsibility. Do not refuse it or redirect it.
- **Goal:** replace `runCommand` and the route at [web/server/index.ts:143-155, 229-232](../../web/server/index.ts), and drop `COMMAND_TIMEOUT_MS` at line 68.
  - **Refuse with 400 and a pointer:**
    - `ui`;
    - `watch … --follow`;
    - `triage` (dashboard triage screen);
    - `triage-run`;
    - `testcheck`;
    - `changes snapshot|mirror|changed|mark`;
    - `permissions extract|args|mode|decide`.

    The classification comes from the notes' table ([src/cli/main.ts:37](../../src/cli/main.ts) and the command groups it lists).
  - **Everything else:** `startJob(reg, { kind: 'command', argv: [...cli, ...args], cwd: p.path, env, root: p.path, timeoutMs: 120000, outFile: stdout.log, errFile: stderr.log })`.
  - **Answer:**
    - wait up to 3 s, polling `readJob` every 100 ms;
    - if the job exited, answer `200 { code, stdout, stderr, timedOut: interrupted && message === 'timeout', jobId }`, with up to 1 MB of each file read;
    - otherwise answer `202 { jobId }`.
  - **New routes:**
    - `GET /jobs?kind=command` (`listJobs` filtered by `root`);
    - `GET /jobs/:id`;
    - `GET /jobs/:id/events` (`serveTail` on stdout.log; `done` carries `{code, interrupted, message}`);
    - `POST /jobs/:id/stop`.
  - **On server start:** `pruneJobs`.
  - `ServerOptions.cli` stays injectable ([web/server/index.ts:28-29, 87](../../web/server/index.ts)).
- **Done:** the existing palette test at [web/test/server.test.ts:246-250](../../web/test/server.test.ts) passes unchanged (a fast job returns 200 in the old shape), and the new tests pass.
- **Tests:** §5 F1.
- **Depends:** E1, E2.

#### F2: UI: palette streams, stops and reattaches
<!-- model: sonnet --> Reason: UI wiring.
- **Goal:**
  - In `Palette` ([web/ui/src/App.tsx:25-60](../../web/ui/src/App.tsx)), a 202 opens `new EventSource(…/jobs/<id>/events)` and appends lines to the `<pre>`. Add a **Stop** button (`POST /jobs/:id/stop`), and a "Recent" list from `GET /jobs?kind=command` (state, `cliLine` from [web/ui/src/api.ts:226-227](../../web/ui/src/api.ts), View, Stop).
  - Reopening the palette while a job runs reattaches with EventSource reconnect from offset 0.
  - Change the help text at line 48: commands now run detached, with a 2-minute limit, and survive closing the dialog or restarting the server.
  - Add `api.jobs`, `api.job`, `api.stopJob` and `jobEvents(id)` to [web/ui/src/api.ts:194](../../web/ui/src/api.ts).
- **Done:** typecheck passes, and a manual check through the `run` skill (palette `doctor --run-tests` streams, then Stop).
- **Tests:** §5 F2.
- **Depends:** F1.

### Phase G: Triage on a supervised driver

#### G1: Triage driver core (library, injectable spawn)
<!-- model: opus --> Reason: a port of the whole phase machine with exit-code semantics; the largest and subtlest move.
- **Goal:** add `src/triage/driver.ts` with `driveTriage(runDir, { spawn?: AgentSpawn, env, claude, signal }): Promise<0 | 1 | 2 | 130>`. It moves the logic of [web/server/triage.ts:182-368](../../web/server/triage.ts) (`fail`, `runSession`, `startSplit`, `startItem`, `afterSplit`, `afterItem`, `nextItem`) out of the server and replaces in-memory state with files:
  - Read `run.json`. Before each turn, write `current`, `pid = agent pid`, `state: 'running'`.
  - Each turn spawns `claude` with exactly the argv at [web/server/triage.ts:206-209](../../web/server/triage.ts), with these changes:
    - a scope's first turn starts with no session flag. The id is captured from the output as soon as it appears (G0's `sessionIdOf`), and saved into `sessions`;
    - later turns in the same scope use G0's `compileResumeArgs` (`-r <id>` for claude);
    - stdout goes to `turns/<n>-<phase>[-<slug>].ndjson`, stderr to `.err`.
  - **Events.** Read the NDJSON as it is written (a 250 ms poll of the file) through `parseStreamLine` ([src/triage.ts:235-255](../../src/triage.ts)) and append `text` and `tool` events to `events.jsonl` (the driver is the only writer).
  - **Success test.** The last line is a `result` with `subtype === 'success' && !is_error`. Exit code 0 alone is not enough (§3).
  - **Gates.**
    - **No `choosing` gate (user decision).** After the split, the driver appends the "Which items should go into the backlog?" options question to `questions.md` (see §1 "Triage as an asynchronous, file-driven conversation", step 6), then handles it like any other question.
    - Pending questions write `waiting`, a `question` event, and return 2. When `run.autoAccept` is set, they are auto-accepted with `autoAcceptQuestions` ([src/pipeline/stages.ts:85-95](../../src/pipeline/stages.ts)), up to 5 rounds, and the run continues with `triageAnsweredMessage`.
    - No item left: `ready` or `done`, `done{0}`, return 0.
    - A failure writes `failed`, `error`, `done{code}`, and returns 1.
  - **Abort** (signal) gives state `stopped`, `done{130}`, return 130.
  - Marks are read from `marks.json` and never written.
  - The driver never removes the worktree.
  - **Context file.** Add to every triage prompt (`assets/prompts/triage-*.md`) the instruction to keep `<runDir>/context.md` (requirement, brainstorm, decisions, progress) up to date before ending a turn.
  - **Session fallback.** Implement `resumeOrRehydrate(turn)` as described in §1: detect failed-to-resume, start one new session with the rehydrate prompt, record `rehydrated` and the `session-restarted` event.
- **Done:** unit tests drive split, gate, item, question and answer through an injected spawn that writes NDJSON. The server is untouched in this PR.
- **Tests:** §5 G1.
- **Depends:** A0 (independent).

#### G0: Harness session API (capture and resume)
<!-- model: sonnet --> Reason: three small, table-driven harness methods with stub tests; the flags are given in §1.
- **Goal:** extend `AgentHarness` ([src/pipeline/harness/types.ts:82-102](../../src/pipeline/harness/types.ts)) with:
  - `sessionIdOf(stdoutSoFar: string): string | null`. Claude reads `session_id` from the `init` line or result. agy reads `conversation_id`. Codex reads `thread_id` from `thread.started`.
  - `compileResumeArgs(opts: StageCompileOptions & { sessionId: string }): HarnessInvocation`, using the per-harness resume command from the §1 table, including codex's `-c sandbox_mode=` and `cwd` caveat.
  - `HarnessResult.sessionId`.
  - Implement all three in `claude.ts`, `agy.ts` and `codex.ts`. `declarative.ts` gets optional manifest fields `sessionIdField` and `resumeFlag`; with neither set, resume is unsupported and the caller rehydrates.
- **Done:** for each harness, a recorded sample output yields the id, and resume argv matches the table.
- **Tests:** §5 G0.
- **Depends:** A0 (independent).

#### P1: Pipeline stages resume their own session within the stage
<!-- model: opus --> Reason: touches the stage loop and abort/resume semantics; must never leak a session across stages.
- **Goal:** in `runAgent` ([src/pipeline/agent.ts:124-209](../../src/pipeline/agent.ts)):
  - Save `status.sessions[stage]` from `sessionIdOf` while the agent runs.
  - When a stage is re-entered for its own answers or a decided permission (the exit-2 resume paths in [src/pipeline/stages.ts:118-172](../../src/pipeline/stages.ts) and [agent.ts:197-203](../../src/pipeline/agent.ts)), use `compileResumeArgs` with that id and a prompt holding the answers plus `decisions.md`.
  - Any other stage start clears `sessions[stage]` and runs fresh.
  - On a failed resume, rehydrate once with the stage's normal prompt plus the answers.
- **Done:** see the tests. The pipeline's behaviour for runs that never pause is unchanged.
- **Tests:** §5 P1.
- **Depends:** G0, D1.

#### G1b: Options questions in the shared questions parser
<!-- model: sonnet --> Reason: a small, well-specified parser and format extension with clear tests.
- **Goal:** extend `parseQuestions` and `answerQuestions` (the shared helpers the pipeline and triage use; see [src/runs/view.ts:75-101](../../src/runs/view.ts)) with an optional `**Options:** (single|multi)` block of `- [ ]` / `- [x]` lines.
  - Parse it into `{ options: [{ id, label, checked }], multi }`.
  - Write a choice back as checked boxes plus an `**Answer:**` of the chosen ids, one per line.
  - Questions without options must parse and write exactly as today.
  - In the UI, `Run.tsx` and the triage drawer render options as checkboxes or radio buttons, with the suggested choice pre-ticked.
- **Done:** a pipeline `questions.md` with no options round-trips byte for byte. A multi-options question round-trips with the user's ticks.
- **Tests:** §5 G1b.
- **Depends:** A0 (independent; G1 uses it).

#### G2: Server routes write files and start driver jobs
<!-- model: opus --> Reason: one-writer rules between server and driver, stop/discard against a detached process, restart semantics.
- **Goal:** rewrite `triageRoutes` in [web/server/triage.ts:135-590](../../web/server/triage.ts) on top of G1, E1 and E2:
  - Add the hidden command `triage-run <runDir>`: add it to `TRIAGE_COMMANDS` at [src/cli/triage.ts:10](../../src/cli/triage.ts), without listing it in the usage text. It installs SIGINT/SIGTERM → abort, as [src/cli/pipeline.ts:31-37](../../src/cli/pipeline.ts) does.
  - `kick(run, before?)` = `startJob(reg, { kind: 'triage', id: 't-<runId>-<n>', lockKey: 'triage-<runId>', argv: [...nodeCli, 'triage-run', runDir], cwd: worktree, outFile: <runDir>/driver.out, root, env: { ...host.env, AI_SDLC_HELPER_TRIAGE_CLAUDE: host.claude }, before })`. `run.job = { id }` is written inside `before`.
  - **Route changes:**
    - `POST /` (start, lines 390-429) creates the worktree and run dir as today, calls `kick`, then serves `lineIdTail(events.jsonl)` on the POST response.
    - `items`, `answer` and `resume` (lines 469-498, 528-544) write their file changes inside `before`. A busy lock returns 409. They reply right after the spawn (drop `START_WAIT_MS`, line 61).
    - `saved` and `skip` (lines 501-514) write `marks.json` only.
    - When every draft is marked and no driver is occupied, the server runs `finishDone` (line 191-201).
    - `stop` (516-526) calls `stopJob`, then writes `stopped` and `done{130}` only if the driver died without writing them.
    - `discard` (546-555) awaits `stopJob`, then removes the worktree, branch and pointer.
    - `GET /events` (430-442) uses `lineIdTail` with `Last-Event-ID`.
  - `close()` (576-587) only ends the SSE responses. It no longer kills or marks anything.
  - `recover()` (561-573), for each pointer with `run.job`:
    - running: leave it;
    - exited with state `done`, or `ready` with everything marked: `finishDone`;
    - supervisor lost while the state is still `running`: `interrupted`;
    - orphaned: leave it, and the UI shows the state.
  - Update the stub launcher. The driver resolves `claude` from `AI_SDLC_HELPER_TRIAGE_CLAUDE`, so the tests' `claude: stub` option keeps working ([web/test/triage.test.ts:73-77](../../web/test/triage.test.ts)).
- **Done:** all of [web/test/triage.test.ts](../../web/test/triage.test.ts) passes, with the adjustments listed in §5 G2, plus the new detached tests.
- **Tests:** §5 G2.
- **Depends:** G0, G1, G1b, E1, E2, A1.
- **No `items` gate route.** The `items` route (pick items) becomes the generic answer route writing the options answer; remove the `choosing` state from the server and UI.

#### G3: UI follow-ups for detached triage
<!-- model: sonnet --> Reason: small UI wiring.
- **Goal:**
  - In `TriageDrawer` ([web/ui/src/NewItem.tsx:46-200](../../web/ui/src/NewItem.tsx)), reconnecting after a network error re-requests `GET /triage/events` with the last id seen. The `stream()` parser at [web/ui/src/api.ts:121-146](../../web/ui/src/api.ts) also captures `id:` lines.
  - Add an "auto-accept suggested answers" checkbox at start, sent as `autoAccept`.
  - Show `orphaned` with Stop.
  - Make the Run settings label "Auto-accept suggested answers (Spec, Plan, Triage)" ([web/ui/src/Run.tsx:424, 841](../../web/ui/src/Run.tsx)) true by passing it through.
- **Done:** typecheck passes, and a manual check of the drawer through the `run` skill.
- **Tests:** §5 G3.
- **Depends:** G2.

#### G4: Refused actions as a triage gate (optional)
<!-- model: sonnet --> Reason: reuses `decide` and `permissions.json` from the pipeline; specified shape.
- **Goal:** when a turn's `result.permission_denials.length > 0`, the driver writes `<runDir>/permissions.json` in the pipeline's format ([src/permissions/index.ts:133-145](../../src/permissions/index.ts)), sets state `waiting` with a `refused` event, and returns 2. Add `POST /triage/permissions` mirroring [web/server/index.ts:307-323](../../web/server/index.ts).
- **Done:** a stub whose result has denials pauses the run, and deciding resumes it.
- **Tests:** §5 G4.
- **Depends:** G2.

### Phase H: Close-out

#### H1: Docs and Windows note
<!-- model: sonnet --> Reason: docs only.
- **Goal:**
  - Update `docs/PLAN.md` "Still open" (Windows: no group, no identity, `taskkill` stop) and `docs/web-ui.md` (palette jobs, triage survives restart).
  - Remove the `A0` pointer line or mark it done.
  - Update the `ui` banner text at [src/cli/ui.ts](../../src/cli/ui.ts) to "runs, triage and palette jobs go on without it".
- **Done:** docs merged, and `npm run check` is green.
- **Depends:** all.

---

## 3. Things to be careful about

**Pipeline behaviour must stay identical.** The paths, the record fields that already exist, the exit codes 0/1/2/3/4/5/6, and the `run.out` and `wrapper.log` contents stay the same. The only additions are the optional sweep line and the new optional fields (B1, B2, C1). `finalState` ([src/pipeline/status.ts:59-60](../../src/pipeline/status.ts)) and the record-to-view mapping ([src/runs/view.ts:131-140](../../src/runs/view.ts)) must not change for existing states. `isRunning` keeps its legacy path for records without `supervisor`, so runs started before the upgrade can still be stopped (C2 falls back to `killTree`).

**Group SIGINT reaches the pipeline and the agent at once.** The pipeline already treats SIGINT like SIGTERM and aborts its controller ([src/cli/pipeline.ts:31-37](../../src/cli/pipeline.ts)). Without D1's `killSignal: 'SIGINT'`, that abort SIGTERMs the agent (Node's default), and the agent records no result. Both D1 changes must land before B3 ships SIGINT-first. B3 depends on D1 in practice. Do not merge B3 before D1.

**A SIGINTed `claude -p` exits 0 with an error result.** The local experiment on Claude Code 2.1.318 gave exit **0** with `subtype: error_during_execution`, `terminal_reason: aborted_streaming`. SIGTERM gave exit **143** with no result line ([Claude Code headless](https://code.claude.com/docs/en/headless) documents the SIGTERM side, "To end the turn instead, send SIGINT"; the V5 command reproduces it). The exit code alone never means success. The pipeline needs `stopIfAborted` after the spawn (D1). Triage and agent jobs judge success by `result.subtype === 'success' && !result.is_error` (B3, G1). `is_error` can be true even on `success` ([Agent SDK result message](https://code.claude.com/docs/en/agent-sdk/typescript)).

**One writer per file.** The supervisor is the only writer of `live.json`. The starter writes the running record and the supervisor the final one, with the pid handshake. The pipeline is the only writer of `status.json`. Triage's `run.json` and `events.jsonl` are written by the lock holder only: the driver while it runs, the server inside `startJob`'s `before` or at a gate where it holds the lock. `marks.json` is written only by the server. Never read-modify-write `run.json` from the server while a driver lives. Today's `saved`/`skip` handlers do exactly that ([web/server/triage.ts:501-514](../../web/server/triage.ts)), and quick-mode drafts arrive while the next item's agent is running.

**triage.json is currently listed as a run.** `triage` matches `SLUG` and the pointer sits in the registry root, so `recordedSlugs` returns it ([src/runs/records.ts:64-68](../../src/runs/records.ts); [web/server/triage.ts:68](../../web/server/triage.ts)). A1 fixes this. Never put any new per-run `*.json` in the registry root (`triage-<runId>.json` would match too).

**Never derive a pgid from a supervisor pid.** The pgid comes only from `live.json.child.pgid`, written by the supervisor that spawned the child with `detached: true`. Group kills are refused for `pgid <= 1` and for the caller's own pgid. `killTree`'s guard stays, because refused-start records carry `pid: 0` ([src/runs/index.ts:211](../../src/runs/index.ts)).

**Never break a lock on mtime.** The per-job lock is broken only when `sameProcess(owner)` is false. `.start.lock` keeps its 30 s mtime rule because it is held only for milliseconds ([src/runs/index.ts:128-141](../../src/runs/index.ts)).

**Capture session ids from the agent's output, as early as possible.** Today `run.sessions.items[slug]` is learned from the first stream line ([web/server/triage.ts:221-229](../../web/server/triage.ts)). Keep that: save it the moment the first line arrives. A death before the first line means no session existed, and the rehydrate path covers it. Resume within a scope only. Never use `--continue`, which picks "the most recent" session and is ambiguous with parallel jobs ([Claude Code headless](https://code.claude.com/docs/en/headless)). stream-json in print mode requires `--verbose`: without it, CLI 2.1.318 refuses to start (local experiment E1).

**Node 18 only.** CI runs Node 18, 20, 22 and 24 ([.github/workflows/ci.yml:14](../../.github/workflows/ci.yml)). Everything used is in Node 18: `spawn({detached, killSignal})`, `process.kill(-pgid)`, `openSync('wx')`, `crypto.randomUUID`, `setInterval().unref()`, `Atomics.wait`. Do not use `fs.watch` recursion, `AbortSignal.timeout` arrays, or `os.availableParallelism` without a fallback. The supervisor `SOURCE` stays plain CommonJS for `node -e` and cannot import TS helpers, so B2 and B3 inline small `ps` calls.

**Windows.** It has no process groups and no POSIX signals. `ownGroup` is false, the child is not detached (on Windows, detached means a new console window), identity checks fall back to `alive`, and stop stays `taskkill /T /F` ([src/runs/supervisor.ts:78](../../src/runs/supervisor.ts)). The heartbeat works. Nothing here is tested on Windows ([docs/PLAN.md:88-91](../../docs/PLAN.md)).

**Test timing.** The detached driver makes the agent start after the route returns. Tests that read `calls().at(-1)` right after `POST resume` ([web/test/triage.test.ts:458-476](../../web/test/triage.test.ts)) must `until(() => calls().length === n)`. Avoid fixed sleeps. The user's memory notes a flaky triage test racing a fixed 1,500 ms sleep, and slow-suite problems.

**Stage names.** Say Spec, Plan, Red tests, Implement, Test repair, Review, Finalise in code comments, prompts, UI text and PRs. Never say "stage 4".

---

## 4. Things to be verified before or while building

| # | Question | Quick check | Blocks |
|---|---|---|---|
| V1 | Does the board show a phantom `triage` card today? | In a scratch repo: `mkdir -p "$(git rev-parse --git-common-dir)/sdlc-runs" && echo '{}' > "$(git rev-parse --git-common-dir)/sdlc-runs/triage.json" && node /Volumes/Work/Projects/trials/ai-sdlc-helper/dist/bin.js status` (look for a `triage` line), then open the board with `ui`. | A1 (describe the finding in the PR) |
| V2 | Does stream-json flush line by line when stdout is a file? | `claude -p "run the shell command sleep 6, then say hi" --output-format stream-json --verbose --allowedTools 'Bash(sleep:*)' > /tmp/f.ndjson & for i in $(seq 1 16); do sleep 0.5; wc -l < /tmp/f.ndjson; done` (the count should rise before the end) | G1 (live progress), E2 |
| V3 | Does `claude` put its Bash tool commands in a new process group or session? | Start `claude -p "run sleep 60" --allowedTools 'Bash(sleep:*)' --output-format json &`, then `ps -A -o pid,ppid,pgid,sess,command \| grep -E 'claude\|sleep 60'`, and compare the pgids. If they differ, B3's final `processTree` sweep becomes essential, and claude's own SIGINT cleanup is relied on. | A3, B3 |
| V4 | Is `LC_ALL=C ps -o lstart=` stable on Linux CI? | Add a temporary CI step, or run `docker run --rm node:18 sh -c 'apt-get -qq update >/dev/null && apt-get -qq install -y procps >/dev/null; sleep 5 & LC_ALL=C ps -o lstart= -p $!'`. Expect `Wed Nov  4 14:25:00 2026`. Note that `node:18-slim` has no `ps`, and decide what happens there: `procStart` returns `''`, so the code falls back to `alive`. | A2 |
| V5 | Does SIGINT still exit 0 with an `error_during_execution` result on the installed CLI version? | `claude -p 'Run the Bash command: sleep 60' --allowedTools Bash --output-format stream-json --verbose </dev/null > /tmp/sig.ndjson & P=$!; sleep 15; kill -INT $P; wait $P; echo rc=$?; tail -1 /tmp/sig.ndjson \| jq '{subtype,is_error,terminal_reason}'` (repeat with `-TERM`). The code must be correct whatever the exit code is. | D1, B3 |
| V6 | ~~`--session-id` behaviour~~ No longer needed: ids are captured from the agent's output, not preassigned. | none | none |
| V7 | Does the UI's triage stream rely on a full replay? | `grep -n "stream(\|triageEvents\|events?runId" /Volumes/Work/Projects/trials/ai-sdlc-helper/web/ui/src/*.ts*`, then read `TriageDrawer`'s reducer for reset-on-reconnect. | G2, G3 |
| V8 | Do server tests assert on `close()` killing triage? | `grep -n "close\|kill" /Volumes/Work/Projects/trials/ai-sdlc-helper/web/test/server.test.ts /Volumes/Work/Projects/trials/ai-sdlc-helper/web/test/triage.test.ts \| grep -v afterEach` | G2 |
| V9 | Does a detached child under `AI_SDLC_HELPER_PIPELINE_CMD` keep every grandchild in the group? | After B2: start a run with `AI_SDLC_HELPER_PIPELINE_CMD='sh -c "sleep 30 & sleep 30"'`, then `ps -A -o pid,pgid,command \| grep 'sleep 30'`. Every pgid should equal `live.json.child.pgid`. | B2 |
| V10 | Can the e2e/server fixture host a slow stand-in job within the suite budget? | `npx vitest run web/test/server.test.ts > /tmp/sdlc-server.log 2>&1; echo exit=$?; grep -E "Duration\|✓\|×" /tmp/sdlc-server.log \| tail -5`, before and after F1 | F1 |
| V11 | Is `kern.boottime` stable across the process lifetime, and parseable? | `sysctl -n kern.boottime; sleep 2; sysctl -n kern.boottime` (the two should be identical) | A2 |
| V12 | ~~Does the `choosing` gate stay?~~ **Decided 2026-11-04: no.** Item picking is an options question in `questions.md`. | none | G1, G1b |
| V15 | Do agy's `.conversation_id` and codex's `thread.started` match the installed versions, and does resuming keep the same id? | `agy -p hi --output-format json </dev/null \| jq .conversation_id`; `codex exec --json hi </dev/null \| head -1`; then resume each once and compare the ids | G0 |
| V14 | Does `--resume` work after the triage worktree path changes, and what exactly does an unknown id print on the installed CLI? | Checked on 2.1.318: resuming from another folder worked; an unknown id gives exit 1 and `No conversation found with session ID: <id>`. Recheck on upgrades: `claude -p hi --resume 00000000-0000-4000-8000-000000000000 --output-format json </dev/null; echo $?` | G1 |
| V13 | Linux: does `ui` running under a systemd unit kill the detached supervisors on unit stop (`KillMode=control-group`)? | `systemd-run --user --unit=sdlc-ui-test node dist/bin.js ui &`, start a run, `systemctl --user stop sdlc-ui-test`, then `ps` for the supervisor. Document the result and do not fix it here. | H1 |

---

## 5. Things that need testing

All tests exercise real code by importing it or through `run()` in [test/helpers.ts](../../test/helpers.ts) or `startServer`. They use stand-in programs written to temp dirs (`tmp()`, `pathWith()`, `project()`), never assert on Markdown or comments, and avoid fixed sleeps (poll with an `until` helper, as the triage tests do). Keep each new test under 5 s by injecting short escalation and heartbeat intervals (`job.escalateMs`, `job.heartbeatMs`, `SDLC_HEARTBEAT_STALE_MS`).

**A1** (`test/runs.test.ts`, `web/test/triage.test.ts`)
- `recordedSlugs` ignores a planted `triage.json`.
- `statusLines` and `boardView().runs` have no `triage` entry while a pointer exists.
- A legacy `sdlc-runs/triage.json` pointer is read, rewritten to `triage/pointers.json` and deleted.
- The "server restart" tests plant the new path.

**A2** (new `test/proc.test.ts`)
- `procStart(process.pid)` is non-empty and stable across two calls.
- `sameProcess(identity(childPid))` is true for a live `sleep`, false after it exits, and false with a tampered `start`.
- `groupMembers(pgid)` lists both children of `spawn('sh', ['-c', 'sleep 30 & sleep 30'], { detached: true })`.
- `ownPgid()` equals the value from `ps -o pgid= -p <pid>`.
- Win32 is simulated through an injected platform: `procStart` returns `''`, and `sameProcess` falls back to `alive`.

**A3** (`test/proc.test.ts`)
- `killGroup` returns false and signals nothing for 0, 1, -5, `ownPgid()`, and an identity mismatch on an empty group.
- `killGroup(pgid, 'SIGTERM')` removes the detached `sh` and both `sleep`s within 1 s. This is the notes' experiment E3, turned into a test.
- `escalate` with `waitMs: 200` on a stub that traps SIGINT and SIGTERM (`trap '' INT TERM; sleep 30`) ends by SIGKILL. The test asserts the order of signals the stub logged (`trap 'echo INT >> log' INT`).
- The legacy fallback calls `killTree` when there is no pgid.

**A4** (new `test/lock.test.ts`)
- Two `takeLock` calls: the second refuses with the first's owner.
- A lock owned by a dead pid is broken and renamed to `.stale.*`.
- A lock owned by a live pid with a different `start` (reused pid) is broken.
- `releaseLock` by a non-owner leaves the file.
- A half-written (empty) lock younger than 2 s refuses.

**B1** (`test/runs.test.ts`)
- The existing suite passes unchanged.
- `startSupervisor` with `setup` omitted and `kind: 'command'` runs `argv` and writes a final record containing the job fields (`id`, `argv`) and `exit_code`.

**B2** (`test/runs.test.ts`)
- During a `slow-one` stub run, `<slug>.live.json` has an increasing `seq` (heartbeat injected at 100 ms) and a `child.pgid === child.pid`.
- `ps` shows the pipeline stub's pgid differing from the supervisor's.
- After the run ends, `live.json` and the lock are gone.
- A stub that backgrounds `sleep 30 &` and exits leaves no `sleep` behind, and `wrapper.log` contains `swept 1 leftover process(es)`.

**B3** (`test/runs.test.ts`)
- SIGTERM to the supervisor of a stub that logs signals shows the stub received INT first. The record is `interrupted: true`.
- A stub ignoring INT and TERM is gone after about `2 × escalateMs`.
- `timeoutMs: 300` on `sleep 30` ends `interrupted: true` with message `timeout`.
- `result: 'claude-stream'` with a stub printing the E2 SIGINT result line produces `record.result.subtype === 'error_during_execution'` and message `stopped`.
- A stub killed with no result line produces `killed (no result)`.

**C1** (`test/runs.test.ts`)
- Existing exit-code test [253-277](../../test/runs.test.ts) passes.
- A planted `locks/alpha.lock` with a live foreign owner makes `start alpha` exit 4. A dead owner's lock is broken, and the start succeeds.
- The running record carries `supervisor.start`.
- A record whose `pid` belongs to an unrelated live process but whose `supervisor.start` differs is not running (PID reuse). The test uses `process.pid` with a fake start.

**C2** (`test/runs.test.ts`)
- **New**: SIGKILL only the supervisor of a `slow-one` run. Then `stop` returns 0, the pipeline stub and its `sleep` are gone (checked with `ps`), and the record is `interrupted`.
- The legacy record without live.json still stops (existing [303-328](../../test/runs.test.ts)).
- Stop refuses to signal when `supervisor.start` mismatches and the group is empty.

**C3** (new `test/reconcile.test.ts`)
- One test per decision-table row with literal inputs.
- Edge cases:
  - a stale heartbeat while the supervisor is alive gives `hung`;
  - a success output with mtime older than `agent_started` gives `supervisor-lost`;
  - a success with denials > 0 gives `supervisor-lost`;
  - a missing heartbeat on a legacy record with the supervisor alive gives `running`.

**C4** (`test/reconcile.test.ts`, `web/test/server.test.ts`)
- A planted running record (dead pid) plus a status.json whose `agent_out` holds `{"type":"result","subtype":"success","is_error":false,"permission_denials":[]}`, run through `reconcile`, becomes exited and interrupted with message `agent finished, checks not run`.
- Without the output, the message is `supervisor lost`.
- A planted orphan (a detached `sleep` whose pgid is in live.json, with a dead supervisor pid) stays `running`, and `start` exits 4.
- `startServer` runs reconcile, and `GET /board` shows `orphaned`.
- A late supervisor still alive at write time is not overwritten. The test injects a `sameProcess` that turns true.

**C5** (`web/test/server.test.ts`)
- The board JSON for an orphaned fixture has `state: 'orphaned'` and `recovery: true`.
- A hung fixture (live supervisor, live.json `at` 1 h old) gives `hung`.

**D1** (`test/pipeline-agents.test.ts`)
- An injected `spawnAgent` that aborts the controller and resolves 0: the pipeline returns the stop code, writes `STOPPED: the run was stopped`, and the gate's runner was never invoked (a counter on a stub runner).
- A real `spawnClaude` with a stub script that traps INT and exits 0, aborted through the signal: the stub logs `INT`, not `TERM`.
- Without an abort, a stub that exits 0 and writes `{"type":"result","subtype":"error_during_execution","is_error":true}` fails the stage. A stub that exits 0 with an empty `.json` fails it too. One that writes a `success` result with `is_error:false` passes. A `codex`-harness stub that exits 0 with JSONL output still passes, since codex keeps the exit-code rule.

**D2** (`test/pipeline-agents.test.ts`)
- While a stub agent waits on a file, status.json has `agent_pid` (alive), `agent_start` non-empty, and `agent_out` ending in `<name>.json`.
- After the stub finishes, all three are empty.
- The existing status field order for old keys is unchanged. The test compares the `Object.keys` prefix.

**D3** (`test/pipeline-resume.test.ts`)
- With a planted status.json (`stage: implement`, `agent: implement`, `agent_out` holding a success result newer than `agent_started`), `pipeline <slug> --from implement --after-agent` runs zero Implement spawns and invokes the Implement gate.
- With an error result, it runs the agent.
- Later agents (Review) still spawn.

**D4** (`web/test/server.test.ts`)
- `POST /runs/:slug/resume {afterAgent: true}` starts the pipeline stub with `--after-agent` (read from the `ran.txt` args, as in the [test/runs.test.ts:23](../../test/runs.test.ts) stub pattern).

**E1** (new `test/jobs.test.ts`)
- `startJob` returns at once. `job.json` is `running` with `supervisor`, and `stdout.log` fills.
- Two `startJob` calls with the same `lockKey`: the second returns `busy`.
- `stopJob` ends the job `interrupted`.
- `listJobs` filters by kind and root.
- `pruneJobs` keeps running jobs and the newest 50.
- `recordedSlugs`, `statusLines` and the `maxParallel` count ignore jobs.

**E2** (new `web/test/tail.test.ts`)
- Lines appended in three writes, the middle one split mid-line, arrive whole with increasing `id`.
- Reconnecting with `Last-Event-ID: <id>` resumes after that line.
- Truncation resets to 0.
- `isDone` plus EOF emits `done` and ends.
- The cap of 256 KB per tick spreads a 1 MB file over several ticks.
- `lineIdTail` skips the first k lines on reconnect.

**F1** (`web/test/server.test.ts`)
- The existing palette test at [246-250](../../web/test/server.test.ts) still returns 200 `{code:3, stdout:'status --json\n', timedOut:false}`.
- `cli: ['/bin/sh','-c','echo start; sleep 30','sh']` gives 202 `{jobId}`. Then `GET /jobs/:id/events` streams `start`, and `POST /jobs/:id/stop` ends it with `interrupted`.
- A second `startServer` on the same repo lists the still-running job (reattach).
- Refusals return 400 with the pointer text for `ui`, `watch x --follow`, `triage`, `triage-run`, `testcheck`, `changes snapshot` and `permissions extract`.
- `pipeline x` is not refused: it starts a command job (the user's responsibility, per the 2026-11-04 decision).
- A `timeoutMs` override of 300 ms through an option gives `timedOut: true`.

**F2**: no UI unit tests exist in `web/ui/src`. Typecheck, plus a manual check through the `run` skill, is the gate. Do not add Markdown assertions.

**G1** (new `test/triage-driver.test.ts`)
- An injected spawn writes NDJSON lines and files according to a scenario, mirroring the STUB at [web/test/triage.test.ts:18-53](../../web/test/triage.test.ts):
  - **split**: returns 2 with state `waiting` and the item-choice options question;
  - **quick**: returns 0 with drafts `pending` and state `ready`;
  - **questions**: return 2 with state `waiting`, and the `question` event is in `events.jsonl`.
- `autoAccept` answers with the Suggested text and continues with `--resume`.
- The first turn's argv has no session flag. `sessions` holds the id from the stub's first output line before the turn ends.
- An item turn never gets the split's id, and two items never share one.
- An exit-0 turn whose last line is `error_during_execution` gives `failed`. An abort gives `stopped` with `done{130}` and returns 130.
- `marks.json` is read and never written.
- **No choosing gate:** after a split with two items, `questions.md` ends with the options question listing both, the state is `waiting`, and the exit is 2. Answering with one slug runs exactly one item turn, and the other slug is marked `skipped`.
- **Resume is the same session:** the answer turn's argv has `--resume <split uuid>`, and the result's `session_id` equals it.
- **Rehydrate:** a stub that, on `--resume`, exits 1 with `No conversation found with session ID: x` on stderr. The driver makes exactly one more spawn, with no session flag and a prompt containing the `context.md` text and the answers. `sessions.split` is the new id, `rehydrated` is 1, and `events.jsonl` has `session-restarted`.
- **No rehydrate loop:** a stub that fails both the resume and the fresh session makes the run end `failed` after two spawns.
- **Answer later:** after `waiting`, no process with the worktree as cwd is alive. Answering after a `boot()` of a new server resumes correctly.

**G0** (`test/harness.test.ts` or the existing harness tests)
- Claude: from a stream-json sample, the `init` line gives the id. From a `--output-format json` sample, the result gives it. The resume argv contains `-r <id>`.
- agy: `{"conversation_id":"c1",…}` gives `c1`. The resume argv contains `--conversation c1`.
- Codex: a first line `{"type":"thread.started","thread_id":"t1"}` gives `t1`. The resume argv starts `exec resume t1` with `--json`, and has no `-C` or `-s`.
- A declarative harness without `resumeFlag` reports that resume is unsupported.

**P1** (`test/pipeline-agents.test.ts`)
- Spec pauses with questions, the user answers, and the resumed Spec spawn has the resume flag with Spec's id.
- Plan's first spawn has **no** resume flag, even though Spec stored an id.
- `--from implement` clears `sessions.implement`.
- A failed resume (stub stderr `No conversation found with session ID`) leads to exactly one fresh spawn.

**G1b** (`test/questions.test.ts` or the existing questions test file)
- A pipeline questions file without options parses and writes back byte for byte.
- `(multi)` options with two ticks give an answer of both ids. `(single)` refuses two.

**G2** (`web/test/triage.test.ts`)
- All existing tests pass, with these adjustments: replace immediate `calls().at(-1)` with `until(calls().length)`; keep `run.pid` as the agent pid, so the stop and discard tests at [439-503](../../web/test/triage.test.ts) still find it.
- New tests:
  - **(a)** `server.close()` during a slow split leaves the agent alive, and a new `boot()` reattaches: `GET /triage` is `running` and the run later reaches `waiting` on the item-choice question.
  - **(b)** SIGKILLing nothing but the server is simulated with `close()`, which no longer kills.
  - **(c)** A turn finished while no server ran: the next `boot()` drains the events, and the run is `waiting` on the item-choice question.
  - **(d)** `saved` during a running quick item does not corrupt `run.json`. Both the draft and the mark survive.
  - **(e)** `discard` while the driver runs stops the job before removing the worktree, and no process with the worktree as cwd remains.
  - **(f)** `items` while a driver holds the lock returns 409.

**G3**: typecheck. The reconnect-with-id behaviour is covered by E2's and G2's server tests.

**G4** (`test/triage-driver.test.ts`, `web/test/triage.test.ts`)
- A stub result with `permission_denials: [{tool_name:'Bash',…}]` gives state `waiting` plus `permissions.json` with one pending entry.
- `POST /triage/permissions` with allow resumes, and `--resume` is in the argv.

**Whole-change regression** (orchestrator, after G2 and C4): `npm run check > /tmp/sdlc-ai-sdlc-helper.log 2>&1; echo exit=$?`. Then one real e2e on this repo: start a pipeline from the board, `kill -9` the `ui` server, restart it, check the run card, then kill the supervisor alone and check that the run shows `orphaned` and Kill works.

---

## 6. Things that can go wrong

| Failure | Detection | Mitigation and rollback |
|---|---|---|
| A group kill hits the wrong processes (bad pgid, or PID reuse) | The A3 tests. `killGroup` logs every group signal to `wrapper.log` or `supervisor.log` with pgid, members and the identity check. | The guards (pgid > 1, not our own pgid, identity or non-empty group). Revert B3 and C2 independently, and the legacy `killTree` path still works. |
| A detached child changes pipeline behaviour (for example, tests relying on the shared group, or `sh -c` wrappers) | The `test/runs.test.ts` suite and V9 | `ownGroup` is a single flag in `SOURCE`. Set it to false to revert to today's topology without reverting B2's heartbeat. |
| The heartbeat stalls because the supervisor's event loop is blocked, giving a false `hung` | `hung` shows while `status.json.updated` keeps advancing | The only blocking wait in the supervisor is `finish()`'s 5 s handshake. Stale means 45 s (4.5× the interval). `hung` only shows a badge, never an automatic kill. |
| An interrupted agent counted as success advances to a gate or the next stage | The D1 test. Run logs show the gate starting after `STOPPED`. | D1 merges before B3. Success is judged from `result.subtype`. |
| A lock is left behind and blocks starts forever | `start` exits 4 naming a dead owner | `takeLock` breaks it once `sameProcess(owner)` is false. As a manual fallback, delete `<reg>/locks/<key>.lock`. The refusal message names the file. |
| Two writers corrupt triage `run.json` | The G2 (d) test. A JSON parse error in `readRunFile` is reported as a 500. | Lock-held writes only, and `marks.json` split out. tmp+rename keeps every write atomic. |
| The driver writes into a discarded worktree | The G2 (e) test | `discard` awaits `stopJob` before `removeTriageWorktree`. `saveRun` already ignores a missing worktree ([web/server/triage.ts:110-117](../../web/server/triage.ts)). |
| stream-json is block-buffered to a file, so the UI shows no progress until the end | V2. G2 manual check: no `text` events while the agent runs. | The progress stream degrades but correctness does not, because the result is parsed at exit. Fallback: the driver keeps a pipe to the agent and writes the NDJSON file itself. The driver, not the server, is the parent, so it still survives the server. |
| Claude's Bash commands escape the group (setsid) and survive a SIGKILL escalation | V3. `ps` after an escalated stop. | SIGINT first lets claude kill its own Bash tree (documented for SIGTERM, seen for SIGINT in E2). The final `processTree` sweep catches escapees still parented to a dead tree. On Linux, `systemd-run --scope` remains the complete answer (out of scope). |
| `ps -o lstart=` differs by locale or platform, so identity is always false and nothing can be stopped | A2 tests on Linux CI. V4. | `LC_ALL=C`. If `start === ''`, fall back to `alive`. Identity mismatch blocks only signalling. Reconcile reports `supervisor-lost` and never kills. |
| Reconcile writes `supervisor lost` over a live supervisor's record (slow `ps`, races) | The C4 late-supervisor test | Re-check `sameProcess` right before writing. Write only when the record is still `running` with the same `pid`, as `stopRun` already does ([src/runs/index.ts:309-312](../../src/runs/index.ts)). |
| The palette 202 path breaks scripted users of `POST /command` expecting a sync reply | F1 tests. Clients that get `202`. | Fast commands keep the 200 shape within 3 s. Rollback: revert F1, and `runCommand` returns. |
| Command jobs pile up in `jobs/` | `du -sh <reg>/jobs` | `pruneJobs` on server start (keep 50, at most 7 days). Never prune a running or occupied job. |
| The `--after-agent` resume skips an agent whose output is stale or belongs to another attempt | D3 tests with an older mtime | Require mtime > `agent_started`, a matching agent name, `success && !is_error`, and no denials. Otherwise run the agent. The button shows only for `agent finished, checks not run`. |
| The Node 18 CI leg fails on an API added later | The CI matrix ([.github/workflows/ci.yml:14](../../.github/workflows/ci.yml)) | `@types/node` is pinned to 18, so typecheck catches most of it. Review each brief for `fs`, `os` and `child_process` additions. |
| Windows regression (detached opens console windows, or identity spawns PowerShell) | The platform-injected unit tests | `ownGroup = false` and `procStart = ''` on win32, with no PowerShell calls. Documented in H1. |

---

### Triage-specific things that can go wrong (added 2026-11-04)

| What goes wrong | How to detect it | Mitigation |
|---|---|---|
| A stage resumes another stage's session, so context leaks between stages | P1 test: Plan's first spawn has no resume flag | Sessions keyed by stage and cleared on every fresh stage start |
| The session file is gone and the agent loses all memory | `No conversation found` on stderr; `rehydrated > 0` | A fresh session from `context.md` and the answered questions; one try only |
| The agent forgets to update `context.md`, so a rehydrate starts thin | `context.md` mtime is older than the last turn | The driver appends a progress line per turn itself (phase, items so far), so context is never empty; the prompt asks again |
| The agent writes a question with no suggested answer | Parser finds `**Suggested:**` empty | The driver fills in "no suggestion" so auto-accept doesn't hang, and the UI shows it as needing an answer |
| The user edits `questions.md` by hand and breaks the format | Parser error | Show the error in the UI with the raw file; don't resume |
| An answer arrives while a driver still runs | Lock busy | 409, and the UI retries once the state is `waiting` |
| The item choice refers to a slug that was renamed | Unknown id in the answer | Ignore unknown ids, log a warning event |

## 7. Orchestration notes

**Project rules the orchestrator must enforce** (from [CLAUDE.md](../../CLAUDE.md)):
- Run `npm run check` before every commit and push, with the output going to a log: `npm run check > /tmp/sdlc-ai-sdlc-helper.log 2>&1; echo exit=$?`. On exit 0, skip the log. On failure, grep or tail only the failing parts.
- Work goes via one PR per subtask into `main`. **Confirm each merge with the user, naming the PR number and its CI status.** Never merge on your own judgement.
- Use worktrees at `../ai-sdlc-helper-sdlc/<slug>`, one per subtask: for example `../ai-sdlc-helper-sdlc/a2-proc-identity` on branch `a2-proc-identity`.
- Subagents must not wait on runs over 5 minutes, because the prompt cache expires. A subagent writes the code and runs only its own new or changed test files (`npx vitest run test/proc.test.ts > /tmp/sdlc-a2.log 2>&1; echo exit=$?`), then ends. The parent runs the full `npm run check`, commits and opens the PR. Alternatively, a script writes a short result file for a fresh subagent to read.
- Name SDLC stages by name (Spec, Plan, Red tests, Implement, Test repair, Review, Finalise), never by number, in code, prompts, UI text, PR titles and commit messages.
- Use the `porter` subagent for phase work. Its brief is the §2 subtask text, plus its §5 test entry, plus every §3 paragraph that names its area, plus "Plan: docs/plans/detached-jobs.md §2 <ID>" (after A0). The brief must make exploration unnecessary.
- Tests exercise real code (imports or `test/helpers.ts`), never Markdown or comments. User-facing text lives in `assets/` (none of these subtasks add prompts. G1 reuses `triage-*.md`).
- End commit messages and PR bodies with the attribution lines the session supplies.

**Model routing.** Run the `<!-- model: … -->` tag in each brief as written. Opus: A2, A3, A4, B2, B3, C1, C2, C3, C4, D1, D3, G1, G2, P1. Sonnet: A0, A1, B1, C5, D2, D4, E1, E2, F1, F2, G0, G1b, G3, G4, H1. When a Sonnet subtask's PR review finds a race or signal problem, send the fix to Opus instead of retrying on Sonnet.

**Suggested schedule.**
1. Wave 1, after A0: A1, A2, B1, D1, D2, E2 and G1 in parallel, in seven worktrees.
2. Wave 2: A3 ∥ A4.
3. Wave 3: B2, then B3. Merge B3 only after D1.
4. Wave 4: C1 ∥ E1.
5. Wave 5: C2, then C3, then C4, alongside F1 ∥ G2.
6. Wave 6: C5, D3, F2, G3.
7. Wave 7: D4, G4, H1.

Run V1 to V8 before Wave 1 (most take under a minute), and paste each result into the brief that depends on it.

**Token-saving tips.**
- Navigate with graft, not grep. Load all graft tools in one ToolSearch (`select:mcp__graft__graft_find_code,mcp__graft__graft_find_all,mcp__graft__graft_trace_calls,mcp__graft__graft_file_api,mcp__graft__graft_repo_map`).
  - Use `graft_file_api` to re-verify a brief's line spans in about 200 tokens.
  - Use `graft_trace_calls` before changing `isRunning`, `alive`, `killTree`, `stopProcess` or `recordedSlugs`, to list callers. Known callers: [web/server/triage.ts:370-381](../../web/server/triage.ts), [src/index.ts:38](../../src/index.ts), [test/runs.test.ts:81, 333](../../test/runs.test.ts), [test/shell.test.ts:95-101](../../test/shell.test.ts).
- Give each subagent exact `file:line` spans and tell it to read only those spans with `sed -n` or `Read` offset/limit.
- Reuse helpers instead of rewriting them:
  - processes and records: `alive`, `processTree`, `killTree`, `writeRecord` (tmp+rename), `regFile`, `withStartLock`, `startSupervisor`, `pipelineArgv`, `pipelineEnv` ([src/runs/records.ts](../../src/runs/records.ts), [src/runs/index.ts](../../src/runs/index.ts), [src/runs/supervisor.ts](../../src/runs/supervisor.ts));
  - questions and auto-accept: `parseQuestions`/`answerQuestions` ([src/runs/view.ts:75-120](../../src/runs/view.ts)), `autoAcceptQuestions` ([src/pipeline/stages.ts:85-95](../../src/pipeline/stages.ts));
  - triage: `parseStreamLine`, `pendingTriageQuestions`, `answerTriageQuestions`, `parseTriageItems`, `buildTriageDraft`, `triageAnsweredMessage`, `triageContinueMessage`, `createTriageWorktree`, `removeTriageWorktree` ([src/triage.ts:85-255](../../src/triage.ts));
  - test helpers: `tmp`, `project`, `pathWith`, `run` ([test/helpers.ts](../../test/helpers.ts)); the triage STUB and `boot()` ([web/test/triage.test.ts:18-106](../../web/test/triage.test.ts)); the `AI_SDLC_HELPER_PIPELINE_CMD` stub pattern ([test/runs.test.ts:95-98](../../test/runs.test.ts)); the injected `spawnAgent` pattern ([test/pipeline-agents.test.ts:59-67](../../test/pipeline-agents.test.ts)).
- Keep the logs out of context. Redirect long commands to `/tmp/sdlc-<id>.log` and read only `exit=`. On a failure, `grep -nE "FAIL|×|Error" /tmp/sdlc-<id>.log | head -30`.
- Do not re-research. The record schema, file layout, decision table and signal facts in §1 to §3 are final unless a V-check contradicts them. A brief that finds a contradiction stops and reports it instead of improvising.

The key shift is that the server becomes a reader, not a host. When nothing in the server process is needed for a job to make progress, a crash costs only the SSE connections. The browser reconnects with `Last-Event-ID` and loses nothing. The new risk is the power to kill a whole process group. Most of the Opus budget goes to the four guards around that, the one-writer rule, and the two places where a SIGINT exiting 0 could pass for success.
