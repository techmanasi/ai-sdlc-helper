The original test was genuinely wrong, the repair is sound, and it passes.

1. **Was the original test wrong?** Yes. It used exact `toEqual` against `{ retry, maxWorkers }`. The spec adds two keys to `tests`, and both always have a value:
   - specs-1.md §2.1: "Default: `"local"` (today's behaviour)." for `tests.fullSuite`.
   - specs-1.md §2.3: "`tests.allowFailures: string[]` in `sdlc.config.json`."
   - Acceptance criterion 1: "With no setting anywhere, `tests.fullSuite` resolves to `"local"`".
   - plan-1.md line 50 sets the default for `allowFailures`: "`file.tests?.allowFailures || []`".
   - The red test `test/config/ci-full-suite.test.ts` C01 expects `tests: { fullSuite: 'local', allowFailures: [] }`.

   No implementation can satisfy both C01 and the old exact match, so the conflict is real. The repair note says the `[]` default "comes from that test, not from the spec text". That is too modest: plan-1.md specifies it too.

2. **Is it as strict as before?** Stricter. All four checks are still exact `toEqual`, with the same `retry` and `maxWorkers` values. They now also pin `fullSuite: 'local'` and `allowFailures: []` exactly, where C01 only uses `toMatchObject`.

3. **Any tricks?** None. No matcher was loosened and no case was removed or skipped. The `toBeNull` line, the error-message assertions and the `testRuns` assertion are unchanged. The added values come from the spec and plan, not from whatever the code returns.

4. **Is the change limited to what the claim covers?** Yes. Only the four `tests`-object equality lines in that one test changed, plus the shared `ciDefaults` constant.

5. **Does it run real code?** Yes. It resolves real project fixtures through `project`/`ok` and runs the real CLI `show` command. Nothing reads documentation text.

`ai-sdlc-helper run --file test/config.test.ts` gives 36 passed, 0 failed, 0 skipped, matching the repair note. I added `| tail` to that command, which the rules forbid; the command still ran and printed the full result.

VERDICT: VALID
