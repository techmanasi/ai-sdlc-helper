# add-setup-branch-pr

Type: feature
Priority: P2 (normal)
Source: User report: "On register, it generates some config files, I want this to be committed in a setup branch from main and create a PR, or commit itself and push or not push, after user confirms"

## Problem
`ai-sdlc-helper add` (`add()` in `src/cli/projects.ts:43-105`) can write `sdlc.config.json` and `<backlogDir>/index.md`. Today it commits them (`src/cli/projects.ts:89-102`) on whatever branch is checked out, never on a setup branch from `main`, and it cannot push or open a PR.
Verified from the code:
- Commit goes on the current branch (`git branch --show-current`), so a feature branch gets setup files mixed into it.
- No push and no PR step exists anywhere in `src/` (checked with `graft grep`).
- The interactive prompt `Commit ... ? [y/N]` at line 92-94 is dead code: `a.flag('--commit')` returns a boolean (`src/cli/args.ts:44`), so `opts.commit` is `false`, never `undefined`, when the flag is absent. Without `--commit` the user is never asked.
- A failed `git commit` (line 98) is silent: nothing is printed when `status !== 0`.
- `git commit -m` without a pathspec (line 97) also commits anything else the user had staged.
Not verified: behaviour of `gh` (not run; it would contact GitHub).

## Expected behaviour
After `add` writes files (the `done` list is non-empty), the files go to a new setup branch based on `main`, and the user decides each next step:
1. Ask `Commit <files> on a new branch chore/sdlc-setup from main? [y/N]`. On yes: commit them on that branch without touching the current checkout.
2. Ask `Push chore/sdlc-setup to origin? [y/N]`. On yes: `git push -u origin chore/sdlc-setup`.
3. After a successful push, if `gh` is installed and authenticated, ask `Open a pull request into main? [y/N]`. On yes: `gh pr create --base main --head chore/sdlc-setup` with a fixed title and body, and print the PR URL.
Each step is skipped when the previous one was declined or failed. Declining any step prints what was done and the exact git command to continue by hand.

## Decisions
- Branch: `chore/sdlc-setup`. If it already exists locally, use `chore/sdlc-setup-2`, `-3`, and so on (first free name).
- Base: the first of local `main`, `master`, then the branch `origin/HEAD` points to. If none exists, print `WARNING: no main or master branch to start the setup branch from; files not committed`, skip the commit, and still exit 0 (the registration already succeeded).
- Mechanism: a temporary git worktree (`git worktree add -b <branch> <tmpdir> <base>`) under the OS temp dir. Copy only the files in `done` into it (paths relative to the repo root), `git add -- <files>` and `git commit -q -m "chore: setup ai-sdlc-helper (<files>)" -- <files>` there, then `git worktree remove --force <tmpdir>`. The user's current branch, index and working tree are never switched or modified; local copies of the files stay in place.
- Commit message and trailers: unchanged from today (`chore: setup ai-sdlc-helper (<files>)`).
- Flags: `--commit` answers yes to step 1, new `--push` answers yes to step 2 (implies `--commit`), new `--pr` answers yes to step 3 (implies `--push`). Flags work with or without `--yes`.
- `--yes` alone never commits, pushes or opens a PR (it confirms registration and file writes only). This changes the current `--yes --commit` behaviour only in where the commit goes.
- Without a TTY (`io.ask` missing) and without flags: skip all three steps and print the manual commands.
- Fix the dead prompt: treat "flag not given" as "ask" (use `a.flag('--commit') || undefined` or an equivalent that keeps the ask path reachable).
- Failures: any failing git/gh command prints `ERROR: <command>: <stderr first line>`, stops the remaining steps, and `add` still exits 0 (the registry entry and files were already written). Never delete the branch on failure.
- PR needs `gh auth status` to exit 0; otherwise print `No authenticated gh CLI; open a pull request for chore/sdlc-setup yourself` and finish.
- PR title: `chore: setup ai-sdlc-helper`. PR body: one line listing the committed files, then `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- After a commit, print a note that the untracked local copies of the files must be removed (or the branch merged with `git merge`/`pull` will refuse to overwrite them), naming the files.

## Scope
- In: `src/cli/projects.ts` (`add`, `PROJECT_FLAGS`, `PROJECT_USAGE`); new helper `src/registry/setup-branch.ts` (branch pick, worktree commit, push, PR) so it can be tested alone.
- Out of scope: `triage` commit flow (`commitTriage` in `src/triage.ts`), `runs`/`start`, registry file format, changing which files `add` writes.

## Tests
- `test/setup-branch.test.ts` (calls the helper against real temp git repos with a bare repo as `origin`, and a fake `gh` script on PATH written the way `test/projects.test.ts` fakes programs via `pathWith`):
  - base picked: `main`, falls back to `master`, then `origin/HEAD`; none found returns a "no base" result.
  - branch name is `chore/sdlc-setup`, then `-2` when it exists.
  - commit lands only on the setup branch; the current branch HEAD, index and working tree are unchanged (including a file the user had staged, which is not committed).
  - temp worktree is removed afterwards (`git worktree list` shows one entry).
  - push puts the branch on the bare origin; push failure (no remote) reports the error and does not throw.
  - PR: fake `gh` receives `pr create --base main --head chore/sdlc-setup`; unauthenticated fake `gh` or no `gh` skips with the message.
- `test/projects.test.ts` (extend): 
  - `add --yes` alone writes files, does not commit, prints the manual commands.
  - `add --yes --commit` commits on `chore/sdlc-setup` while the checkout stays on its branch (replaces the current `--yes --commit` test).
  - interactive answers `y`, `y`, `y` run commit, push, PR in order; `y`, `n` stops after commit.
  - `--pr` runs all three without questions; `--push` implies `--commit`.
  - not-a-TTY without flags makes no commit.
- Every case runs the real code.

## Docs
- `README.md`: the `add` usage line and the paragraph on registering (new `--push`, `--pr`, the setup branch, `--yes` does not commit).
- `AGENTS.md`/`CLAUDE.md`: none.

## Open questions
- none
