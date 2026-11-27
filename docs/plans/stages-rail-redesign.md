# Stages rail redesign: gap analysis and task list

Design source: the "Run page stage rail" canvas (`canvas.json`: Main, Prerun, SpecReview, Narrow, Board, Completed,
Settings, Projects, NewItem, Recovery, LoopBC, StopKinds, RoundsA/B/C, RoundsView with its four scenarios).
Compared against `main` (branch `feat/stages-rail-redesign`). Web UI: `web/ui/src` (Preact). Run data: `src/runs/*`,
`src/pipeline/*`. Rounds A, B and C are options; RoundsView is the consolidated design (C's tile marks plus B's
timeline folded in) and is what the tasks below build.

## Status

| Board | Status | What exists / what is missing |
|---|---|---|
| Main (stage rail, pane, PR box, This run) | partial | Always-on pane following the running/paused/failed stage, "Back to <stage>" bar, Round pill, lock icon, per-stage usage and cost, `Agent rounds` panel, Test repair and Resolve conflicts steps (`stagePane.ts`, `RunInsights.tsx`, `Run.tsx`). Missing: stage popover with per-stage reviewers, Parallel reviewers tile, step pills with failure timing (on the unpushed branch, see below). |
| Prerun, SpecReview | partial | Scenarios of Main; same gaps. |
| Narrow | missing | Rail scrolls with hidden-tile counts and edge fades (`hiddenCounts`, `scrollTarget`). No "N done" folded tile, no "Scroll stages left/right" buttons, no `aria-pressed` tiles, no "Following the running stage" line, no "Open output" button. |
| Board | partial | `Board.tsx` has filters and a "Needs you" view. Missing: per-stage segmented bar with conditional (dashed) segments, stage text such as "Paused before Review" / "Failed at Red tests", PR cell "#85 open", UPDATED column as designed. |
| Completed | partial | `Completed.tsx` lists merged runs. Missing: "Search completed items" input, "stages that ran" bar with done / skipped / not needed segments, "N stages · Test repair ran" note. |
| Settings | partial | Settings exists. Missing: REVIEWERS ON DOUBT column, "Allow already merged branches", "Resolve conflicts automatically after Finalise" default, Retry limit / Max wait fields, "Add variable", Appearance (Light / Dark / System). |
| Projects | partial | Cards, counts and Open board exist. Missing: "Default editor" dialog (VS Code, Cursor, Zed, IntelliJ IDEA, System default, Custom command) and the per-card "Open in editor" using it. Run.tsx already has an "Open in editor" action; check what it reads before building. |
| NewItem | partial | Name, brief, project and agent fields exist. Missing: "Use project defaults" with summary vs editable table, "When" radio (Start now / Add to board, start later), live `sdlc/<slug>` branch line, "Command" block with Copy. |
| Recovery | partial | `RecoveryCard` with diagnosis, auto / manual action, Run options, "Override every stage", "Restart whole run from Spec…" and "Discard entire run…" with confirmations all exist in `Run.tsx`. Missing: the three-option card (Top up and retry, Switch model, Resume at a later stage with "Resume at Review?" confirmation), error-details disclosure, reviewers table with source chips (override / stage default / own choice). |
| LoopBC | missing | Only `Agent rounds` (`logs/attempts.jsonl`) and "running iteration N". No attempt marks on the Implement tile, no attempt rows, no "Back to Implementing" line, no Show error / Hide error panel with Copy and Open full log. |
| StopKinds | missing | Nine stop kinds (Questions, Permission, Account, Waiting, Process, Stopped by you, Repository, Stage check, Loop) with glyph and colour. The server has the diagnosis text (`src/pipeline/hints.ts`) but no kind field. |
| RoundsView (RedTests, Spec, Plan, Review) | partial | `StageSpan.rounds` gives start, end, status, steps (`src/runs/timeline.ts`). Missing: end cause and next action per round, "started: <reason>", per-round agent and model, answered-at times, round marks on the tile, Q&A list per round, cost toggle (Cost / Tokens / Off). |
| RoundsA/B/C | option | Not built as such; folded into RoundsView. |

## What `feat/stage-pane-redesign` covers

