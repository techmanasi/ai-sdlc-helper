# Plan: pass the stop reason to the stage a run returns to; vacuous red tests go back to Red tests first; unique test names

Built outside the pipeline on `fix/red-gate-handoff`, from `feat/ui-refresh`. The per-kind Review fix-loop gate is a
separate change and is not part of this one.

## Problem

When a gate or check stops a run and names an earlier stage to resume at, the reason stays in `run.out`,
`errors.log` and files like `red-passing.md`. The agent of that earlier stage never sees it, so a resume
repeats the same work and the same stop. Seen in `fix-loop-red-gate-kind`: two resumes at Plan, each ended
identically, and the plan agent was never told which tests already passed.

Every red-gate message is harness output (`redTestsStage`, `recordResults`), not agent output. So the
handoff can be built in the harness, with no help from the agent.

## Part 1: the handoff (fix 4)

- New module `src/pipeline/handoff.ts`:
  - `writeHandoff(ctx, { to, from, reason })` writes `<log>/handoff.json`:
    `{ to: From, from: string, reason: string, at: ISO time }`.
  - `takeHandoff(ctx, from)` reads it when the run starts. It returns the note when the file's `to` is the
    stage the run starts at, or a later stage the start runs through.
  - The note is consumed once that stage's agent finishes: the file goes to `logs/previous/` via `setAside`.
- **Where it is written.** At the end of a run (`src/pipeline/run.ts`, where `Exit.resumeFrom` is recorded in
  `status.json`), when a stop names a resume stage, the stop's reason (`Exit.reason`) is written as the
  handoff to that stage. This covers every stop that names its stage, now and later. No call site has to
  remember to do it.
- **Where it is read.** A new `{{HANDOFF}}` placeholder in `promptValues` (`src/pipeline/agent.ts`), empty by
  default. The prompts for Spec, Plan, Red tests and Implement get it. Its text:
  `This stage is running again because a later step stopped the run:\n<from>: <reason>\nAddress this before anything else.`
- The run output prints one line when a note is handed over: `Handoff from <from> to <stage>: logs/handoff.json`.
- **Stopping again.** A stop that repeats within the same stage replaces the file. It never stacks.
- **Starting earlier.** A start at an earlier stage than `to` (for example Spec when the card said Plan) still
  hands the note to that first stage. The user chose to go further back, and the reason still applies.
- **Discard.** A discard sets the file aside with the rest of the run's logs.

## Part 2: a new test that already passes goes back to Red tests first (fix 2)

The initial Red tests gate (not the fix loop) today stops at once with `resumeFrom: 'plan'`.

- First time: the stage reruns the Red tests agent once within the stage, with the handoff text listing the
  passing tests. Its instruction: each of these passes on the code before the change. If it checks behaviour
  that already exists, delete it or rewrite it to check only the new behaviour. If it does check new
  behaviour, the spec or plan is missing something, so leave the test as it is. The gate then runs again.
- Second time (still vacuous): stop as today, with `resumeFrom: 'plan'`. The message adds `after one Red tests
  retry`. Part 1 hands the list and the reason to the plan agent.
- `ctx.status.attempt` shows `2/2` during the retry.
- The hint (`src/pipeline/hints.ts`) keeps its Plan card for the repeated stop. Its manual action names
  `logs/handoff.json` too.
- The source guard and the "no test file" check run after the retry as they do after the first attempt.

## Part 3: every new test has a unique name (backlog `red-tests-unique-names`)

- **Retry matching** (`runSuite`, `src/runners/run.ts`): first-run and re-run results are matched per occurrence:
  file, name and the index among results with that file and name. A failing row whose same-named sibling passed
  is no longer "flaky".
- **Red tests prompt** (`assets/prompts/prompt-red-tests.md`): every test, and every row of a parameterised test,
  has a unique name in its file (use the framework's placeholder, such as `%s` or `$name`).
- **Gate check** (`redTestsStage`, initial and resumed path): after the new tests run, a repeated `file :: name`
  among the gate files is found from the reported results (`RunResult.tests` in `<log>/tests.json`). The first
  time, it gets the same one in-stage Red tests retry as Part 2, with the repeated names. If they still repeat,
  the stage stops with `RED GATE FAILED: N test name(s) repeat in the new tests:` plus the list,
  `resumeFrom: 'red-tests'`. The hint offers Resume at Red tests only.
- The duplicate check runs before the vacuous check. One retry budget covers both: a retry handles both lists in one
  prompt.
- Names that repeat only in test files the task did not add or change are ignored.

## Tests (real code, through `test/helpers.ts` fixtures and fake agents)

- `handoff.ts` unit: write, then take for the matching stage; take for a later `to` returns nothing; take
  after the stage finishes returns nothing (set aside).
- Pipeline: a stop with `resumeFrom: 'plan'` writes `handoff.json`. A `start --from plan` gives the plan
  agent a prompt holding the reason, and the next start does not.
- Pipeline: the fake Red tests agent first writes a test that already passes, and on its second call
  (prompt holds the list) removes it. The gate passes and no Plan stop happens.
- Pipeline: the fake agent keeps the passing test. The run stops with `resumeFrom: 'plan'`, the message says
  `after one Red tests retry`, and `handoff.json` names `plan`.

## Not in this change

- Agents writing their own recommendation for an earlier stage. Today only the harness stops runs, so no
  agent output names an earlier stage.
- Showing the handoff on the run page. The card and `run.out` already show the reason; a UI line can follow.
- The per-kind Review fix-loop red gate (backlog `fix-loop-red-gate-kind`).
