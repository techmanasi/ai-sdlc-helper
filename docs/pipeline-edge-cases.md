# Pipeline edge cases

Cases where a run stalls, loops, or shows something misleading, and how a person without the source code can tell what happened. Add an entry when you meet a new one; do not rewrite old entries, mark them fixed instead.

Entry format: **Symptom** (what the user sees), **How to tell** (where to look), **Cause**, **What to do**, **Gap** (what the product should tell the user and does not), **Status**.

## Where to look, in order

1. The run page: stage, attempt (`2/4`), the buttons shown, and the warnings under each round.
2. `docs/backlog/<slug>/logs/run.out`: the run's own narration (in the task's worktree under `../ai-sdlc-helper-sdlc/<slug>`). Lines starting `!!` and `WARNING:` are the pipeline noticing something.
3. `docs/backlog/<slug>/logs/<agent>.log`: what the agent said last. The `.json` next to it is the raw event stream; the `.err` is stderr.
4. `docs/backlog/<slug>/test-issues.md`, `merge-failure.md`, `ci-failure.md`, `pr-comments.md`: the inputs a stage gets. If one exists, that is what the next stage will read.
5. `.git/sdlc-runs/<slug>.json` in the main checkout: state, pid, `from`. It does not say who started the run.

---

## 1. Implement loops on a defect in a locked test

- **Symptom:** Implement attempt 1 fails with `LINT:` lines that point at files under `test/`. Attempt 2 changes 0 files. The attempt counter keeps climbing to the maximum.
- **How to tell:** `run.out` shows `agent claimed test defect in …/test-issues.md`, then `no files changed in this round`. `test-issues.md` names the test file and the rule it breaks (for example an unused import, or `no-restricted-imports` for `web/**`). The agent's last message says the tests are locked.
- **Cause:** Tests are written before Implement and locked; a guard stops the run if Implement edits them. A lint defect in a test cannot be fixed by changing source.
- **What to do:** stop the run, resume at **Test repair** (`FROM=test-repair`), then run Implement again. The run itself prints `use FROM=test-repair to resume at Test repair` when `test-issues.md` exists.
- **Gap:** The run page keeps offering Implement and spends the remaining attempts. When a round claims a test defect and the next round changes nothing, the run should stop and offer Test repair.
- **Status:** open (seen on `ci-full-suite-gate`, 2026-11-11).

## 2. "empty answer: the agent said nothing" although the agent answered

- **Symptom:** A round is flagged `empty answer`, yet the agent's `.log` holds a full final message.
- **How to tell:** Open `logs/<agent>.log` or the `.json`. An `agent_message` item with text means the agent did answer.
- **Cause:** `src/pipeline/observe.ts` warns when the agent exited 0 and the captured response length is 0. For the agent `gpt-6.1-sol` the length is 0 even when the stream has a message, so the answer is not captured. Not yet traced.
- **What to do:** ignore the warning for that agent and read the log. Do not conclude the agent did nothing; use `files changed` and the gate result instead.
- **Gap:** A false warning teaches people to ignore warnings.
- **Status:** open.

## 3. Resuming at Implement while `test-issues.md` exists

- **Symptom:** `WARNING: test-issues.md exists and is moved to the logs/previous folder`.
- **How to tell:** the warning in `run.out`, and `test-issues.md` is gone from the task folder afterwards.
- **Cause:** a resume from Implement sets the issue file aside so Implement does not see it. The defect it described is still there.
- **What to do:** if the issue is a test defect, resume at Test repair instead (see 1). The set-aside copy is in `logs/previous`.
- **Gap:** the warning names the right stage but nothing stops the run.
- **Status:** open.

## 4. Vitest fails with `EPERM` writing under `node_modules/.vite-temp`

- **Symptom:** the agent reports "targeted tests cannot start"; a check ends with `0 passed, 0 failed, 1 file errors, no report`.
- **How to tell:** the agent's message or `logs/tests.log` shows `EPERM` on a path under `node_modules/.vite-temp`.
- **Cause:** a task worktree reaches `node_modules` through a shared path, and vitest's config cache is written there. The agent's sandbox may forbid it. Not confirmed.
- **What to do:** run the tests with a cache directory inside the worktree; not tried yet.
- **Gap:** the run counts this as a failed check, which looks like a code problem.
- **Status:** open, to investigate.

