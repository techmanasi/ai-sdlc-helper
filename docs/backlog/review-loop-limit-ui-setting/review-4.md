# Review round 4

Verdict: changes.

Three blockers:
- The new recovery test fails TypeScript checking at lines 23–25. Reproduced locally with `tsc -p web --noEmit` (exit 2), consistent with the supplied PR #170 CI failure.
- A saved project limit can be ignored by a newly started run: its worktree retains the committed config, and the resolved project limit is not passed to the child.
- Safe-integer validation introduces an upper bound that the spec explicitly excludes.

Missing real-code coverage: save/reload 3 and 0, clear a valid setting and resolve default 2, and server start with an empty override using the actual child worktree. Existing tests cover explicit overrides, invalid starts and fake-agent loop exhaustion. The UI has no component test setup, so AC8's conditional UI-test requirement is not treated as a separate missing test.

The base-branch AC4 invalid-save behaviour is accepted as covered per the binding manual input. No documentation assertions were found in the feature tests. Runtime tests were not rerun; the review used source/test inspection and the focused TypeScript check. Only the two requested reports were written.