Unpushed branch in `../ai-sdlc-helper-sdlc/stage-pane-redesign`, two commits (3c4b06a "match stage rail design deck",
d9295ae "finish stage pane redesign and add screenshots (synthetic state)"), based on the older main 175c22d. It
touches `Run.tsx`, `RunInsights.tsx`, `stagePane.ts`, `styles.css`, `test/stage-pane.test.ts`,
`tools/UI-automation/sdlc-ui.js` and three screenshots (`docs/plans/screenshots/stage-pane-{pending,running,stopped}.jpg`).
It adds `stepPills(round, state, plan, updated, now)`: recorded steps with a duration or "failed at <time>", an open
step for a live one, planned steps beyond the furthest recorded one. It covers tile and pane styling and step pills
only. It does not cover rounds with end events, attempts, stop kinds, cost toggle, reviewers, popover, recovery
options or any other board. Main has moved on (branch sync, per-stage agent and effort work), so it needs a rebase
or a re-do; task 1 does that.

## Tasks

Order: dependencies first. Tasks 1 to 6 all touch `Run.tsx`, `RunInsights.tsx` and `stagePane.ts`: run them one after
another. Tasks 8 onward touch separate pages and may run in parallel after task 1.

### 1. Bring the step pills onto current main
Boards: Main, Prerun, SpecReview.
Build: rebase or re-apply `stepPills` and the tile/pane styling from `feat/stage-pane-redesign` onto main. Pills show
recorded steps with duration, "failed at <time>" for a cut step, a live step, planned steps (Test repair: Audit,
Repairing N of M tests, Lock tests; Resolve conflicts: Fetched main, Rebased · N files conflict, Agent resolving N of M
files, Push with lease).
Files: `web/ui/src/stagePane.ts`, `web/ui/src/RunInsights.tsx`, `web/ui/src/Run.tsx`, `web/ui/src/styles.css`,
`tools/UI-automation/sdlc-ui.js`.
Server/data: none; steps come from `StepSpan` in `src/runs/timeline.ts` and `stepPlan` in `src/runs/view.ts`.
Tests: `test/stage-pane.test.ts` for `stepPills` (cut, open, plan, unrecorded). `test/ui-automation.test.ts` must pass.
Done when: pane shows pills in the three states, selectors match markup, screenshots (synthetic state, said to be) in the PR.

### 2. Rail: "N done" fold, scroll buttons, aria-pressed tiles
Board: Narrow.
Build: fold finished leading tiles into one "N done" tile with an aria-label; "Scroll stages left" and "Scroll stages
right" buttons; tiles carry `aria-pressed`; a "Following the running stage" line with an "Open output" button when the
pane follows rather than the user's pick.
Files: `web/ui/src/stagePane.ts` (replace the hidden-count logic where it overlaps), `web/ui/src/RunInsights.tsx`,
`tools/UI-automation/sdlc-ui.js`.
Server/data: none.
Tests: `test/stage-pane.test.ts` for fold count and scroll targets.
Done when: a narrow viewport shows the fold and buttons, selectors updated, screenshots.

### 3. Round and end-event record (needs backend)
Boards: RoundsView, StopKinds, RoundsA/B/C.
Build: record per round the end cause, the next action, the agent and model used, and the start reason, then expose
them. Today a round is only a stage start and end (`StageRound { started, ended, status?, steps }`); no end cause,
next action, or per-round agent and model is recorded. Minimal backend: append `round` rows to `logs/attempts.jsonl`
(or a sibling row type) when a stage ends, with `cause`, `next`, `agent`, `model`, `startedBy`; the answer time for
questions comes from `questions.md` answers (record the answered-at when the answer is written).
Files: `src/pipeline/agent.ts`, `src/pipeline/stages.ts`, `src/runs/timeline.ts`, `src/runs/view.ts`,
`web/ui/src/api.ts`.
Tests: `test/timeline.test.ts` (rows to rounds with cause and next), `test/view.test.ts`.
Done when: `Timeline` rounds carry the new fields; rounds from older runs without them render without claims.
A failure that ends a round must also reach `errors.log` and the run output (existing rule); do not add a silent catch.

### 4. Stop kinds
Board: StopKinds.
Build: a pure module `web/ui/src/stopKind.ts` mapping a stopped run to one of Questions, Permission, Account,
Waiting, Process, Stopped by you, Repository, Stage check, Loop with glyph (?, P, $, ◷, !, ■, R, ✗, ↻), colour token,
cause line and action buttons. Classify from existing records: `RunView.questions`, `permissions`/`deniedPermissions`,
`RunView.recovery` (diagnosis and autoAction), review loop state (`reviewRounds`), `status.note` for a wait.
Account (billing/auth) and Process have no structured field today: add `kind` to `StageRecovery` in
`src/pipeline/hints.ts` (needs backend, small), derived where the diagnosis is already built; until then those two
render as Process with the diagnosis text.
Files: `web/ui/src/stopKind.ts` (new), `web/ui/src/api.ts`, `src/pipeline/hints.ts`, `web/ui/src/Run.tsx`.
Tests: `test/stop-kind.test.ts` for each of the nine kinds; `test/hints.test.ts` for the new field.
Done when: every stopped state shows exactly one kind; unknown maps to Process.