## 5. Pressing Resolve conflicts again does not help

- **Symptom:** Resolve conflicts stops with "the check failed on the rebased branch" every time.
- **How to tell:** `logs/resolve-conflicts-<n>.json` and `resolve-conflicts.md`; the stop report names the failing tests and whether the base branch passes them.
- **Cause:** every retry rebuilds the same rebased attempt from the old tip.
- **What to do:** use **Fix with Implement**. It makes the kept attempt (`refs/sdlc-attempt/<branch>`) the branch and gives Implement `merge-failure.md`. The old tip stays at `refs/sdlc-backup/<branch>/local`.
- **Gap:** if the test failures in the attempt are really defects in locked tests, Fix with Implement hits case 1.
- **Status:** shipped in #99; interaction with 1 open.

## 6. "Restart Implement with the CI failure" without a visible failure

- **Symptom:** the button shows but the user sees only a merge conflict.
- **How to tell:** `gh pr view <n> --json statusCheckRollup,mergeable`. The button follows GitHub's check state for the PR head, not the conflict.
- **Cause:** the PR head still has old failed runs (a conflicting PR cannot get new ones).
- **What to do:** resolve the conflict first; do not restart Implement for it.
- **Gap:** the button does not say which checks failed or that the result is from an old commit.
- **Status:** open.

## 7. PR comments buttons with no comments

- **Symptom:** "View PR Comments" and "Resume at Implement to fix PR comments" appear on a PR with no comments.
- **How to tell:** `pr-comments.md` says `Total comments: 0`.
- **Cause:** the file was written even when empty, and its existence turned the buttons on.
- **What to do:** none needed after the fix.
- **Status:** fixed in #100.

## 8. Who started a run

- **Symptom:** a run is going that the user does not remember starting.
- **How to tell:** `.git/sdlc-runs/<slug>.json` has `pid`, `started` and `from`, not the trigger.
- **Gap:** record the trigger (button, CLI, or other process).
- **Status:** open.

## 9. Test repair refuses to run a second time

- **Symptom:** resuming at Test repair stops at once with `REJECT: test repair was already accepted in commit <sha>: use FROM=review`.
- **How to tell:** `git log --grep="repair invalid tests"` in the task worktree shows a `test(<slug>): repair invalid tests` commit above the red-tests commit. The resume check (`resumecheck` in `src/testcheck/checks.ts`) rejects when it finds one.
- **Cause:** the check treats any earlier repair commit as "Test repair is done". It does not look at whether the tests are still defective (here: `LINT:` errors in locked test files that appeared after the first repair, for example an unused `vi` import and `no-restricted-imports` in `web/test/`).
- **What to do:** `FROM=review` does not help, because the test lint defects still fail the gate. Until this is fixed, the test files must be corrected by a person or by a new Test repair run that is allowed past the check.
- **Gap:** a task can need Test repair twice (after a rebase, or after a lint rule changes). Entry 1 tells the user to resume at Test repair; this check can then refuse it.
- **Status:** open (seen on `ci-full-suite-gate`, 2026-11-11). Proposed: allow the resume when the lint or test check still reports defects in locked test files, and say so in the message.

## 10. The run's branch cannot be pushed: the push check

