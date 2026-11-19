# DESIGN.md: the web UI's design system

The source of truth is `web/ui/src/styles.css` (tokens at the top). This file says how to use it. When the two
disagree, the CSS wins; fix this file. The visual reference is the design deck (artifact "Run page stage rail"), which
is data, not code. A UI change updates `tools/UI-automation/sdlc-ui.js` `SELECTORS` in the same PR and carries
screenshots in the PR body (taken against synthetic state, and said to be).

## Principles
- One layout, two themes. Never write a colour literal in a component: use a token. Dark is the default.
- State is colour plus words plus a shape, never colour alone (a failed pill says "failed at 42s" and has a stop square).
- The product's USP is "AI cannot grade its own homework": locks, gates and stops are shown as facts, in plain words.
- Name SDLC stages, never number them. Show what happened, what waits, and the way on, not a log dump.
- System fonts only; nothing is fetched from another host.

## Tokens (`:root`, dark / light)
| Role | Token | Dark | Light |
|---|---|---|---|
| Page / panel / raised / lines | `--bg` `--pn` `--pn2` `--ln` `--ln2` | #0d1117 #141a22 #1a212b #252d38 #323c49 | #f3f5f8 #fff #eef1f5 #dde2e9 #c5ccd6 |
| Text / muted | `--tx` `--mu` | #dbe2ea #8f9baa | #18202c #5a6675 |
| Running | `--run` `--run-bg` | #56d4dd #10323a | #0a7480 #dff3f5 |
| Waiting / paused | `--wait` `--wait-bg` | #e3b341 #2e2610 | #8a5a00 #fff4d6 |
| Failed | `--fail` `--fail-bg` | #ff7b72 #3a1c1c | #c4202b #fde8e8 |
| Done | `--done` `--done-bg` | #6ee787 #12311d | #1a7f37 #e3f6e8 |
| Future / not needed | `--fut` `--fut-bg` | #b3a6f0 #231f3d | #6e40c9 #efe9fb |
| Primary action | `--pri` `--onpri` | #56d4dd #06181b | #0a7480 #fff |
Also: `--code` (code surface), `--link`, `--shadow`, `--r: 10px` (panel radius), `--sans`, `--monof`.
State mapping: running = cyan, waiting/paused/ready = amber, failed/stopped/refused = red, done = green, not started =
grey, not needed or later = violet dashed. Use `.s-*` classes for text and `.chip-*` for status chips.

## Type
Body 14px/1.45. h1 22px/650, h2 15px/600. `.small` 12.5px. `.mono` (12.5px) for slugs, ids, paths, branch names, commands.
Eyebrow `.lbl`: 11px, 600, uppercase, letter-spacing .06em, `--mu`. Tags `.tag`: mono 11px, 1px border, radius 4.

## Spacing, shape, elevation
Panels `.pn`/`.panel`: `--pn`, 1px `--ln`, radius 10, `--shadow`; header `.ph` (10px 14px, bottom rule), body `.pb` (12px 14px).
Gaps are 8px in a `.row`, 14px in a `.col`; the stage pane grid is `280px 1fr` with a 28px gap. Pills are radius 999;
controls radius 6; small controls 4 to 5. No other shadows.

## Components
- **Buttons** `.btn` (40px high, 13px, radius 6, `--pn2`). Variants: `.btn-p` one primary per view; `.btn-d` destructive
  (red outline, transparent); `.btn-s` 32px; `.btn-xs` 26px. Disabled is .55 opacity. Segmented choice: `.segs` + `.seg`/`.seg-on`.
- **Inputs** `.inp` (13px, `--bg`, radius 6, 40px min). Dark select `.sel`: 12px, padding 6px 10px, border `--ln2`, radius 6,
  bg `--bg`, colour `--tx`. Picker `.picker` / `.pick-*` for searchable lists.
- **Chips** `.chip-*` for run state. Round chips `.rchip`: 11px, grey outline; the active chip `.rchip-on` is inverted.
- **Step pills** `.step`: radius 999, border `--ln2`, bg `--pn2`, 13px. Done: green check. Running: cyan spinner, `--run-bg`,
  cyan time. Failed: red stop square, "failed at <time>". Not started: dashed, no time. A pill appears when its step
  starts; the running one counts up; the others keep their final time.
- **Stage rail** `.rail2` of `.tile`s (done, active, paused, failed, pending, skipped, after). The Red tests tile carries a
  lock badge: closed (green) when the tests are locked, open (dashed amber) when unlocked, under an amber "TEST LOCK"
  eyebrow. Finalise carries `PR · CI ✓` / `PR · draft`. On a narrow window the rail scrolls with hidden-count arrows;
  on a phone the details open under the tapped stage.
- **Stage pane** `.stage-pane`: outline colour follows state (`.tone-stop` red, run cyan, done green, idle grey); a back bar
  appears when the user looks away from the followed stage.
- **Recovery** `.recov`: why it stopped, then three ways on (`.way`), the first recommended (`.way-first`).
- **Guarantee strip** `.guar`: four facts, each held or broken (`.guar-held`, `.guar-broken`).
- **Dialogs** `.overlay` + `.dialog`; destructive confirms use a dialog, not inline buttons. **Toasts** `.toast`.
- **Board** `.board` / `.brow`: row with stage strip; filters All, Running, Needs you, Failed. `ready` counts as Needs you.
- Spinner `.spinner` 11px, `@keyframes spin`. Skeleton `.skel` while loading. Empty states `.empty` say what to do next.

## Accessibility and behaviour
Focus: 2px `--pri` outline, 2px offset, on every interactive element. Hit targets 40px (32px in dense rows).
Text contrast must hold in both themes; check both before a PR. Honour `prefers-reduced-motion` for spinners and
transitions (transitions are .12s, press .06s). Layouts work from 360px wide; no horizontal page scroll.
Errors are always visible (never a silent catch). After any UI server restart, print the new signed `?t=` link.

## Adding or changing UI
1. Reuse a class above; add a token before adding a literal. Add new classes next to their siblings in `styles.css`.
2. Put decisions in a pure module under `web/ui/src/` (like `stagePane.ts`) with tests in `test/`; relative imports in
   files that tests import need `.js` extensions (`tsc -p test` uses node16 resolution).
3. Update `sdlc-ui.js` `SELECTORS`; run `test/ui-automation.test.ts`.
4. Screenshots of every changed screen in the PR description, dark and light where colour changed.
