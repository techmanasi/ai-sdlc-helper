# Plan: UI refresh, run metrics and notifications

Written 2026-11-17. Status: the four branches are pushed; their PRs target the feature branch `feat/ui-refresh`,
which merges to `main` once all are in. This plan was written after the code (it should have come first); it
records what was built, why, and what is left.

## Context

You asked for a release-readiness review, an orchestrator brainstorm, the USP and whether the UI shows it, a better
view of red-test locking and stage steps, cost/token metrics per stage, notifications, and a large visual and speed
improvement. Mid-way you asked for **separate PRs into a feature branch, merged to `main` once all are in**.

Each piece is one commit on its own branch off `feat/ui-refresh`.

Checked before pushing: `tsc` clean for the root, `web` and `web/ui`; ESLint clean on `web` and the touched files;
60 tests pass across the five touched test files; `npm run build` succeeds; the built app was opened in Chrome
(board, run page, light and dark). The full suite runs in CI.

## Findings (the analysis you asked for)

### Release readiness: not ready for a wider release; four blockers
Critical:
1. **Review findings are never acted on** (must-fix item 2, still open; PR #159 is a draft and failing on all jobs).
2. **README sends users to the wrong repo**: install lines use `imaimai86/ai-sdlc-helper` (a separate, stale repo);
   the real one is `techmanasi`. Same in `docs/RELEASING.md` and `docs/PLAN.md`. README also says the npm release
   "comes next" (0.1.1 is published), says Settings are read-only (they are not), lists 6 stages (there are 8), is
   titled "Dark Factory", and omits `gh` from Requirements.
3. **CHANGELOG `[Unreleased]` is empty** after 109 commits since v0.1.1, including a behaviour change (a usage limit
   now stops the run unless `SDLC_LIMIT_RETRY` is set).
4. **`main` has a recurring flaky test** (`test/step-progress.test.ts`, the 1 ms wall-clock check). PR #152 fixes it
   and is green but unmerged.

Good to have: no Claude Code plugin although `docs/PLAN.md` promises one; `doctor` does not check `gh` or logins;
sync-progress key uses a Project object (`[object Object]/slug`, `web/server/index.ts:341,431,459`); sign-in token
compared without constant time (`index.ts:620`); codex gets broader rights than claude under `acceptEdits`;
13 dev-only Dependabot alerts; Node 18 is EOL; the release smoke test never starts `ui`; Windows untested; PR #91
is stale and conflicting; plus the 16 items in `docs/good-to-have.md`.
Fine: packaging, release automation with provenance, CI matrix, server binding/Host/Origin/token checks, command
palette (argv, no shell), agent permission allowlist, zero TODO/FIXME.

### USP, and whether the UI shows it
USP: **AI writes the code, but cannot grade its own homework.** Tests are written first, proven failing, then
locked; every stage is checked before the next; every stop comes with a cause and three ways on; each item runs in
its own worktree and ends as a CI-green PR. Before this work the UI showed almost none of it: "Red tests" was just a
column name, the lock was invisible, gates were only lines in `run.out`, and only the recovery card carried a tag.
The new run page states all four as live facts (see PR D).

### Orchestrator agent: recommended, but as its own backlog item, not in this batch
- For: removes the "go look at each pause" chore; `SDLC_AUTO_ACCEPT` today is a fixed "accept", not a judgement;
  the hooks exist (`StageRecovery` already gives a diagnosis and an auto action; `answerQuestions`, `decide`,
  `start --from` are library calls; the end state is written in one place in `src/pipeline/run.ts`).
- Against: it can approve the very thing a gate exists to stop (refused permissions, test-repair claims, weak spec
  answers: see good-to-have item 16); it spends tokens on retries with no cap unless one is built; a wrong answer at
  Spec is expensive five stages later; it overlaps the "parallel reviewers on doubt" design in `docs/redesign/`.
- Recommended shape: off by default; a try limit per pause kind and a spend cap; it may answer questions, retry
  transient failures and resume, but may **never** allow a protected-path permission, accept a test-repair claim, or
  bypass a gate; every decision is logged to `decisions.md` and shown on the run page; when out of tries it stops
  and notifies you (the notification work in PR C is the channel). Not written up as a backlog brief yet.

## The PRs

Feature branch: **`feat/ui-refresh`**. Each PR below branches from it and
targets it; files do not overlap, so they can merge in any order. CI runs on every PR (`pull_request` has no branch
filter). Each merge is confirmed with the owner, naming the PR and its CI status. Last, one PR
`feat/ui-refresh` → `main`.

| PR | Branch | Files | What it does |
|---|---|---|---|
| A | `feat/run-metrics` | `src/pipeline/{observe,agent,status,stages,run}.ts`, `src/runs/{timeline,view}.ts`, `src/index.ts`, `test/{timeline,observe,step-progress}.test.ts` | Per agent round: input/output/cache tokens and cost. New rows in `attempts.jsonl`: stage start, each step, run end, test lock, guard stop. `RunView.timeline` (stages with steps, time, usage; the lock; totals). |
| B | `feat/static-serving` | `web/server/http.ts`, `web/ui/index.html`, `web/ui/public/favicon.svg`, `test/static-serving.test.ts` | Brotli/gzip, `immutable` for hashed assets, ETag/304, symlink check, no Google Fonts request, theme set before first paint, favicon. JS on the wire: 145 KB → about 51 KB. |
| C | `feat/notifications` | `web/ui/src/notify.ts`, `web/ui/src/App.tsx`, `test/notify.test.ts` | Bell in the top bar: desktop notification and/or sound (volume, per event, only-when-hidden), tab title and favicon badge. Also the app shell: sign-in screen instead of a red error, loading skeleton, status chips, menu icons. |
| D | `feat/run-page-board` | `web/ui/src/{styles.css,Run.tsx,Board.tsx,RunInsights.tsx,insights.ts,api.ts,ui.tsx}`, `test/insights.test.ts` | New look (tokens, system fonts, chips). Run page: four-guarantee strip, stage rail with per-stage steps/time/tokens, test-lock panel, cost table, recovery as three cards, output panel that redraws alone and follows the log. Board: rows with a stage strip and All/Running/Needs you/Failed filters. |

Notes:
- C uses a few CSS classes that live in D (`styles.css` is one file). Until D merges, C's shell is functional but
  plainly styled; on the feature branch they come together.
- D reads `timeline` as optional, so it works before A merges (older runs show stages and tokens from agent rounds;
  steps, cost and guard events appear for runs made after A).

## Steps

1. Open PRs A to D and this plan's PR against `feat/ui-refresh`; watch CI; fix failures on the PR's own branch.
2. Merge each on the owner's yes.
3. Open `feat/ui-refresh` → `main` with a CHANGELOG `[Unreleased]` entry for this work; merge on the owner's yes.

## Known gaps
- Guards stop the run rather than restore the tests, so the lock panel says "the run stopped there".
- Harnesses other than claude report no cost; the table shows a dash, never a zero.
- No code splitting: the bundle is small and compression gave the larger win.
- Not done: the stage popovers, parallel reviewers and searchable picker changes from `docs/redesign/`; Completed,
  Projects, New item and Settings keep their layout and only inherit the new tokens.
- "Resume from <stage>" still shows on a finished run (good-to-have item 1); left alone as a behaviour change.

## Verification
- Per PR: `npx tsc --noEmit`, `npx tsc -p web --noEmit`, `npx tsc -p web/ui --noEmit`, `npx eslint` on touched
  files, `npx vitest run` on that PR's test files; the full suite and e2e in GitHub Actions.
- On the feature branch after all four merge: `npm run build`, start `ui`, and in Chrome check the board (filters,
  empty state), a finished run (rail, lock, cost table), a failed run (recovery cards), light/dark, a narrow window,
  the bell (permission prompt, chime), and response headers for `/assets/*` (`content-encoding`, `immutable`).
- One real pipeline run on the feature branch to see step rows, the lock row and cost appear live.
