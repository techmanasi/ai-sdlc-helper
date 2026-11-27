# Review loop limit test matrix

## Automated acceptance tests

`web/test/review-loop-limit.test.ts` uses authenticated requests against a real server and a temporary Git project. For successful starts the server creates the worktree and run record. The test replaces the detached supervisor with a recorder and executes the source pipeline in that worktree with the launch environment. The fixture agents request changes, add a failing test on each Red tests invocation, and supply its implementation.

| Case | Acceptance criteria | Setup and action | Observable result |
| --- | --- | --- | --- |
| Project settings round trip | 1, 2, 4 | GET settings with no explicit limit. POST 0 and then 2 using the latest hash. GET after each save. Finally try −1 or 0.5. | Initial effective limit is 2. Each accepted value is a JSON number in the file and the reopened settings. Sibling Review settings and all other config survive. Invalid saves return 400, identify the field and its whole-number lower bound, and preserve the exact file bytes. |
| Zero and isolation | 3, 5 | With project limit 1, start with the string override `"0"` and an open finding. Start another slug on the same server without an override. It passes on its second Review. | The first run stops with exit 1 and “needs you” after zero fixes. The other run executes Red tests and Implement once and succeeds. The project file stays byte-identical after both. |
| Default in a stale worktree | 1, 3, 5 | Commit project limit 0, remove it in the project checkout, then start without an override. Request changes through three Review rounds. | Review executes exactly two fix cycles and stops with exit 1 and “needs you”. The project file stays unchanged. |
| Passing Review and numeric API inputs | 3, 5 | Start with numeric 0 and an immediate pass. On another slug, override project limit 0 with numeric 2 and pass on the third Review. | Both runs exit 0. The first runs no fix cycle. The second runs exactly two, in Red tests → Implement → Review order. Neither changes the project file. |
| Invalid run requests | 4 | POST negative, fractional, blank, nonnumeric, null, boolean and array overrides to the start endpoint. | HTTP 400 identifies `SDLC_REVIEW_MAX_LOOPS` and requires a whole number of 0 or more. No launch, worktree or run record is created. Project bytes are unchanged. |

## Browser acceptance checks

Use the UI automation helper on Global settings and Run options → Review once the controls exist. These checks are pending implementation.

| Case | Action | Expected result |
| --- | --- | --- |
| Project value and help | Open Global settings without a configured limit, save 0, close and reopen. Open personal settings. | Global settings initially show 2, identify the default of 2, and explain that a fix cycle sends findings back to Red tests. Reopening shows 0. The project control belongs to Global settings only. |
| Project save failures | Try blank, −1 and 0.5. Then edit a valid value in two sessions and save the older draft last. | Invalid drafts show the whole-number requirement and leave the saved value intact. A stale save shows the normal conflict feedback and preserves the newer change. |
| Run draft and inheritance | Set project limit 3. Inspect the blank override and help, enter 0, inspect the option summary and copied command, reload, then clear and reload. | Blank inherits 3. An explicit 0 survives reload and appears in the summary and CLI environment. Clearing removes the key and restores inheritance. |
| Invalid run drafts | Enter −1, 1.5 and nonnumeric text through the control and through “Environment for this run”. Try launching, reload and correct the draft. | The form explains the integer requirement, blocks the invalid launch, and never persists an invalid override. A corrected value permits launch. A blank control clears the override. |
| Run scope | Save different overrides for two slugs in one project and for the same slug in another project. Switch repeatedly and reload. | Each page restores its own saved value, including after switching projects without changing slug. |
| Timing and launch actions | Start a run, open Review options, then change Global settings. Exercise available Start, Resume, Restart, answer/permission resume, CI fix, discard-and-resume and test-issue resume actions with a selected override. | The running control is disabled. The settings form gives its active-run warning. The active pipeline keeps its budget. New launches receive the selected override or inherit the latest project limit when cleared. A refused launch uses the normal request error display. |
| Real supervisor | Start through the UI with project limit 1, override 0 and an agent reporting a finding. | The detached process stops at the first Review with “needs you”. Capture the Global settings and Run options screens for the PR. |

## Review items

- Check the README Settings section and web UI guide for the default, zero, effective time, clearing, and the API environment key.
- Review test diffs for runtime assertions and the permitted file scope. Test-file contents and documentation are checked in Review.

## UI form logic regression tests

`test/review-loop-limit-ui.test.ts` specifies a plain-module contract for extracting the form logic currently inline in the components. The proposed exports from `web/ui/src/env.ts` are `reviewSettingsDraft(config)`, `reviewSettingsPatch(config, draft)` returning `{ error, patch }`, `reviewLimitError(rows)`, and `reviewLimitOptions(rows)` returning `{ error, env, summary, canLaunch }`. The components must use the same logic for these tests to cover their behavior.

| Case | Action | Expected result |
| --- | --- | --- |
| Project draft | Initialize with no Review setting or a configured zero. | Draft is `2` or `0`, respectively. |
| Invalid project draft | Save `-1`, `0.5`, blank, or `abc`. | Error explains the whole-number lower bound and no Review patch is produced. |
| Changed project draft | Save `0` against default 2; save unchanged default 2 and configured 0. | Changed value produces `{ review: { maxLoops: 0 } }`; unchanged values produce no Review patch. |
| Unset run row | Supply a Review limit environment row with an empty value. | No error, no environment key, and launch is allowed. |
| Invalid run rows | Supply `-1`, `0.5` with leading whitespace in the key, or `1.5`. | Error explains the requirement, the invalid key is excluded from the environment for sending or persistence, and launch is blocked. Other options remain intact. |
| Zero and clearing | Supply `0`, then clear with `setEnvValue`. | Zero is retained in the environment and summary; clearing removes the key and permits inheritance. |

The existing server and pipeline tests remain in place. Browser checks above remain necessary to verify that the controls use the extracted logic, persistence and launch actions are wired correctly, and feedback is visible.
