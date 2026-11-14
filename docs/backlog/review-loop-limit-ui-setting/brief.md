# review-loop-limit-ui-setting

Type: feature
Priority: P3 (low)
Source: User, 2026-11-15, while settling the Review design (`review-findings-acted-on`): "Review loop limit should be a setting, keep default value to 2, add a backlog to add this setting to UI".

## Problem
`review-findings-acted-on` adds `review.maxLoops` (default 2): how many times Review may send a run back to Red tests before the run fails with "needs you". It can be set only in `sdlc.config.json`.

## Goal
The limit can be read and changed in the web UI, for the project and per run, like the other pipeline settings.

## Acceptance criteria
- The project settings show `review.maxLoops` with its current value and default, and saving writes it to `sdlc.config.json`.
- Run options can override it for one run; the run uses that value (test through the server API).
- Values below 0 or that are not whole numbers are refused with a message, and the value is not saved.

## Depends on
- `review-findings-acted-on`.
