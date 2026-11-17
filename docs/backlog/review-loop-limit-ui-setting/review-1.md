# Review round 1: review loop limit as a UI setting

**Verdict: changes**

## What works
- A `loops` schema type validates `review.maxLoops` as a safe integer of 0 or more, with the message "must be a whole number, 0 or more".
- `SDLC_REVIEW_MAX_LOOPS` wins over the file in `resolve`. `runContext` refuses an invalid value, so the start route returns 400 and no run starts.
- The settings GET returns `fileReview` and `defaults.reviewMaxLoops`. The project screen shows the field, the current value with "(default)", a "Use default" button and an error next to the field. The Run page's Review options show the field with the project value as its placeholder.
- Tests that run real code and pass: `test/config/review-loop-limit.test.ts` (resolve and runContext, valid and invalid values) and `web/test/review-loop-limit.test.ts` (GET view, invalid start refused, override 5 reaches the pipeline). `test/review-loop-override.test.ts` covers AC7 with a fake agent (override 0 means no fix loop). I did not run it here because it is a slow pipeline test.

## Blocker
- **Can't clear an invalid file value from the UI** (`web/ui/src/Projects.tsx`). The form sends `maxLoops: null` only when `fileReview.maxLoops` is defined. The server leaves `fileReview` empty when the file holds an invalid value. In that case "Use default" does nothing, the invalid key stays, and every project save is refused.

## Missing tests
- AC2: no test saves 3 (merged with other `review` keys, then reloaded) or 0.
- AC3: no test for clearing (patch `maxLoops: null` removes the key; effective value is 2).
- AC4: no server API test that saving -1, 1.5 or abc is refused with the file byte-for-byte unchanged. Also unspecified: what a direct API save of the string `"3"` does.
- AC5: no test that an empty run option uses the file value.
- AC8: the UI has no test setup, so UI checks are not possible. The spec allows this ("where they exist").

## Nits (not blocking)
- Stray whitespace edits: `const systemTimezone =() =>` in `src/config/settings.ts`, and `project ={data.files.project}` in `Projects.tsx`. The second one changes the text users see.
