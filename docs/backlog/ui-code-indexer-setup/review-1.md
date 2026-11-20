# Review round 1: ui-code-indexer-setup

**Verdict: changes**

## What is there
- Engine (`src/config/codeSearch.ts`): `buildArgv`, `executableBuild`, `inspectCodeSearch` and argv validation. These are tested in `test/code-search.test.ts` and match spec 3–4.1.
- Server (`web/server/index.ts`): `GET /code-search` and `POST /code-search/setup`. The POST route uses `shell: false` spawns, a 120 s deadline, an in-flight guard, hash-checked `editSettings` and refreshed doctor checks. These are tested over real HTTP in `web/test/code-search-route.test.ts`.
- Browser client (`web/ui/src/api.ts`): `codeSearch` and `setupCodeSearch`, and `ApiError.output`. Tested in `web/test/code-search-api.test.ts`.
- All three test files pass with `ai-sdlc-helper run --file`.

## Blockers
1. **No UI was built.** `CodeSearchModal.tsx` does not exist. `Projects.tsx` and `Settings.tsx` are unchanged. `sdlc-ui.js` has no new selectors. Acceptance criteria 3, 4, 5 and the selector part of 6 are unmet and have no tests. Plan sections 3–4 and the README section (6) are still to do.
2. **Nonzero-exit error text.** The response says `indexer exited with code N`, but the spec requires `<command> exited with code <N>`. A process killed by a signal gets `code null`.
3. **Timeout releases the in-flight guard too early.** The guard is released before the child has exited. A child that ignores SIGTERM can then overlap a second build for up to 500 ms.
4. **Unguarded config read in POST.** An unreadable `sdlc.config.json` throws instead of returning `400 { ok:false, error }`.

The UI tests should go through plain `web/ui/src` modules: indexer state to actions and copy text, the code-search warning matcher, and when the Doctor row offers the action.
