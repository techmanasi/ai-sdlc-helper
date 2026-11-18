# inspect-run-docs-anytime

Type: feature
Priority: P2 (normal)
Source: report: "I want to see and inspect the brief, spec, and plan, agent questions and answers at any point of time, before, during and after execution."

## Problem
The web UI's Run page and Completed view do not show a run's documents at every point of its life:

- The Brief panel shows only before a run starts: `web/ui/src/Run.tsx:929` renders it under `v.state === 'not started'`, and the text comes from `api.brief`, which reads the main checkout's `brief.md` (`web/server/index.ts:323-327`), not the run's copy.
- Answered questions disappear from the page. `recordAnswers` (`src/pipeline/stages.ts:141-157`) appends each answered round to `decisions.md` as `## Round <n> (<date>)` followed by the `### Q<n>` blocks, then deletes `questions.md`. The questions panel (`web/ui/src/Run.tsx:762`) renders only `v.questions`, parsed from `questions.md` (`src/runs/view.ts:343`), so earlier rounds and their answers are visible only by opening `decisions.md` by hand as raw text.
- Once a run has no worktree (finished and cleaned up, or started elsewhere), `runView` sets `docsDir` to the main checkout's item folder (`src/runs/view.ts:337`) and `docs: docFiles(docsDir)` (`src/runs/view.ts:414`, `docFiles` at `src/runs/view.ts:250-257`) lists only what the main checkout holds. Until the PR merges and is pulled, that is just `brief.md`, so `specs-1.md`, `plan-1.md`, `decisions.md` and the other files committed on the run's branch are missing. The file route (`GET /api/runs/<slug>/file`, `web/server/index.ts:337-340`, through `itemFile` at `web/server/index.ts:211-218`) also reads only from disk, so they cannot be opened either.
- The Completed view's detail (`completedDetail`, `src/runs/completed.ts:445`) shows only the main checkout's `brief.md` (`web/ui/src/Completed.tsx:453`), with no spec, plan or questions.

`readRunDoc` (`src/runs/run-docs.ts:141`) already reads one run doc in the right order: the worktree's copy, then the branch on origin, then the local branch, then the main checkout, cached on a ref stamp. The views do not use it for the document list or the file route.

Verified by reading the code at the lines above. Not reproduced in a running UI.

## Expected behaviour
On the Run page, for any run state (not started, running, paused, done, failed, interrupted, stopped, refused) and for a run with or without a worktree:
- A Brief panel shows the run's `brief.md`.
- A "Questions and answers" panel lists every answered round from `decisions.md`, oldest first, each with its questions, suggested answers and the answer given. Open questions from `questions.md` still show in the existing answer form above it.
- The Documents list shows the run's files (brief, spec, plan, test cases, decisions, review…), and each one opens.

On the Completed view, a finished task's detail shows the same Documents list and the same answered rounds, read from the run's branch when the main checkout does not have them yet.

## Decisions
- Read order for every run document (list, open, brief, rounds), everywhere in this item: the run's folder (`v.dir`: its worktree, or the main checkout for a run started in place), else the run's branch (`refs/remotes/origin/<branch>`, then `refs/heads/<branch>`), else the main checkout's item folder. This is `readRunDoc`'s order; reuse it and do not write a second resolver.
- Document list without a run folder: a new exported function in `src/runs/run-docs.ts`, `listRunDocs(ctx, slug): string[]`, returns the item's files from the first source that has the item folder: `git ls-tree -r --name-only <ref> -- <backlogDir>/<slug>/` on origin's branch, then the local branch, else `docFiles` on the main checkout's folder. Paths are relative to the item folder, top-level files sorted first, then `logs/…` sorted, which is the order `docFiles` uses today. Cache it on the same ref stamp `readRunDoc` uses (`refStamp`). With a run folder, `runView` keeps calling `docFiles` on it.
- `runView` (`src/runs/view.ts:320`) sets `docs` from `listRunDocs` when `dir` is null, and from `docFiles(docsDir)` otherwise.
- The file route `GET /api/runs/<slug>/file?path=<rel>`: with a run folder, it reads from disk as today. Without one, it returns `readRunDoc(ctx, slug, rel)`. Checks run in this order: an empty `rel` or one that leaves the item folder gives HTTP 400 `not a file of <slug>: '<rel>'` (the existing `HttpError` text); a file no source has gives HTTP 404 `no file <rel> for <slug>`. The response body stays `{ path, text }`.
- New `RunView` field `brief: string | null`: the run's `brief.md` through the read order (the existing `runDoc` helper at `src/runs/view.ts:340`). The Run page's Brief panel uses `v.brief` and shows in every state. It is open by default when the state is `not started` and collapsed otherwise. With `v.brief === null` it shows the existing text "No brief.md for this item.". `GET /api/backlog/<slug>` is not changed.
- New `RunView` field `rounds: QuestionRound[]`, with `interface QuestionRound { round: number; date: string; questions: Question[] }`, exported from `src/runs/view.ts`. A new exported `parseRounds(text: string): QuestionRound[]` splits `decisions.md` on `## Round <n> (<date>)` headings and runs the existing `parseQuestions` on each section. `date` is the text in the parentheses, or `''` when there are none. Text before the first heading is ignored. A file with no round headings, or no `decisions.md`, gives `[]`. `decisions.md` is read through the read order.
- The Run page shows the "Questions and answers" panel only when `v.rounds.length > 0`: one block per round, headed "Round <n> · <date>", each question as "Q<n> · <title>", its body, "Suggested: …" and "Answer: …". An empty answer shows "(no answer)". The panel is read-only. The answer form for open questions (`v.questions`) is unchanged.
- Rendering logic (grouping, labels, open/collapsed default) lives in a plain module `web/ui/src/run-docs.ts`, so it can be tested without a DOM. `Run.tsx` and `Completed.tsx` call it.
- Completed view: `CompletedTaskDetail` (`src/runs/completed.ts`) gains `docs: string[]` (from `listRunDocs`, or `docFiles` on the worktree when there is one) and `rounds: QuestionRound[]` (from `decisions.md` through `readRunDoc`). Its `brief` comes through `readRunDoc` too, so a task whose PR has not merged shows the branch's brief. `Completed.tsx` shows a Documents panel listing `docs` and a "Questions and answers" panel. Clicking a document opens it through the existing `GET /api/runs/<slug>/file` route and renders it with the existing `Markdown` component, rendered and source views as on the Run page.
- Reading never writes: no route in this item changes the worktree, the branch, the main checkout or the run register. A failed git read (no branch, no remote) falls through to the next source and is not an error.
- Node 18 APIs only. No new package.

