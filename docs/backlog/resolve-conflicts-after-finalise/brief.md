# resolve-conflicts-after-finalise

Type: feature
Priority: P2 (normal)

## Problem


## Expected behaviour


## Decisions## Problem
After Finalise opens the PR, `main` can move on (other PRs merge) and the PR conflicts or silently clashes with work merged in between. Today the pipeline ends at Finalise and the user resolves that by hand.

## Expected behaviour
A new stage, **Resolve conflicts**, runs after Finalise (named, never numbered; also a button on the run page to start it by hand for a PR that went stale later).
1. Fetch `main`, and rebase the run's branch onto it, so the history stays clean (a straight line on top of `main`, no merge commits). If there is nothing to resolve, finish at once and say so. Conflicts are resolved commit by commit as the rebase stops on them.
2. When there are conflicts, an agent resolves them with both sides in view: the current task's brief, spec and plan, and the briefs, specs and diffs of every task merged into `main` since the run branched (read from `git log` and the merged PRs).
3. Verify the result against commitments, not just that it builds: no acceptance criterion of the current task is broken, and no behaviour the merged tasks added is lost or changed. Run the project's full check (or the CI gate when `tests.fullSuite` is `ci`) after resolving.
4. If the resolution is safe and verified, commit and push, and say what was resolved, per file, and why.
5. If the resolution could break or deviate from the objectives of the current task or a merged one, do not push it. Stop and report the exact conflict and the doubt to the user, and offer to add a follow-up backlog item with the original slug plus the suffix `-resolve-conflict-1` (then `-2`, `-3`, and so on, the next free number), whose brief carries the conflict, both sides' intent and the open question. The user decides; nothing is added without their yes.
6. Conflicts only in documentation (`docs/`, Markdown, including `docs/backlog/index.md`) need no stop: the agent resolves them by keeping both sides' content, then commits and pushes, and lists the files in its report. Any conflict in code or tests goes through steps 3 to 5.
7. The rebase rewrites the branch, so the push is `git push --force-with-lease=<branch>:<sha of the remote branch as last fetched>`, and nothing stronger: never a bare `--force`. The lease makes the push fail if anyone pushed to the branch meanwhile; then the stage fetches, looks at what arrived, and rebases again (or stops and reports if it cannot do so safely). Before the rebase, record the remote sha so the work can be recovered; never drop either side's change to make a conflict go away.

## Out of scope
Merging the PR. Resolving conflicts in a run that is still before Finalise.

## Acceptance
- A run whose branch conflicts with a newer `main` ends with the conflicts resolved, the check green and the push done with `--force-with-lease`, with a per-file explanation.
- A conflict that contradicts a merged task's behaviour stops with a report and offers the `-resolve-conflict-N` item, with N the next free number.
- A run with no conflicts passes the stage without changes.
- A run whose only conflicts are in docs ends resolved and pushed, with no stop, and the push uses only `--force-with-lease`.
-

## Scope
- In:
- Out:

## Tests
-

## Docs
-

## Open questions
- none
