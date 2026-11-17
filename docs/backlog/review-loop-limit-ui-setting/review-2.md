# Review round 2: review loop limit as a UI setting

**Verdict: changes**

## What I ran
- `web/test/review-loop-limit.test.ts`: 6 passed, 1 failed. The failure is "exposes an invalid file limit so it can be cleared": `expected {} to have property "maxLoops"`.
- `test/config/review-loop-limit.test.ts`: passed.
- I did not run `test/review-loop-override.test.ts` (AC7, fake agent) here because it is a slow pipeline test. It runs the real pipeline with override 0 and 1.

## Blocker (still open from round 1)
- **An invalid value in the file can't be cleared** (`web/server/index.ts:266`, `web/ui/src/Projects.tsx:157-160`). The settings GET drops a value that isn't a safe integer of 0 or more, so `fileReview` comes back empty. The form sends `maxLoops: null` only when `fileReview.maxLoops` is set. So clearing the field or pressing "Use default" sends nothing, the invalid key stays, and every project save is refused. Implement attempt 1 has no fix for this, and the regression test above fails.

## Missing tests
- AC4: no API test for saving -1, 1.5 or "abc". The test should check the new message "must be a whole number, 0 or more", that the file stays byte-for-byte the same, and that a patch with two invalid fields reports both messages. The `loops` rule is new code, not existing behaviour.
- AC2: no API test for saving 3 merged with other `review` keys and reading it back, or for saving 0.
- AC3: no API test for clearing a valid value (key removed, other `review` keys kept, effective value 2).
- AC5: no API test for an empty or missing run option using the file value.
- AC8: `web/ui` has no test setup, so the spec allows this to go without a test ("where they exist").

## Nits (not blocking)
- Stray whitespace edits: `const systemTimezone =() =>` (`src/config/settings.ts`), and `project ={data.files.project}` (`Projects.tsx`). The second one changes the text users see.
- The new regression test was added to the committed `web/test/review-loop-limit.test.ts`. `manual-inputs.md` asked for it to go in a new `web/test/review-loop-limit-findings.test.ts`.