## Scope
- In: `src/runs/run-docs.ts` (`listRunDocs`), `src/runs/view.ts` (`brief`, `rounds`, `parseRounds`, `QuestionRound`, the `docs` source), `src/runs/completed.ts` (`CompletedTaskDetail.docs`, `rounds`, brief through `readRunDoc`), `src/index.ts` exports, `web/server/index.ts` (`itemFile` and the `file` action), `web/ui/src/api.ts` types, `web/ui/src/run-docs.ts` (new), `web/ui/src/Run.tsx` (Brief panel in every state, Questions and answers panel), `web/ui/src/Completed.tsx` (Documents and Questions and answers panels).
- Out of scope: editing any document from these views; how `recordAnswers` writes `decisions.md` or the `questions.md` format; the answer form and its routes; the Backlog edit route and `GET /api/backlog/<slug>`; the CLI; diffs between document versions or per-stage history; listing the `logs/` folder from the branch beyond what the branch has committed.

## Tests
- `test/view.test.ts`:
  - `parseRounds`: two rounds give two entries in file order with round numbers, dates and every question's title, body, suggested and answer. A round heading with no date gives `date: ''`. Text before the first heading is ignored. No headings, or an empty string, gives `[]`.
  - `runView` on a run with a worktree: `brief` is the worktree's `brief.md` even when the main checkout's copy differs; `rounds` comes from the worktree's `decisions.md`; `questions` still comes from `questions.md`.
  - `runView` on a run with no worktree whose branch (a real temporary git repo, created as the existing tests do) holds `specs-1.md`, `plan-1.md` and `decisions.md` that the main checkout lacks: `docs` lists them, `brief` is the branch's, `rounds` is parsed from the branch's `decisions.md`.
  - `runView` with no worktree and no branch: `docs` falls back to the main checkout's folder, and `rounds` is `[]` when there is no `decisions.md`.
- `test/run-docs.test.ts` (new, or the existing file covering `readRunDoc` if there is one): `listRunDocs` prefers origin's branch over the local branch, falls back to the main checkout, sorts top-level files before `logs/…`, and gives a new list after the branch ref moves (the cache is keyed on the ref stamp).
- `web/test/server.test.ts`: `GET /api/runs/<slug>/file?path=plan-1.md` for a run with no worktree returns the branch's text. `path=../x` gives 400. A path no source has gives 404. `GET /api/runs/<slug>` returns `brief` and `rounds`.
- `test/completed-load.test.ts` (or `test/finalise-and-completed.test.ts`, whichever builds completed details): a completed task whose PR has not merged has `docs`, `rounds` and `brief` from its branch.
- `web/test/run-docs.test.ts` (new) for `web/ui/src/run-docs.ts`: round labels ("Round 2 · 2026-11-14"), "(no answer)" for an empty answer, the Brief panel open for `not started` and collapsed for other states, and the Questions and answers panel hidden with zero rounds.
- Every case runs the real code (they import or run the code under test). Never list a test that reads or asserts on documentation; put documentation under `## Docs`.

## Docs
- `README.md`: in the web UI section, say that the Run page and the Completed view show the brief, the documents and every answered question round at any point of a run, read from the run's branch until it merges.

## Open questions
- none
