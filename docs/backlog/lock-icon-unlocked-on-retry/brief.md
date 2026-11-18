# lock-icon-unlocked-on-retry

Bug/verify: when a retry or discard restarts a run from Spec, Plan or Red tests, the lock icon must show unlocked, so
it is understood that the tests are unlocked on retry. `lockOpen` exists in `web/ui/src/Run.tsx`; verify it covers
retry and discard from each of those stages, and fix what it misses.
