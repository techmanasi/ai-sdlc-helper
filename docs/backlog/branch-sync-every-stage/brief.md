# Branch sync before every stage (draft analysis)

Type: improvement · Priority: P1 · Status: decided 2026-11-15, being implemented.

## Goal

Before each stage starts, the run's branch is in a known state: it exists where it should, it belongs to this
task, and it holds every commit GitHub's copy has. Nothing is lost on the way. Uncommitted work, local commits
and GitHub's commits are all kept, or the run stops and says exactly where each one is.

## What exists today (to reuse, not rebuild)

| Piece | Where | What it already does |
|---|---|---|
| Worktree and branch setup | `start()`, `src/runs/index.ts:282` | Reuses the worktree, else the local branch, else `-b sdlc/<slug>` from the base. Fetches origin only for Resolve conflicts. Refuses an item already merged (`isMerged`). |
| Push check | `ensurePushable`, `src/pipeline/push-check.ts:284` | After Plan and before CI/pushes: fast-forward, lease push for rewritten same commits, rebase when diverged (backup branch first), else moves the run to `<slug>_<n>` from `origin/main`. Conflicts with the base run Resolve conflicts inline. |
| Inline Resolve conflicts | `resolveConflictsStage(ctx, { inline })`, `src/pipeline/resolve-conflicts.ts:910` | Callable from any stage: the run page shows it, then the calling stage again; a stop resumes at the caller. Only rebases onto the base. |
| Resolver agent | `resolverFor` (`:773`), `assets/prompts/prompt-resolve-conflicts.md` | Per conflict: context file, report with `VERDICT: SAFE / DOUBT`; DOUBT is reviewed by a second model (`prompt-resolve-review.md`, `prompt-resolve-judge.md`). The prompt assumes a rebase in progress onto the base. |
| Lease push | `leasePush`, `resolve-conflicts.ts:197` | `--force-with-lease=<branch>:<expected sha>` (explicit sha, so a fetch can't defeat the lease). |
| Clean-up of a stuck git state | `abortAll`, `inRebase` | Aborts a rebase, merge or cherry-pick left in progress. |

## Review of the proposed flow

| Step | Drawback or gap | Proposed change |
|---|---|---|
| 1. No branch locally or on origin: create one | The branch may have existed and been deleted after its PR merged or closed. Creating it again redoes finished work. | Before creating: check the PR linked to the task (brief `pr:`, run record `pr`, `gh pr list --head`). Merged: refuse (as `isMerged` does). Closed: stop and ask. |
| 2. Only on origin: verify it belongs to the task, check it out | "Belongs to the task" needs a rule. | Belongs when either: the task's linked PR has this head branch, or the branch has a pipeline commit with this task's scope (`[red-tests] test(<slug>)`, `chore(<slug>)` …), or it has no commits beyond the base (fresh). Otherwise foreign: refuse, offer a new `<slug>_<n>` branch. Check it out with a tracking local branch. |
| 3. Only local: verify, push | Pushing at every stage start triggers CI, and before Red tests it pushes a branch with nothing in it. It also ignores "Create PR off". | Don't push at stage start. Pushes stay where they are today (Red tests onward, through the push check). Stage start only fetches and reconciles. |
| 4. Otherwise: create, push, draft PR | Overlaps step 1. A draft PR at Spec is earlier than today (Red tests opens it for CI) and conflicts with must-fix #3 (Create PR off). | Fold into step 1. The draft PR stays where it is today. |
| 5. Local branch, clean tree | Before Red tests the tree is never clean: Spec and Plan don't commit; their docs are committed first by Red tests (`stages.ts:299`). Implement and Test repair also leave uncommitted work until their gate commits. | Treat "uncommitted" by who made it (see below), not as one case. |
| 5.1 Same as origin: continue | None. | Keep. |
| 5.2 Origin ahead: pull, fast-forward | A plain `pull` can make a merge commit. | `merge --ff-only origin/<branch>` (as the push check does). |
| 5.3 Local commits or local changes | Two different cases mixed. "Fast-forward with a pull" is impossible when local has commits; it needs a rebase. Committed and uncommitted need different tools. | Split into 5.3a (uncommitted only), 5.3b (local commits, origin not ahead), 5.3c (both sides have commits); see the table below. |
| Push with `--force-with-lease` | A bare `--force-with-lease` uses the remote-tracking ref, which the fetch just updated: it no longer protects anything. | Always `--force-with-lease=<branch>:<sha seen before the rebase>` (`leasePush` already does). Only after a rewrite; a fast-forward needs a plain push. |

## Full case matrix

Local = the run's worktree or local branch. Remote = `origin/<branch>` after a fetch.

| # | Local | Remote | Tree | Action | Push? |
|---|---|---|---|---|---|
| A | none | none | – | Check the linked PR (merged → refuse, closed → ask), then create from the base | No |
| B | none | exists, belongs | – | Worktree with a tracking branch from `origin/<branch>` | No |
| C | none | exists, foreign | – | Stop: "origin's `<branch>` has no commits from this task"; offer `<slug>_<n>` | No |
| D | exists | none, never pushed | any | Continue | No (pushed later as today) |
| E | exists | none, but was pushed (upstream set, or PR exists) | any | PR merged → refuse. PR closed or branch deleted by hand → stop and ask: push again or start a new branch | No |
| F | = remote | same sha | any | Continue | No |
| G | behind | ahead | clean | `merge --ff-only` | No |
| H | behind | ahead | dirty, ff allowed | `merge --ff-only` (git keeps the changes when no file overlaps) | No |
| I | behind | ahead | dirty, ff refused | Stash (see rules), ff, reapply; reapply conflict → resolver (stash mode) | No |
| J | ahead | behind | any | Continue; the stage's own push sends the commits | No (later) |
| K | diverged, same patches | – | clean | Backup branch, lease push (push check `same-commits`) | Yes |
| L | diverged | – | clean | Backup branch, rebase onto `origin/<branch>`; conflict → resolver (branch-sync mode) | Yes, lease |
| M | diverged | – | dirty | Stash, then as L, then reapply as I | Yes, lease |
| N | any | fetch fails | any | Continue offline, say so on the run page; refuse any rewrite or lease push until a fetch succeeds | No |

## Uncommitted changes: who made them decides what to do

| Source | How to tell | Resume the same stage | Start from an earlier stage |
|---|---|---|---|
| The current stage's agent, interrupted | Run record: last stage = this stage, interrupted | Reapply: the agent continues | Keep in a stash, don't reapply (the earlier stage redoes it); say where it is |
| Spec/Plan docs not yet committed (before Red tests) | Files under the task's docs folder | Reapply | Reapply only the docs of stages before the restart point |
| The user's own edits | Anything else | Reapply; on conflict stop and ask (never let the resolver decide over the user's edits silently) | Same |
| Pipeline run files (logs, status) | Under `ctx.log`, ignored files | Never stashed | Never stashed |