- **Symptom:** `run.out` shows a `Push check:` line after Plan (and after a refused push later). Sometimes `MOVED:` lines follow, and the run page shows `moved from <old branch>: <reason in words>` and a branch ending in `_2` (or `_3`, and so on).
- **How to tell:** `attempts.jsonl` has a `push-check` row (`finding`, `action`) for every check and a `move` row for a move; `status.json` holds `branch` and `moved_from` (old branch, `reason`, `reason_text`, old pull request); the brief's `pr:` line points at the new draft pull request once Red tests has pushed. Anything git said in full is in `errors.log`.
- **When it runs:** after Plan and before Red tests, for a start at Spec, Plan or Red tests (after the check that refuses a start whose red-tests commit exists, so a refused start changes nothing). Again when origin refuses a push at the start of CI (Red tests, a resumed Implement, Test repair or Review in `tests.fullSuite: "ci"` mode) or Implement's own push. Never in Resolve conflicts, and never on a kept attempt (`SDLC_ON_ATTEMPT=1`, "Fix with Implement"): that branch is rebased on purpose and keeps its pull request.
- **The ladder** (L is the run's HEAD, R origin's branch, B origin's base, else the local base). The first row that applies decides:

  | Finding | What is done |
  | --- | --- |
  | No `origin` remote | nothing |
  | Origin cannot be asked (the fetch fails, not "no such branch") | nothing; one `errors.log` entry |
  | The pull request (brief link, else by branch) is closed or merged | new branch |
  | R is absent, or L contains R, and a trial push (`--dry-run`) works | nothing: the branch can be pushed |
  | L is behind R, the run started at Spec or Plan and has no commits of its own | new branch (R is an earlier run's work) |
  | L is behind R otherwise | fast-forward to R |
  | Diverged, and every commit of R has the same change in L | push with `--force-with-lease=<branch>:<R>` |
  | Diverged otherwise, clean tree, rebase onto R is clean | rebase onto R and push |
  | Diverged, the rebase stops on a conflict (it is aborted), or tracked files have uncommitted changes | new branch |
  | The trial push fails twice because origin cannot be reached or does not accept this user (host, network, timeout, authentication, permission, repository not found) | nothing; one `errors.log` entry (a new branch would fail the same way) |
  | The trial push fails twice because origin refuses this branch (`remote rejected`, a hook, a protected branch, `GH006`, `GH013`) | new branch (`branch-refused`) |
  | Any other trial-push failure, a stale lease, or a failed push after the fix | new branch |

  After a fix, when the branch is on origin and a trial merge (`git merge-tree --write-tree`) of L and B conflicts, Resolve conflicts runs at once, inside the run: the run page shows Resolve conflicts and then the calling stage again; it asks no follow-up question, and a stop ends the run with the calling stage's resume command. With `tests.fullSuite: "ci"` and no task tests yet, its local check is skipped (it would be the whole suite) and CI checks the pushed branch.
- **New branch:** `<prefix><slug>_N`, N from 2, skipping every name that exists as a local branch, a remote-tracking branch, or on origin now. A slug has no underscore, so the name is never another item's branch (`<slug>-2`, `<slug>-resolve-conflict-1`). It is made from B with the run's own commits picked onto it; when a pick conflicts, everything is put back and the branch starts at L instead (the output says which); if the old branch cannot be checked out again, the run stops and names both branches and `refs/sdlc-backup/<branch>/local`, discarding nothing. Its draft pull request says what it replaces and why; when nothing is committed yet, Red tests pushes it, opens the pull request and commits the link (`chore(<slug>): link pull request`). If that push fails too, the run goes on as for any failed push (in `ci` mode, the full suite runs locally); it never tries again in a loop.
- **gh:** when `gh` is missing or fails, the output says once that the pull request's state was not checked.
- **Switches:** `SDLC_PUSH_CHECK=0` (or `no`, `off`) skips the whole check. `SDLC_MOVE_BRANCH=0` keeps the branch when the ladder ends at "new branch" (the fast-forward, lease push, rebase and Resolve conflicts still apply).
- **What is never done:** a bare `git push --force`; deleting or closing the old branch or its pull request (a lease push replaces origin's commits only with the same changes, and the old tip is kept at `refs/sdlc-backup/<branch>/remote`; the local one before any rewrite at `refs/sdlc-backup/<branch>/local`).
- **Gap:** the old pull request stays open for a person to close.
- **Open:**
  - Discard or restart after a move deletes only the new branch; the old one (and its pull request) stays.
  - The main checkout's brief keeps the old pull request link until Finalise.
  - A failed `gh pr create` logs no stderr (`errors.log` says "no output available").
- **Status:** handled (open points above).
