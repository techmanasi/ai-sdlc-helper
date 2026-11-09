# Review 1: ui-code-indexer-setup

Scope: `git diff 97baf18` against `specs-1.md`.

## Verdict

No blockers. The feature is in code: the routes are in `web/server/index.ts`, the status and build helpers are in `src/config/codeSearch.ts`, and the UI changes are in `CodeSearchModal.tsx`, `Projects.tsx` and `Settings.tsx`. `docs/web-ui.md` describes only behaviour that the code implements. No test reads or asserts on documentation text.

## Fixes applied

- `web/server/index.ts`: the timeout error said "120 seconds" even when the timeout was set to something else. It now reports the configured timeout.
- `CodeSearchModal.tsx`: "Building index..." also appeared for Save Setting and Use Indexer, which run no build. It now shows only while a build runs; other saves show "Saving…".
- `Projects.tsx`: a successful save ran the doctor twice, once from `onChanged` and once from `onClose`. It now runs once, on close.
- `Settings.tsx`: settings and code search loaded through one `Promise.all`, so if the code search request failed, the whole Settings page showed an error. They now load separately, and a code search error shows only in the Code Search panel.

## Checked and fine

- Security: the build runs with `spawn` and an argument list, never through a shell. The `buildCommand` check rejects `;`, `&&` and `$()`. If `codeSearchErrors` finds any error in the config, the server ignores the file, so it never runs an unvalidated custom `buildCommand`. The build runs in the project root with a timeout.
- If a build fails or times out, the server returns `ok: false` with the build output and does not write the config file. If the config file is malformed, the request returns 400 and the file is left as it was (tested).
- Unknown project returns 404. Unknown indexer, `build` on auto/none, an indexer not on PATH, and graphify (no headless build) each return 400.

## Test coverage

- Covered by tests that run the real code: the backend criteria (AC3 inspection, AC4 server side, AC5 server side, AC7) in `web/test/code-search-setup.test.ts` and `test/config/code-search-status.test.ts`. Both pass.
- Not covered by any test: the UI criteria (AC1 doctor button, AC2 Settings panel and labels, and the modal parts of AC3/AC4/AC5: badges, Refresh, spinner, blocked dismissal). The repo has no UI component test harness, and AC7 asks only for backend tests. The code implements these criteria, so this is a gap to note, not a blocker.
- I did not run the UI typecheck (`npm run typecheck`) or the web build (`npm run build:web`) in this review. The parent should confirm them with `npm run check`.

## Minor notes (not changed)

- `api.codeSearchSetup` calls `fetch` directly instead of `call`, so it skips the page request trace. It does this on purpose so that a 400 with build output reaches the modal.
- The `installed` check looks for the indexer's `command`. A custom `buildCommand` can name a different program, and if that program is missing the build fails with a spawn error rather than a 400.
