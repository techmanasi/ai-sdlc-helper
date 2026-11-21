# Review round 3: ui-code-indexer-setup

**Verdict: pass**

## Round 2 blocker: fixed
- **Graphify install copy.** `installOf` in `web/ui/src/codeSearchSetup.ts` now cuts at the first ` (` or `,`. Copy gives `uv tool install graphifyy`. The pipx alternative and the build step stay in `copyInstructions`. A test in `web/test/code-search-ui.test.ts` covers this with the real `CODE_INDEXERS.graphify.setup`.

## Acceptance criteria
- **Inspection API.** Covered by `web/test/code-search-route.test.ts`. It checks the schema, installed/indexed graft, a missing binary giving `canBuild: false`, Graphify giving `canBuild: false`, and a missing declared builder.
- **Setup API.** Covered by `web/test/code-search-route.test.ts`. It checks a build and rebuild with cwd and env, configure-only with no spawn, refusal when `canBuild` is false, and a nonzero exit (exact error, both streams, config unchanged). It also checks a signal kill, the timeout, a guard held until the child exits, overlap, and a concurrent edit being kept.
- **Doctor, Settings and Modal UI.** The code is in `Projects.tsx`, `Settings.tsx` and `CodeSearchModal.tsx`. The decisions it makes are in `codeSearchSetup.ts`, which the tests import and run directly: badges, copy text, actions and request bodies, the busy state, failure output, the Doctor action and returned checks, and Settings warning matching.
- **Selectors.** The new `sdlc-ui.js` selectors appear in the markup, and `test/ui-automation.test.ts` passes.
- **Custom indexers.** Executable builds use `buildArgv` with the shell disabled (decision Q6). Index paths and indexers with no index path follow decisions Q7 and Q8.

All four of these pass with `ai-sdlc-helper run --file`: `web/test/code-search-route.test.ts`, `web/test/code-search-ui.test.ts`, `test/ui-automation.test.ts` and `test/code-search.test.ts`.

## Minor (not blocking)
- The busy line always says "Building index…", even for configure-only requests, and it does not give the expected duration that the spec mentions.
- For a custom indexer, the error for a failed build uses the display `build` text, not the spawned argv.
- `Projects.tsx` `focusFallback` picks the first `.doctor-rerun` on the page, which may belong to another project's card.
- In `Settings.tsx`, `onConfigured={() => load(project)}` holds on to the project from the render where setup started. If the user switches project during a build, the old project's settings can be shown on the new project's page.
- When a project overrides only `command` for built-in `graft`, it keeps the built-in `buildArgv` `['graft','build']`.
- `test/ui-automation.test.ts` takes `root` from `process.cwd()`, so it only works when run from the repo root.
- I did not run typecheck or `build:web` (criterion 6). CI should confirm them.
