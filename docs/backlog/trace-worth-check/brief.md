# trace-worth-check

Type: improvement
Priority: P3 (low)
Source: run-view performance plan, Step 0b (PR #60). The always-on trace and its log rotation were added to make repeating actions visible; the user asked to check they are worth what they cost.

## Problem
`src/trace.ts` is a home-made trace: a buffered writer, size/age/count rotation, a traced `spawnSync`/`execFileSync` wrapper, a page-side ring buffer and a report script. It is always on. It is not yet known that it earns its cost, or that this code has to live in the app.

## To verify (after the plan's Step 7, "measure again", so the numbers come from the real fixes)
1. Cost: CPU, memory and disk the trace adds on an open run page and on the board with several projects, over a day (file size at the default 5 MB x 4 files, flush writes per minute). Step 0b measured +/-1% on a `git` spawn; this is the whole-app number.
2. Value: did the trace find anything the plan's steps did not already name? If a repeat it showed was fixed, is it still needed once fixed, or only as a regression guard?
3. Delegation: can an outside tool do the same job so the app carries no trace code? Candidates to try: a counting shim on `PATH` (as `web/test/trace.test.ts` does), `dtrace`/`strace`/`fs_usage` for spawns, `node --cpu-prof`, OpenTelemetry, or a separate process that only reads the file. Compare what each shows (the "why" of a spawn and the "changed" of a rebuild exist only inside the app).
4. If it stays: should it default to on, or be off by default with `SDLC_TRACE=1` and a short window after start-up? Is rotation needed at all if the file is capped small?

## Expected outcome
A written decision: keep as is, cut down (drop rotation, drop the page side, or default off), or replace with an outside tool; then the change.
