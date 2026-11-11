I checked the claims against the code and ran the repaired web test file.

**1. Were the originals genuinely wrong?** Yes. Both were lint defects in how the files were set up, not wrong expectations about behaviour, so no spec line is involved.
- `test/config/ci-full-suite.test.ts` imported `vi` and never used it. Searching the current file for `\bvi\b` finds nothing. `eslint.config.js:11` sets `@typescript-eslint/no-unused-vars: error`, so `npm run lint` would fail.
- `web/test/runs/ci-view.test.ts` imported straight from `../../../src/runs/view.js` and `../../../src/runs/index.js`. `eslint.config.js:22` forbids `**/src/**` imports in `web/**` ("Import the engine from 'ai-sdlc-helper' (src/index.ts), not its files."). Again, `npm run lint` would fail.

**2. Is the new version just as strict?** Yes. No `describe`, `it` or `expect` changed, and the git diff of the working tree matches `test-repair.diff` exactly (3 import lines). `src/index.ts:39-45` re-exports both `RunContext` (from `./runs/index.js`) and `runView` (from `./runs/view.js`). `vitest.config.ts:12` points `ai-sdlc-helper` at `src/index.ts`, so the test still runs the same `runView` code. The `vi.mock` of `src/runs/index.js` is unchanged. Vitest matches mocks by resolved path, so the mock still replaces `runWorktree` inside `view.js`.

**3. Any tricks?** None. No matcher was loosened, no case removed, and no expected value changed. Only imports changed.

**4. Is the change limited to what the claim justifies?** Yes. It touches only the import lines named in `test-issues.md`.

**5. Does it run the real code?** Yes. Both files still import and run engine code, and neither asserts on Markdown. I ran `ai-sdlc-helper run --file web/test/runs/ci-view.test.ts`: 11 passed, 0 failed. I did not re-run the config test file myself; the repair notes report it at 30 passed. Neither I nor the repairing agent ran lint.

VERDICT: VALID
