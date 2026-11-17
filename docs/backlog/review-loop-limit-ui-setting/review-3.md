# Review round 3: review loop limit as a UI setting

**Verdict: changes** (one missing test, no blockers)

## What I ran
- `web/test/review-loop-limit-findings.test.ts`: passed. This was the round-2 blocker (an invalid file value couldn't be cleared).
- `web/test/review-loop-limit.test.ts`: passed.
- `test/config/review-loop-limit.test.ts`: passed.
- I did not run `test/review-loop-override.test.ts` (AC7, fake-agent pipeline) because it is slow. From reading it, it runs the real pipeline with override 0 and override 1.

## Round-2 blocker: fixed
The settings GET now returns `fileReview.maxLoops` for any value in the file that isn't null, including an invalid one. The form shows that value, and clearing the field or pressing "Use default" sends `maxLoops: null`, which removes the key. The new regression test exercises this through the server API.

## Missing test
- **AC4, invalid save through the settings route** (`src/config/settings.ts`, `validate` `'loops'` rule). The schema rule for `review.maxLoops` is new in this diff. It has a new message ("must be a whole number, 0 or more") and now also refuses unsafe integers. No test saves -1, 1.5, "abc" or 9007199254740992 through `POST /settings`. The test should check three things: the message comes back, the file is byte-for-byte unchanged, and a patch with a second invalid field reports both messages. `manual-inputs.md` treats refusing a save as existing behaviour under the old `'integer'` rule. But that rule was replaced here, so nothing guards the new code.

## Accepted without new tests (orchestrator decision in `manual-inputs.md`)
- AC2 and AC3 (save 3 or 0, merge with other `review` keys, clear): the `editSettings` and `applyPatch` code paths are unchanged in this diff. From reading the code, the save is atomic (temp file then rename), checks the hash, and validates the whole file before writing.
- AC5, an empty run option uses the file value: `runContext` and `resolve` both treat `''` as unset.
- AC8: `web/ui` has no test setup ("where they exist").

## Nits (not blocking)
- Two stray whitespace edits are still there from round 2: `const systemTimezone =() =>` in `src/config/settings.ts`, and `project ={data.files.project}` in `Projects.tsx`. The second one changes the text users see.
- When the file holds an invalid value (for example -1), the screen shows "Current: -1" with no "(default)" mark, but the pipeline actually uses 2.
- `SettingsView.fileReview.maxLoops` is typed as `number`, but it can now be any raw JSON value.
