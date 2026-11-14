<!-- graft:start -->
## Graft — repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->

# ai-sdlc-helper

Global npm package + Claude Code plugin running an AI SDLC pipeline (Spec, Plan,
Red tests, Implement, Review, Ship) on any project. TypeScript ESM, Vitest,
ESLint. Plan: `docs/PLAN.md`.

## Commands
- `npm run check`: lint, typecheck, test. The **full suite runs in GitHub Actions
  CI, not locally** (2026-11-12): run only the targeted tests for the files you
  touched, then push a branch and let `gh run watch` report the full run.
- Long commands (check, build, tests): send full output to a log, e.g.
  `npm run check > /tmp/sdlc-$(basename $PWD).log 2>&1; echo exit=$?`.
  Exit 0: skip the log unless the task needs something in it (e.g. timings,
  warnings, coverage). Failure: grep/tail only the failing parts.
- Markdown-only changes: run `npm run lint` only. CI skips the test matrix and
  e2e for Markdown-only PRs; `lint.yml` still runs so docs PRs get a check.

## Rules
- Node 18+ only: no newer Node APIs (`@types/node` pinned to 18). Target
  projects' commands run via `src/config/node.ts`.
- Tests in `test/` exercise real code (import it or run via `test/helpers.ts`);
  never assert on Markdown or comments.
- User-facing prompts and skills live in `assets/`.
- Name SDLC stages, never number them.
- Worktrees: `../ai-sdlc-helper-sdlc/<slug>`.
- Work goes via PRs into `main`; confirm each merge with the user, naming the PR
  and its CI status.
- Subagents must not wait on runs over 5 minutes (prompt cache expires). End
  once code is written and let the parent run the long pipeline/e2e step, or
  have a script write a short result file for a fresh subagent to read.
- Use the `porter` subagent for phase or porting work. Briefs must make
  exploration unnecessary: name the exact files, the `docs/PLAN.md` section,
  and the definition of done.
- Never push fix commits onto a `sdlc/<slug>` PR: diagnose and report CI
  failures there; fix the tool on your own branches instead.
- Never `pkill`/`killall` by name to stop tests. Stop only background tasks
  this session started; the user's pipeline runs share the machine. Check
  `.git/sdlc-runs/*.json` and `../ai-sdlc-helper-sdlc` before heavy test runs.

## Agent memory
Project memory imported from Claude Code lives in `.opencode/memory/`. Read
`.opencode/memory/MEMORY.md` at the start of non-trivial work, then open only
the linked files the task needs (lazy-load; do not preload everything). Update
or add a memory file when the user gives durable feedback or a project state
changes.
