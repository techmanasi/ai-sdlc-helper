Undo the last action taken on an SDLC pipeline run (`ai-sdlc-helper start <slug>`): a resume or stage started by mistake, then stopped, that left the branch or files in a state the user did not want. Use it when asked to undo, go back, revert or "get back to" an earlier state of a run.

# Undo an action on a pipeline run

Work out what the run looked like before the action, save what is there now, then put the run back. Nothing is rewound until the user has seen the plan and said yes.

Worktree: `../<project>-sdlc/<slug>` (branch `{{BRANCH_PREFIX}}<slug>`). Logs: `<worktree>/{{BACKLOG_DIR}}/<slug>/logs/`. Run record: `.git/sdlc-runs/<slug>.json` in the main checkout.

## 1. Use the checkpoint when there is one

Every start of a run that already had work saves a checkpoint: `.git/sdlc-runs/<slug>.checkpoint` (branch tip, a full copy of the worktree, the record) and the ref `refs/sdlc-checkpoints/<slug>`. The run page shows **Undo last start** when one exists, and it does the whole job: stops the run, rewinds the branch and files, and saves what it threw away as `refs/sdlc-checkpoints/<slug>-undone`. Prefer it. Only continue below when there is no checkpoint (the action was made before the feature existed, or it was the first start).

## 2. Read, change nothing

- Make sure the run is stopped: `.git/sdlc-runs/<slug>.json` `state` is not `running`. If it runs, ask before stopping it.
- When did the action start? `run.out` and `attempts.jsonl` have a `run` line (`from`, `at`) for every start, and a line per agent round.
- What did it change? In the worktree: `git status`, `git diff HEAD` (uncommitted edits stay in the worktree even after a stop), `git log --oneline --since=<that time>` and `git reflog` (the tip before it, even after a reset).
- What did it delete? Implement removes `test-issues.md` and the old `tests.log`, `tests.json`, `integration.log`. A deleted file that was never committed is not in git: say so, do not promise it back.
- What left the machine? `git log origin/{{BRANCH_PREFIX}}<slug>..HEAD` and `gh pr view`: a push, a PR or its comments are not rewound by anything here.

## 3. Show the plan, then ask

Say in a few lines: the commit the branch goes back to, which commits and files are lost, which files come back, and what cannot be undone. Wait for a yes. The user's own uncommitted work in the worktree counts: never discard it unseen.

## 4. Save, then rewind

1. Save the state you are about to replace: `git branch backup/<slug>-before-undo` for the commits, and the uncommitted part with `git diff HEAD > <scratchpad>/<slug>-uncommitted.patch` plus a copy of the untracked files you will remove (`git ls-files --others --exclude-standard`).
2. In the worktree only: `git reset --hard <sha>`, then `git clean -fd` limited to the paths you listed (never `-x`, so ignored folders such as `node_modules` stay). Restore files that were deleted from the copies or from the old commit.
3. Put the run's status back to where it stood: `status.json` `stage` to the stage that last finished, and the record's `state` to `exited` if it still says running. Do not start anything.
4. Show `git status` and `git log --oneline -5`, and give the one command that undoes the undo (`git reset --hard backup/<slug>-before-undo`).

## Never

- Force-push, delete a remote branch or touch an `sdlc/*` PR to undo something: the push stays; say so.
- Rewind the main checkout or any branch but the run's own.
- Run `git clean -x`, `git stash drop` or `git gc --prune=now`, which destroy the way back.
- Start or resume the run as part of an undo. The user decides what happens next (usually **Resolve conflicts** or Resume at the right stage).
