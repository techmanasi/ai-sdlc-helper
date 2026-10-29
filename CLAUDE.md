# ai-sdlc-helper

Global npm package + Claude Code plugin running an AI SDLC pipeline (Spec, Plan, Red tests, Implement, Review, Ship) on any project. TypeScript ESM, Vitest, ESLint. Plan: `docs/PLAN.md`.

## Commands
- `npm run check`: lint, typecheck, test. Run before every commit and push.
- Long commands (check, build, tests): send full output to a log, e.g. `npm run check > /tmp/sdlc-$(basename $PWD).log 2>&1; echo exit=$?`. Exit 0: skip the log unless the task needs something in it (e.g. timings, warnings, coverage). Failure: grep/tail only the failing parts.
- `npm run build`: compile `src/` to `dist/`.
- `node dist/bin.js <command>`: run the built CLI.

## Rules
- Node 18+ only: no newer Node APIs (`@types/node` pinned to 18). Target projects' commands run via `src/config/node.ts`.
- Tests in `test/` exercise real code (import it or run via `test/helpers.ts`); never assert on Markdown or comments.
- User-facing prompts and skills live in `assets/`.
- Name SDLC stages, never number them.
- Worktrees: `../ai-sdlc-helper-sdlc/<slug>`.
- Work goes via PRs into `main`; confirm each merge with the user, naming the PR and its CI status.
- Subagents must not wait on runs over 5 minutes (prompt cache expires). End once code is written and let the parent run the long pipeline/e2e step, or have a script write a short result file for a fresh subagent to read.
- Use the `porter` subagent for phase or porting work. Briefs must make exploration unnecessary: name the exact files, the `docs/PLAN.md` section, and the definition of done.