### 5. Rounds in the pane and round marks on the tile
Board: RoundsView (RedTests, Spec, Plan, Review scenarios).
Build: marks on the tile (role=img with aria-label), round sections in the pane with "started: <reason>", steps, end
event "<cause> → <action> → <next>", Q&A list per round with answered-at, between-round "You answered N · mm:ss".
Depends on 3 and 4. Same file set as 1 and 2.
Files: `web/ui/src/stagePane.ts` (`roundsOf`), `web/ui/src/RunInsights.tsx`, `web/ui/src/Run.tsx`,
`tools/UI-automation/sdlc-ui.js`.
Tests: `test/stage-pane.test.ts` for round labels, marks, end-event text.
Done when: each scenario renders from synthetic data; a round with no recorded cause shows no cause (never guessed).

### 6. Attempts on Implement, with error panel
Board: LoopBC.
Build: attempt marks on the Implement tile (aria-label like "Attempts: 1 failed, 2 failed, 3 running, 2 left"), attempt
rows, "↩ Back to Implementing: <reason>", Show error / Hide error with `aria-controls`, Copy, Open full log. Data:
`AttemptRound` rows already carry agent, model, exitCode, usage, denied, warnings, `gate.failing`; the error text and
log path per attempt are not recorded (needs backend: add `error` excerpt and `log` path to the attempt row).
Files: `src/pipeline/agent.ts`, `src/runs/view.ts`, `web/ui/src/api.ts`, `web/ui/src/stagePane.ts`,
`web/ui/src/Run.tsx`, `web/ui/src/RunInsights.tsx`.
Tests: `test/stage-pane.test.ts` (attempt label), `test/view.test.ts` (error and log fields).
Done when: failed attempts show the real recorded error; none recorded means no Show error button.

