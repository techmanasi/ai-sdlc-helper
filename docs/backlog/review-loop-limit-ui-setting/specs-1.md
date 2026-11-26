# Review loop limit in the web UI

## Purpose

Expose the existing `review.maxLoops` project setting in the web UI and allow a run-specific override. The limit is the number of times Review may send a run back to Red tests to address findings before the run stops with “needs you”. Its default is 2. This feature depends on `review-findings-acted-on`.

## Behaviour

- Project settings display the current `review.maxLoops` value and identify 2 as its default. If the project has no explicit value, the displayed effective value is 2.
- A user can change the project value and save it to the project's `sdlc.config.json` as `review.maxLoops`. Saving preserves unrelated settings and follows the existing project settings save and error handling behaviour.
- Run options allow an optional override for a run. When present, it takes precedence over the project value for that run; otherwise the project value, or its default of 2, applies. The override does not change `sdlc.config.json` or the value used by other runs.
- The selected effective limit is used by the actual Review loop, including when a run is started through the server API. A limit of 0 permits no return to Red tests for fixes; Review can still pass, but open findings stop the run with “needs you”.
- Project settings changes and run options follow the existing UI conventions for when settings can be changed and when they take effect.

## Inputs, outputs and errors

- The project setting and run override accept whole numbers greater than or equal to 0. Both 0 and 2 are valid.
- A negative value or a value that is not a whole number is refused with a message explaining the requirement. An invalid project value is not saved; an invalid run override is not applied or saved. The server must also reject invalid values supplied directly through its API, rather than relying only on the UI.
- The run override can be left unset so the project setting applies. A failed settings save or run request is reported using the existing error handling conventions.

## Acceptance criteria

1. With no explicit project value, project settings show the effective value and default as 2. With a configured value, they show that value and the default of 2.
2. Changing the value to a valid whole number and saving writes `review.maxLoops` to `sdlc.config.json`; reopening settings shows the saved value and unrelated settings remain intact.
3. Run options allow a valid override, including 0. A server API test starts a run with an override different from the project setting and verifies that the Review loop uses the override. The project file remains unchanged, and a run without an override uses the project value or default.
4. Negative and non-whole values are rejected with an explanatory message in both project settings and run options. Invalid values submitted through the relevant server API are rejected and do not change the saved project setting or apply a run override.
5. When Review still has findings after the allowed number of fix loops, the existing “needs you” outcome is retained; a passing review completes normally.
