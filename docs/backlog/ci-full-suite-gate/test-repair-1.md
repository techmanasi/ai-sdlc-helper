# Test repair 1

## test/config.test.ts :: "tests: retry and maxWorkers, unset by default; validated with the setting at fault; show prints what they come to"

- **What was wrong:** the test used `toEqual` on the whole `tests` object (`{ retry, maxWorkers }`). That was true before this feature. The spec now gives `tests` two more keys that are always present, so those exact-equality checks can never pass.
- **Proof:** specs-1.md 2.1 ("Default: `"local"`") and 2.3 (`tests.allowFailures: string[]`). Acceptance criterion 1 says `tests.fullSuite` resolves to `"local"` with no setting anywhere. test/config/ci-full-suite.test.ts C01 expects `tests: { fullSuite: 'local', allowFailures: [] }` by default. The empty-array default for `allowFailures` comes from that test, not from the spec text. Both tests can only pass if the resolved `tests` object has these two keys.
- **Change:** added `const ciDefaults = { fullSuite: 'local', allowFailures: [] }`. It is spread into the four `toEqual` checks on `tests` (the three default and override checks, and the `show` output check). They stay exact `toEqual` checks with the same `retry` and `maxWorkers` values. No assertion was removed, skipped or weakened.
- **Verified:** `ai-sdlc-helper run --file test/config.test.ts` gives 36 passed, 0 failed, 0 skipped.
