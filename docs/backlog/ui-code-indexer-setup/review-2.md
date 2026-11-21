# Review round 2: ui-code-indexer-setup

**Verdict: changes** (one blocker)

## Round 1 blockers: all fixed
1. **The UI exists now.** It adds `CodeSearchModal.tsx`, a Doctor-row `Setup Code Indexer` button in `Projects.tsx`, and in `Settings.tsx` a `Code Search` header button plus an inline banner button. `codeSearchSetup.ts` holds the presentation logic. `sdlc-ui.js` has new selectors and helpers. `web/test/code-search-ui.test.ts` tests the module.
2. **Nonzero-exit text.** It now reads `graft build exited with code 7`. A signal kill reports `signal SIGKILL`. Both are tested.
3. **Timeout guard.** It is held until the child exits, with SIGKILL after 500 ms and a 2 s force-settle. Tested.
4. **Unreadable config.** It now returns `400 { ok:false, error }`. Tested with a directory in place of the file.

These four test files pass with `ai-sdlc-helper run --file`: `web/test/code-search-ui.test.ts`, `web/test/code-search-route.test.ts`, `test/ui-automation.test.ts` and `test/code-search.test.ts`.

## Blocker
- **The Graphify install text copies a broken command** (`web/ui/src/codeSearchSetup.ts`, `installOf`). The text is cut at the first comma, so Copy gives `uv tool install graphifyy (or pipx install graphifyy)`. That is a shell syntax error. The copy text should be `uv tool install graphifyy`. The alternative and the build step belong in the instructions line. The test only covers graft.

## Minor (not blocking)
- The busy line always says "Building index…", including for configure-only (`build: false`) requests. The spec's message also mentions the expected duration ("this may take up to a minute").
- For a custom indexer, the build-failure error uses the display `build` text (for example "build locally exited with code 1") instead of the spawned program and arguments.
- `Projects.tsx` `focusFallback` selects the first `.doctor-rerun` on the page, which may belong to another project's card.
- `test/ui-automation.test.ts` now resolves `root` from `process.cwd()` instead of `__dirname`, so it only works when run from the repo root.
- I did not run typecheck or `build:web` (acceptance criterion 6). CI should confirm them.
