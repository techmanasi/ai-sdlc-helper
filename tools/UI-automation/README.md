# UI automation: `sdlc-ui.js`

A plain browser script that reads and drives the web UI (`ai-sdlc-helper ui`) from inside the page. An agent or a
person can read one value or press one button with a single call, without reading the whole DOM each time.

## Load it

The script sets `globalThis.sdlcUI` and keeps a copy of itself in the page's `localStorage`.

- **First time**: paste the contents of `sdlc-ui.js` into the browser console, or send them as one Chrome automation
  `javascript_tool` call.
- **After a page reload, on the same origin**: `eval(localStorage.getItem('sdlc-ui-tool'))`.

Loading it from another port does not work. The browser blocks a fetch or `<script src>` from a second local port, so
the script is pasted instead.

## Use it

Start with `sdlcUI.snapshot()`, a short summary of the current screen. `sdlcUI.help()` lists every function.

| Area | Functions |
|---|---|
| Any screen | `snapshot()`, `top()` (project, running, need-you and failed counts), `toasts()`, `errors()`, `go('/board')`, `route()` |
| Board | `board()` (each row: slug, run or item, status, stage strip, PR, actions), `boardShow('Failed')`, `boardFilter(text)`, `pick(slug)`, `rowAction(slug, 'Open')` |
| Run page | `run()`, `stages()`, `await stage('Review')` (its steps), `output(n)`, `questions()`, `answer(n, text)`, `recovery()`, `env()`, `await setEnv('SDLC_BASE', 'main')`, `runOptions()`, `autoAccept(true)`, `costTable()`, `await openDoc('spec-1.md')`, `closeDialog()` |
| New item | `await newItem({ slug, type: 'bug', priority: 'P1', title, brief, when, useDefaults })` fills the form and reports the live branch line and command. `newItemDefaults(false)` toggles the stage table, `newItemWhen('later')` chooses When, `newItemStages()` reads the summary or pickers. It does not save: call `click('Save and start')` or `click('Add to board')` after it. |
| Anything else | `click(label, within?)` finds a button by its label, exact match first, then a match on the start. When the button is missing or disabled it throws, and the error lists the buttons that are there. `panel(title)`, `buttons(within?)`, `setValue(el, v)`, `setChecked(el, on)`, `waitFor(selectorOrFn)` |

Inputs are set the way the app (Preact) sees them: the native value setter, then an `input` or `change` event.

## When the UI changes

Every class, id and aria-label the tool depends on is in `SELECTORS`, at the top of `sdlc-ui.js`. Buttons are found by
their label.

`test/ui-automation.test.ts` loads the script as a page would. It fails when a selector no longer appears in
`web/ui/src`. Any PR that changes the UI's markup or button labels updates this tool in the same PR (see `AGENTS.md`).