### 7. Permission and wait panels
Boards: StopKinds, RoundsView.
Build: permission panel ("Spec was refused 2 actions", Allow once / Always / Deny, "Allow all and resume", "Resume
without them"): `Run.tsx` already has Allow, Allow always, Allow all; add Deny and "Resume without them" over
`api.permit` (Deny needs a backend verb in `src/permissions/index.ts`; marked needs backend). Wait panel ("Waiting for
the usage limit to reset · resets <time>", Retry now, Switch model and retry, Stop waiting): the reason exists only as
free text in `ctx.status.note` ("usage limit, resets 1:10am (...)") from `SDLC_LIMIT_RETRY`/`SDLC_LIMIT_MAX_WAIT`
handling in `src/pipeline/agent.ts`. Needs backend: a structured wait record (`until`, `since`) and a stop-waiting
signal the wait loop reads. No countdown or waited-so-far record exists today; do not render one without it.
Files: `src/permissions/index.ts`, `src/pipeline/status.ts`, `src/pipeline/agent.ts`, `web/server/http.ts`,
`web/ui/src/api.ts`, `web/ui/src/Run.tsx`.
Tests: `test/permissions.test.ts`, a status wait-record test, UI label logic in a plain module.
Done when: buttons act on real records only; a failed action shows in the run output and `errors.log`.

### 8. Cost toggle
Board: RoundsView.
Build: Cost / Tokens / Off toggle, shown only when cost data exists (`UsageTotals`, `src/runs/cost-log.ts`).
Files: `web/ui/src/RunInsights.tsx`, `web/ui/src/insights.ts`, `tools/UI-automation/sdlc-ui.js`.
Server/data: none. Tests: `test/insights.test.ts` for the shown/hidden rule and per-mode text.
Done when: toggle persists per viewer (localStorage in try/catch), hidden without cost data.

### 9. Stage popover and per-stage reviewers on doubt
Boards: Main, Settings.
Build: stage popover with the searchable model listbox (`ModelSelect.tsx` already has "Search models…") and a
"Reviewers if the agent records doubt · they run in parallel" list with "Add reviewer"; Parallel reviewers tile and
"Decide by" control. Backend: reviewers on doubt exist only for Resolve conflicts (`src/pipeline/review-panel.ts`,
`reviewPanel`, global `review.reviewers` 2..5, unanimous SAFE verdict recorded in `resolve-review.md`). There is no
per-stage list, per-reviewer agent or model, or doubt reviewer for Spec and Plan. Out of scope: parallel reviewers
on doubt for Spec, Plan and Review (new pipeline feature; own plan needed). In scope: popover and model search, and a
read-only display for Resolve conflicts. "Decide by: Majority" conflicts with the unanimous-SAFE rule: do not ship it.
Files: `web/ui/src/RunInsights.tsx`, `web/ui/src/ModelSelect.tsx`, `web/ui/src/stageAgent.ts`,
`web/ui/src/Settings.tsx`.
Tests: `test/stage-agent.test.ts` for the listbox filter and grouping logic.
Done when: popover edits model and effort per stage as the existing pick does; no control claims reviewers that the
pipeline does not run.

### 10. Recovery options
Board: Recovery.
Build: card with Top up and retry, Switch model, Resume at a later stage ("Resume at Review?" confirmation, using
`web/ui/src/resume.ts`), Error details disclosure, reviewers table with source chips, CLI line with Copy.
Depends on 4. Files: `web/ui/src/Run.tsx`, `web/ui/src/resume.ts`, `web/ui/src/api.ts`.
Server/data: none new beyond task 4 kinds; "Top up" opens billing only, it cannot verify the top-up.
Tests: `test/resume.test.ts`-style module test for options per kind.
Done when: options match the stop kind; sdlc-ui.js selectors updated.

### 11. Board page
Board: Board.
Build: segmented per-stage bar (8 segments, conditional dashed), stage text, PR cell, UPDATED.
Files: `web/ui/src/Board.tsx`, `web/ui/src/stages.ts`, `src/runs/view.ts` (`RunCard` stage states if missing).
Tests: `test/board-stages.test.ts`.
Done when: card rows match the design in every state; screenshots.

### 12. Completed page
Board: Completed.
Build: "Search completed items" (items or branches), stages-that-ran bar (done, skipped, not needed), note text.
Files: `web/ui/src/Completed.tsx`, `src/runs/completed.ts`. Tests: a plain module for the filter and note text.
Done when: search filters live; stages that ran come from the recorded timeline, not inferred.

### 13. Settings: run behaviour and appearance
Board: Settings.
Build: Allow already merged branches (SDLC_ALLOW_MERGED), automatic Resolve conflicts default, Retry limit
(SDLC_LIMIT_RETRY), Max wait (SDLC_LIMIT_MAX_WAIT), Add variable, Theme Light / Dark / System.
Files: `web/ui/src/Settings.tsx`, `src/config/settings.ts`, `web/ui/src/styles.css`.
Tests: `test/settings.test.ts` for new keys; theme logic in a plain module.
Done when: values round-trip to the settings file and env.

### 14. Projects: default editor
Board: Projects.
Build: Default editor dialog with the six choices and custom command (`{path}` placeholder); "Open in editor" uses it.
Files: `web/ui/src/Projects.tsx`, `web/server/http.ts`, `src/config/settings.ts`.
Server: store the editor choice; run the command without a shell string built from user text (argv, `{path}`
substituted as one argument). Tests: command builder in a plain module.
Done when: each editor maps to its command; custom command is validated.

### 15. NewItem: stages and When
Board: NewItem.
Build: "Use project defaults" with summary or editable table, "When" radio, live branch line, Command block with Copy.
Files: `web/ui/src/NewItem.tsx`, `web/ui/src/stageAgent.ts`. Tests: `test/stage-agent.test.ts`.
Done when: Add to board, start later creates the item without starting a run.

## Conflicts with repo rules

- Stage names, never numbers. The design's sample Output text ("== 1/6 Spec", "== 4b Test repair") must not be
  copied; use "== Spec", "== Test repair". Check the existing output writer before matching any design text.
- `tools/UI-automation/sdlc-ui.js` SELECTORS and functions change in the same PR as any markup or label change;
  `test/ui-automation.test.ts` fails when a selector leaves `web/ui/src`.
- Every UI PR carries screenshots of the changed screens, taken against synthetic state and stated as such.
- The UI never claims anything about a run that a record does not verify: no countdown, cause, reviewer count or
  top-up status without a record (see tasks 3, 6, 7, 9, 10).
- Every pipeline failure goes to `errors.log` and the run output; new actions and records must not catch silently.
- UI logic is tested through plain `web/ui/src` modules (as in `test/stage-pane.test.ts`); never assert on Markdown.
- Markdown-only PRs run `npm run lint` only; code PRs run targeted tests locally and the full suite in CI.