Stash rules:
- Name every stash `sdlc:<slug>:<stage>:<time>` and keep its **sha** in the run record. `refs/stash` is shared by
  every worktree of the repo, so `stash@{0}` may be another run's or the user's: never pop by index.
- Include untracked files (`-u`): an interrupted agent's new files block a fast-forward that adds the same path.
  Exclude ignored files and the run's log folder.
- Drop the stash only after the reapply succeeded and the result was checked. On any failure keep it, name it in
  the output and errors.log, and show "Apply my saved changes" in the recovery panel.

## More edge cases

| Edge case | Risk | Handling |
|---|---|---|
| A rebase, merge or cherry-pick left in progress (killed Resolve conflicts) | Every git step fails or acts on a half state | First step of sync: detect (`inRebase` etc.). If the last run was Resolve conflicts, resume it; else `abortAll` and log it |
| Detached HEAD in the worktree | Commits land on no branch | Re-attach to the run's branch when HEAD equals or is ahead of it; else stop, naming the sha |
| The branch is checked out in another worktree (the main checkout) | `worktree add` fails | Use that worktree only if it is the run's own; else stop: "`<branch>` is checked out in `<path>`" |
| A parallel run or a Sync PR on the same task | Two writers race | The running-record check already refuses a second run. Sync PR writes only to the worktree while running (#156). Keep both |
| The run moved to `<slug>_<n>` | Sync uses the wrong branch | Branch precedence: the worktree's checked-out branch > run record > status `movedFrom/to` > linked PR's head > `sdlc/<slug>` |
| Incoming commits change the locked test files | The red gate and test lock are bypassed | After the sync, diff test files between the old and new lock point. If changed: stop and ask, or resume at Red tests |
| Incoming commits change spec, plan or brief after those stages | Later stages work from a different spec | List the incoming files in the output. If the docs of a finished stage changed: warn and offer "Resume at Spec/Plan" |
| A rebase rewrites the red-tests commit | Stored shas go stale | Recompute `origRedSha`, `redSha`, `lockSha` after any rewrite (Resolve conflicts already does) |
| GitHub branch protection or a refused lease push | Push fails after a local rebase | Keep the rebased result; the backup branch has the old one; log it and offer Retry push |
| Force-pushed origin (history rewritten elsewhere) | Looks like diverged | Same-patch check (case K). Otherwise case L with a backup branch, so nothing is lost |
| The base moved (`main`) | Not this feature's job | Don't rebase onto the base at stage start (shas change, CI runs again). Keep that in the push check before pushes |
| Submodules, LFS | Stash and rebase behave differently | Out of scope: detect and stop with a message |
| Fetch cost | One fetch per stage | One `git fetch origin <branch>` (~1 s). Skip the fetch for a branch never pushed (D) |

## Fitting the conflict resolver in

One resolver function and agent, with a **mode** that picks the prompt and the context file:

| Mode | When | Git state the agent sees | Prompt file (new unless noted) |
|---|---|---|---|
| `base` | Branch conflicts with the base (today) | Rebase onto `origin/main` in progress | `prompt-resolve-conflicts.md` (existing) |
| `branch-sync` | Local and GitHub's copy of the run's branch diverged (L, M) | Rebase onto `origin/<branch>` in progress | `prompt-resolve-branch-sync.md` |
| `stash` | Reapplying saved uncommitted work conflicts (I, M) | Files with conflict markers, no rebase; stash kept | `prompt-resolve-stash.md` |

Shared parts go in `assets/prompts/parts/` (`resolve-rules.md`: never drop a side, never weaken a test, edit only
conflicted files, no git commands that change anything; `resolve-report.md`: the FILE/VERDICT/DOUBT format), so the
three prompts differ only in what each side means.

What each mode's context file adds (written by `writeContext`):
- **branch-sync:** the incoming commits from GitHub (sha, author, subject, files), which of them came from the pipeline
  (`chore(<slug>): sync PR comments`, CI failure report) and which from people (suggestions, "Update branch", other
  machines); the local commits not pushed and why (last push error from errors.log). Rule in the prompt: a person's
  commit on GitHub is a deliberate change: keep it unless it breaks an acceptance criterion; then DOUBT.
- **stash:** which stage made the uncommitted work (from the run record), the stage being started, and the incoming
  commits that touch the same files. Rule: the user's own edits win unless they contradict the spec; then DOUBT. An
  interrupted agent's half-written files may be dropped in favour of the incoming version only when the stage is about
  to redo them; say so per file.

Stage-start wiring:
- New `syncBranch(ctx, { caller, resume })` called by the stage runner (`src/pipeline/run.ts`) before every stage,
  and by `ensurePushable` before pushes (so both use one ladder).
- A conflict calls `resolveConflictsStage(ctx, { inline: { resume, caller }, mode })`. The run page shows
  "Resolve conflicts (branch sync)" or "(saved changes)", then the caller's stage again.
- DOUBT, or a failed check after resolving: stop with nothing pushed and the stash kept. The recovery panel offers
  Resume at the caller, Use GitHub's copy (local commits kept on a backup branch), Apply my saved changes.
- The resolver runs only for code and test conflicts. Documentation and pipeline files (`pr-comments.md`,
  `ci-failure.md`, the brief's `pr:` line) resolve mechanically: GitHub's version wins for pipeline-written files.

## Decisions (user, 2026-11-15) — these override anything above that says otherwise

`syncBranch` is one generic start step that runs before **every** stage, including Spec of a fresh task.

1. **Fresh task (start at Spec):** create the branch from `origin/<base>` and push it at once. Uncommitted changes are
   expected only here (the copied brief and settings).
2. **Spec and Plan commit and push their docs** at the end of their stage (`[spec] docs(<slug>): …`,
   `[plan] docs(<slug>): …`); CI runs lint only for Markdown-only pushes. The draft PR is opened at the first push that
   has changes beyond the base (after Spec), not at branch creation. "Create PR off" still never marks it ready.
   Red tests then commits only tests (and its own docs); every reader of the red-tests commit must still find it.
3. **A branch that is gone, merged or closed:** never reused. Merged or closed PR, or origin's branch deleted after a
   PR: start a new branch `<slug>_<n>` from `origin/<base>` (no question). Case C (foreign branch) does the same.
4. **Local and GitHub's copy both moved:** `git pull --rebase origin <run branch>` (rebase the local commits on top of
   GitHub's copy of the same branch; never a merge commit). Conflicts go to the resolver (branch-sync mode); the
   resolved branch is pushed with a lease. Rebasing onto `origin/<base>` stays in the push check before pushes (see
   "Base branch moved").
5. **Lease:** re-evaluated (see "Lease choice" below): keep the explicit expected sha.
6. **Stash:** `git stash push -u -m "sdlc:<slug>:<stage>:<time>"`, then find it by that unique message (never by
   index), save its sha in the run record and pin it with a ref `refs/sdlc/stash/<slug>/<time>` so it survives a drop
   or a `git stash clear`. Apply with `git stash apply <sha>`; after success drop the matching entry (by sha) and the ref.
7. **Stuck git state:** a rebase (or merge, cherry-pick) in progress is aborted first, before anything else, and
   logged to errors.log and the run output.
8. **Branch checked out elsewhere** (not the run's own worktree `../<repo>-sdlc/<slug>`) and blocking: make a new
   branch `<slug>_<n>` from that branch's tip and continue there.
9. **The run record always holds the branch name** (`branch` field), updated on every move; it is the first source
   when choosing the branch.
10. **Locked tests changed by incoming commits:** stop and ask; the recovery panel offers Restart at Implement.
11. **Spec or plan changed by incoming commits:** warn and offer Resume at Spec / Resume at Plan; the run goes on.
12. **Rewritten commits:** recompute `origRedSha`, `redSha`, `lockSha` after any rebase.
13. **Fetch fails:** continue offline with a warning on the run page; no rebase, no lease push until a fetch succeeds.
14. **Base branch moved:** left to the push check before pushes.
15. **Uncommitted edits conflicting with GitHub's copy:** the resolver (stash mode) tries first; the run stops only on
    `VERDICT: DOUBT` or a failed check, with the stash kept.
16. **One PR** for all of this, resolver modes and prompts included.

## Lease choice

| Option | Safe after our own fetch? | Safe against a background fetch (IDE)? | Git version |
|---|---|---|---|
| bare `--force-with-lease` | No: compares with the ref the fetch just updated | No | any |
| `--force-with-lease --force-if-includes` | Yes, if the local branch's reflog contains the remote tip | Yes | 2.30+ |
| `--force-with-lease=<branch>:<sha>` (today, `leasePush`) | Yes: compares with the sha we saw before rewriting | Yes | any |

The explicit sha is the best fit: the pipeline knows exactly which remote commit it rebased onto, it works on every git,
and it doesn't depend on reflogs (which a fresh worktree or `git gc` can lack). Keep it; record the sha in the
attempts log so a refused lease is explained.

## Tests (one per row, in real git repos with a bare origin)

- Cases A–N, each started from two different stages (e.g. Plan and Implement).
- Stash: reapply clean; reapply conflict resolved by a fake resolver; DOUBT stop keeps the stash; another worktree's
  stash at `stash@{0}` is never touched.
- In-progress rebase from a killed Resolve conflicts is detected first.
- "Restart Implement with the CI failure" with local tests and no worktree: `ci-failure.md` is in the worktree
  before the agent starts and the later push succeeds.
