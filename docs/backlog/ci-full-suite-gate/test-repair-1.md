# Test repair 1

## test/config/ci-full-suite.test.ts (all cases, e.g. C01)
- Wrong: `vi` was imported from vitest and never used, so `@typescript-eslint/no-unused-vars` fails lint. Verified: the only match for `vi` in the file is the import.
- Proof: isolation defect (lint). No spec line is involved.
- Changed: removed `vi` from the vitest import. No test or assertion touched.

## web/test/runs/ci-view.test.ts (all cases, e.g. V01)
- Wrong: it imported `runView` and `RunContext` from `src/runs/...` directly. `eslint.config.js:22` forbids `**/src/**` imports in `web/**` ("Import the engine from 'ai-sdlc-helper'"). Both names are exported from `src/index.ts`.
- Proof: isolation defect (lint rule). Spec 10.2 behaviour is unchanged.
- Changed: `import { runView, type RunContext } from 'ai-sdlc-helper';`. The `vi.mock` of `src/runs/index.js` is unchanged. The vitest alias maps `ai-sdlc-helper` to `src/index.ts`, so the mock still applies.

Both files pass with `ai-sdlc-helper run --file` (30 and 11 passed). I did not run lint.
