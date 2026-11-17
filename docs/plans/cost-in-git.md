# A task's cost kept in git

Goal: the cost, tokens and time of every run of a task stay in the repo with the task, after its worktree and git-ignored
`logs/` are gone, so a merged PR still says what it cost.

## Where

`docs/backlog/<slug>/cost/`, next to the task's spec, plan and review:

- `cost.md`: the task total, a table by stage over every run (passes, time, agent time, rounds, models, input, output,
  cache read and write, tokens, cost), a table by run (started, from, result, time, rounds, tokens, cost), and each run's
  stages.
- `cost.json`: the same figures for tools (the Completed page can read it from the merged branch).

Built from `logs/attempts.jsonl` by `src/runs/cost-log.ts`. Dollars follow the run page: reported as is, `≈` for an
estimate at the model's list price, `free` for a model that cost nothing, `no price` for tokens with no known price.

## When

The pipeline writes the log just before each commit it makes on the run's branch and puts it in that commit
(`src/pipeline/cost-log.ts`): Red tests, Implement (each attempt it commits with CI), Test repair, and Finalise. The log
never gets a commit or push of its own, since each push to a PR starts CI again. It rides along only with a commit that
has other work in it; when Finalise has nothing to commit, the written files are put back so the checkout stays clean.

Review is the last agent before Finalise's commit, and Finalise runs no agent. The one agent after it is Resolve
conflicts' resolver (only when the rebase onto the base stops on a conflict): when it ran, a last `chore(<slug>): cost
log` commit goes with the push that stage makes anyway, so no extra CI run. The committed log then covers every agent
round of a task that finishes. A failed run's rounds reach git with the task's next commit.

## PR

`feat/cost-in-git` into `feat/ui-refresh`, after `feat/cost-all-agents` (#175), which it is built on.

Done when: `test/cost-log.test.ts` passes, the pipeline tests that list each commit's files include the cost log, a
`cost.md` rendered from a real run's log matches the run page's total, and CI is green.
