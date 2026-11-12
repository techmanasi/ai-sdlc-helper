# web-perf-measurement-order

Type: improvement
Priority: P2 (normal)

## Problem
The two web-performance plans disagreed about ordering, and the disagreement
was never settled on its own terms:

- `dashboard-performance.md` said nothing was measured and ordered the cheap,
  independent fixes first (its Steps 1 and 2), leaving "fix the intervals only
  after measuring" open (its decision 3).
- `run-view-performance.md` said nothing could be judged without the trace and
  put the trace first (its Step 0b), then each step with its own target.

Both were half right. The trace is now built and always on, so measurement is
cheap — but the fixes are also independent of each other, and waiting for a
perfect baseline delays all of them. On 2026-11-12 the decision was **land the
independent fixes first**, and record the conflict here to settle it after they
land.

## Expected behaviour
After the steps of `docs/plans/web-performance.md` P1 to P8 are merged:

1. Each claimed saving is re-measured with `scripts/trace-report.mjs` and the
   counting `git` / `ps` / `gh` shims, not restated from an estimate.
2. Any repeat in the trace that is neither "needed" nor "a guard" is removed, or
   kept with a written reason in the PR.
3. A short note in `docs/plans/web-performance.md` records which order was right
   with the numbers: whether the fixes first (and measured after) hid a saving
   that a baseline would have found, or whether the baseline would have changed
   the order at all.

## Decisions
- Do not reopen the order decision before P1 to P8 land; the point is to judge
  it with the finished system, not to relitigate it.
- Measurement is the deliverable of this item, not a new feature. A finding may
  produce a small fix PR; anything larger becomes its own backlog item.
- The acceptance numbers are the ones in `web-performance.md` section 6; if they
  are wrong, the numbers change here, not the plan's intent.

## Scope
- In: the trace report runs, the shim counts, the four states (cold board, idle
  board, idle run page, running run page), the note that closes the conflict.
- Out: new performance work, the board/run-page features, the parked slow-suite
  investigation, and the process-isolation plan.

## Tests
- No new tests: the checks are the measured tables plus the existing trace and
  shim tests. A finding that needs a code change brings its own test in its own
  PR.

## Docs
- `docs/plans/web-performance.md`: section 6 targets replaced with measurements,
  and a short "which order was right" note.
- Close this item with the PR that carries the note.
