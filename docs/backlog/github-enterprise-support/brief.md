# github-enterprise-support

Type: feature
Priority: P3 (low)

## Problem
`warmCompletedPrs` in `src/runs/completed.ts` (about line 233) fills the PR statuses at server start only when origin's URL matches `/github/i`. A company GitHub Enterprise on another domain (for example `git.example.com`) is skipped (`no-github`), so the first Completed load stays slow.

Places that look at the remote or at GitHub hosts (`graft grep "github"` under `src/` and `web/server`):
- `src/runs/completed.ts` (~L233): `/github/i.test(origin.stdout)`. This is the only test of the remote's name. It is the one to fix.
- `src/runs/completed.ts` (~L460): only checks that `remote.origin.url` exists before asking `gh` about a branch. No host test, so it already works for any host `gh` knows.
- `src/fetch.ts` (L6): `DEFAULT_FETCH_HOSTS` lists `github.com`, `api.github.com` and `raw.githubusercontent.com` for what agents may read. An Enterprise host is not on it; `AI_SDLC_HELPER_FETCH_HOSTS` is the workaround.
- Everything else in `src/pipeline/finalise.ts`, `ci.ts`, `prsync.ts`, `view.ts` and `web/server/index.ts` goes through `gh` and mentions GitHub in comments only.

## Goal
A project whose origin is a GitHub Enterprise host gets the same start-up PR fill as one on github.com, with no setup beyond what `gh` already has.

## Idea
- Ask `gh` which hosts it is logged in to (`gh auth status`, plus `GH_HOST` when set) and treat origin as GitHub when its host is on that list. Cache the answer for the server's life.
- Or, as a fallback or alternative, a config option listing GitHub hosts (for example `github.hosts` in settings).
- Offer the host list to the agent fetch allowlist too, or document `AI_SDLC_HELPER_FETCH_HOSTS`.
- Keep `skipped: 'no-github'` for a remote on no known host, and keep the `no-gh` case separate.

## Acceptance criteria
- Origin `https://github.com/o/r`, `git@github.com:o/r.git` and an Enterprise host that `gh` is logged in to are all recognised.
- A remote on an unknown host still returns `skipped: 'no-github'`.
- `gh` missing or not logged in returns a clear skip, with the reason in the registry's `errors.log`.
- Tests with a fake `gh` and several remote URL forms (https, ssh, with a port).
- The decision about the fetch allowlist is made and written in the PR.

## Out of scope
- Other hosts (GitLab, Bitbucket).
- Logging in to `gh` for the user.

## Docs
-
