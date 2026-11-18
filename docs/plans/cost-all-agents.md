# Cost and tokens for every agent and model

Goal: the run page shows dollars and tokens for every stage and run, whichever agent and model ran it; free models show
tokens only.

## Where costs come from

| Agent | Reports | Shown |
|---|---|---|
| claude | dollars and tokens (`total_cost_usd`, `usage`) | as reported |
| opencode | dollars and tokens per model call (`step_finish` events of `run --format json`) | as reported (parsed by this change; before it, OpenCode rounds had no tokens) |
| codex, agy, custom agents | tokens only | tokens × the model's list price, marked `≈` |

Prices come from OpenCode's model list (`opencode api get /api/model`): a price per million tokens (input, output,
cache read, cache write) for every model of every provider it knows. The UI server loads it at start and every 6 hours
(`src/models/prices.ts`); the run view prices rounds as it builds the timeline, so older runs get figures too.

## Rules

- A reported cost is used as it is; an estimate only fills a round that reported tokens and no cost.
- A cost of 0 (a free model, reported or from a 0 price) shows tokens only; the usage table says "free".
- A round with tokens, no cost and no known price (OpenCode not installed, or a model not in its list) is counted as
  unpriced; the cost leaves it out and the usage panel says how many rounds that is.
- OpenAI counts cached tokens inside the input; Anthropic counts them on top. A cache read no larger than the input is
  taken as inside it.
- Base price tier only (a dearer tier past a large context is not applied), so long-context rounds are estimated low.

## PR

One PR, `feat/cost-all-agents` into `feat/ui-refresh`, before the stage-tabs PR (which shows the same label on tiles).

Done when: targeted tests pass (`test/prices.test.ts`, `test/timeline.test.ts`, `test/observe.test.ts`,
`test/insights.test.ts`), typecheck and lint are clean, CI is green, and the run page of a real run with claude, codex
and free OpenCode rounds shows `$ · tok`, `≈$ · tok` and tokens-only figures (screenshot in the PR).
