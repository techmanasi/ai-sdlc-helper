# Good to have

The remaining findings from the `board-quiet-time-setting` run (web UI, auto-accept on, 2026-11-14/15, PR #146).
None of these reports something untrue or skips a check; the must-fix items are in [must-fix.md](must-fix.md).

## Run page and controls

| # | Item | Seen in this run |
|---|---|---|
| 1 | The main button reads "Resume from <stage>" while a run is live and after it is done. | "Resume from Spec" during Spec; "Resume from Resolve conflicts" on the finished run. |
| 2 | Recovery after a Spec failure offers "Bailout: Resume at Review" when there is no spec, plan or code yet. | Stage Recovery panel after the Spec agent was killed. |
| 3 | A stage that never ran shows a ✔. | Test repair ticked although Implement was green on its first attempt. |
| 4 | Output from a failed attempt stays above the retried run with no separator. | The killed Spec attempt's output above the retry. |
| 5 | "This run" Files count resets after a kill. | "1 changed · 1 uncommitted" went to "0 changed · 0 uncommitted". |
| 6 | Questions answered by auto-accept are never shown on the run page; `questions.md` is removed and only `decisions.md` remains. | Spec's 4 questions, round 1. |

## Starting a run

| # | Item | Seen in this run |
|---|---|---|
| 7 | Two auto-accept checkboxes (Run options and Environment for this run). | Both present; the second follows the first after Start. |
| 8 | The stage pickers load late and shift the layout, so a click can land on the wrong control. | The first click on auto-accept missed. |
| 9 | Opening the UI without the sign-in link shows a bare error; the link is printed only in the terminal. | Vite on :5173 without the token. |

## Counts, names and times

| # | Item | Seen in this run |
|---|---|---|
| 10 | The sidebar Board count does not match the Backlog column. | Sidebar 6 (7 after Start) while the Backlog column showed 10. |
| 11 | The run output numbers stages ("== 1/6 Spec"), against the rule to name them, and says 6 while the UI shows 7 columns. | `logs/run.out`. |
| 12 | Times mix UTC (`status.json`, ending in Z) and local time with no zone (run file). | `status.json` vs `.git/sdlc-runs/<slug>.json`. |
| 13 | The pipeline's `pr:` link in `brief.md` is committed inside the `[implement]` commit, not by the step that wrote it. | Commit `d6ceefa`. |

## Speed

| # | Item | Seen in this run |
|---|---|---|
| 14 | The red gate runs whole test files, retries failures that are expected, and runs the same files a third time for `red.json`. Running only the new tests by name would cut about 4 minutes to about 15 s. | 3 files, 64 tests, 5 new: 145 s whole vs 14 s filtered. Per-runner details are in `docs/backlog/non-node-ecosystem-support/brief.md`. |

## Stage quality

| # | Item | Seen in this run |
|---|---|---|
| 15 | Red tests can hand acceptance criteria to Review instead of testing them ("UI review required"), even where the repo already tests UI logic by importing it from `web/ui/src`. | `test-cases-1.md`: the Config modal and two precedence rows. |
| 16 | Spec accepted weak answers without flagging them: the env value is shown rounded (1500 ms appears as "2"); unregistered projects get no field; a new value applies only when the current timer ends, while one line says "immediately". | `specs-1.md`, `decisions.md`. |
