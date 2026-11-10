## The merged branch fails its checks
This task's branch was just brought up to date with the base branch: the conflicts were resolved, and then the project's checks failed on the result. Fix the source so they pass.
- Reproduce each failure locally first, with the project's own test command, then change the source. Read what both sides changed ({{LOG}}/resolve-conflicts-context.md, if it exists, shows the commit being replayed and both sides' diffs).
- Keep what both sides meant: every acceptance criterion of this task still holds, and no behaviour the merged work added is lost.
- Never edit, skip or weaken a test to make it pass. If a test is wrong only because of the merge (it lists or counts something the other side extended, for example), claim it in {{DOCS}}/test-issues.md as you would a test defect: the pipeline's Test repair stage and its independent auditor decide.
- The pipeline's gate runs again after your turn.
