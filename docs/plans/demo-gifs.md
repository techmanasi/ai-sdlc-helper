# Plan: demo GIFs of the refreshed UI, rebuildable from screenshots

## Goal
Show the pipeline in the README with animated GIFs made from real runs on the `feat/ui-refresh` build. Keep the
source screenshots in the repo so that a UI change only needs its screenshot added or replaced, then one command
rebuilds the GIFs.

## Runs (real pipeline, started from the web UI of the `feat/ui-refresh` build)
1. `ui-code-indexer-setup`: the item that still fails (stopped at Spec on 2026-11-14: the codex agent gave an
   empty answer twice after a model-list timeout). Retried from Spec in the UI.
2. `review-loop-limit-ui-setting`: a small open backlog item, run from Spec to Ship.

Both runs create their own `sdlc/<slug>` branch and PR, as any pipeline run does. Those PRs are not merged as part
of this work; their CI results are reported, never fixed on their branch.

## Layout
```
demo/
  README.md                      how to capture and rebuild
  capture.mjs                    watch a run page and save a screenshot whenever the stage or state changes
  build-gifs.mjs                 turn each demo/screenshots/<set>/ folder into demo/<set>.gif
  screenshots/<set>/NN-<name>.png   the frames, in file-name order
  <set>.gif                      built output, linked from the top-level README
```
- Frames are ordered by file name, so a changed screen is replaced in place (same name) or added between two
  frames (for example `03b-...png`).
- `capture.mjs` drives the installed Google Chrome headless through the Chrome DevTools Protocol (no new npm
  dependency). It signs in with the `?t=` token the `ui` command prints.
- `build-gifs.mjs` uses `ffmpeg` (palette pass) so the GIFs stay small; frame time and width are options.

## Steps (one PR, `feat/demo-gifs` into `feat/ui-refresh`)
1. This plan.
2. Scripts and `demo/README.md` (Sonnet subagent), checked against the running preview server.
3. Start both runs from the UI; `capture.mjs` runs beside each one in the background.
4. Prune frames to one per stage plus the key moments (lock set, a stop with recovery cards, cost table, PR).
5. Build the GIFs (Haiku subagent), add a Demo section to `README.md`, attach a board screenshot to the PR.
6. `npm run lint`; CI on the PR; merge into `feat/ui-refresh` only on your yes.

## Not in scope
- Fixing the runs' own outcomes. A run that stops is captured as a stop (that is a demo of recovery too).
- Merging `feat/ui-refresh` into `main`.
