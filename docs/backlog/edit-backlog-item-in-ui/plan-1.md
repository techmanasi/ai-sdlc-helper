# Plan: edit-backlog-item-in-ui

Spec: `specs-1.md`. Decisions: `decisions.md` Round 1 (binding). No new packages.

## Overview

1. `src/backlog/index.ts`: two new functions beside `addBacklogItem`: `readBacklogEdit` (load) and `editBacklogItem` (save), plus small private helpers. All rules (known, finished, started, version, field checks) live here.
2. `src/index.ts`: export the new functions and types.
3. `web/server/index.ts`: a read route and a write route in the existing `what === 'backlog'` block. The existing `GET …/backlog/<slug>` stays as it is.
4. `web/ui/src/api.ts`, `App.tsx`, `NewItem.tsx`, `Board.tsx`, `Run.tsx`: the Edit action and the edit mode of the New item form.
5. Tests: `test/backlog-edit.test.ts` (the backlog functions) and new cases in `web/test/server.test.ts` (the routes).
6. Docs: `docs/web-ui.md`.

Order: step 1 → 2 → 3 → 4. Tests (step 5) are written first in the Red tests stage and need only steps 1–3.

## Step 1: `src/backlog/index.ts`

### Imports
- `import { readRecord } from '../runs/records.js';` (records.ts imports only `node:fs`, `node:path`, `../trace.js`, so there is no cycle. `src/runs/view.ts` and `completed.ts` import backlog, but records.ts does not.)
- `import { hashOf } from '../config/edit.js';` (the same sha256 hex the settings editor uses).
- Do **not** import `src/runs/index.ts` (`runWorktree`). Its logic is three lines, so copy it (see `startedReason`).

### Types (exported)
```ts
/** What the edit checks need besides the backlog place: the run registry (<git common dir>/sdlc-runs) and the worktree base. A RunContext fits. */
export interface EditPlace extends BacklogPlace { reg: string; wtBase: string }

export interface BacklogEditView {
  slug: string;
  title: string;                 // parseTitle(entry.rest).title
  type: 'feature' | 'bug';       // index label, else brief's first Type: (if feature|bug), else 'feature'
  priority: string | null;       // raw trimmed value of the brief's first Priority: line, or null
  brief: string | null;          // brief.md text, null when missing
  marker: string;                // ' ', 'x', 'X', '!', '~'
  status: Status;                // as deriveItem: completed / blocked / parked / in-progress (branch) / pending
  archived: boolean;
  editable: boolean;
  reason: string;                // '' when editable
  hash: string;
}

export interface ItemEdit { title: string; type: string; priority?: string; brief: string; hash: string }
export interface ItemEditResult { ok: true; index: string; brief: string; hash: string; notSaved: ('type' | 'priority')[] }

/** A refused edit: <status> is the HTTP status the web server answers with; <hash> is the current version (stale edits). */
export class BacklogEditError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly hash?: string) { super(message); }
}
```

### Private helpers
- `const PRIORITY_OPTIONS = ['P0 (security or data loss)', 'P1 (high)', 'P2 (normal)', 'P3 (low)']`. These are the same four options as `PRIORITIES` in `web/ui/src/NewItem.tsx:34`. The UI keeps its own copy because it is a separate bundle.
- `locateItem(place, slug)` returns `{ indexFile, text, lines, at, entry, line, archived } | null`:
  - `indexFile = path.join(root, backlogDir, 'index.md')`. Return null when the file is missing (error case 6).
  - `lines = text.split('\n')`. For each line `l`, strip one trailing `\r` and run the `parseIndex` regex on it (call `parseIndex(l)[0]`). `at` is the index of the **first** line whose slug is `slug`. Return null if there is none.
  - `line` is that line without its `\r`. `crlf` records whether it had one.
  - `archived`: there is a line `/^##\s+Archive/i` with index < `at` (same rule as `backlogItems`, done by line position).
- `briefFile(place, slug) = path.join(root, backlogDir, slug, 'brief.md')`. `readBriefText` returns the text or null.
- `versionOf(brief: string | null, line: string) = hashOf(`${brief ?? ''}\u0000${line}`)`. This covers the brief text and the item's own index line only (Decision Q3). A missing brief counts as `''` (Decision Q7).
- `briefType(text)`: first `/^[ \t]*Type:[ \t]*(\S+)/im` match, lowercased, when it is `feature` or `bug`, else null.
- `briefPriority(text)`: first `/^[ \t]*Priority:[ \t]*(.*)$/im`, value trimmed, or null.
- `replaceFirst(text, key: 'Type' | 'Priority', value)`: the regex `new RegExp(`^([ \\t]*${key}:[ \\t]*)(.*)$`, 'im')`. If it matches, replace that first line's value (keep the prefix and leading spaces) and return `{ text, done: true }`. Otherwise return `{ text, done: false }`. Use `[ \t]*`, not `\s*`, so the match never runs across lines.
- `startedReason(place: EditPlace, slug)` returns string | null. "Started" when any of these holds (spec §2):
  1. `readRecord(place.reg, slug) !== null` (any record, any state, including refused or unparsable `{}`);
  2. a worktree: `rec?.worktree` is an existing directory, or `path.join(place.wtBase, slug)` is a directory;
  3. `branchExists(place, slug, {})` (existing private function, local or `origin` `<branchPrefix><slug>`);
  4. `fs.existsSync(path.join(place.root, place.backlogDir, slug, 'logs', 'status.json'))` (in-place run).

  A `<reg>/<slug>.discarded` file is never looked at. The message is exactly the spec's: ``The pipeline for `<slug>` has started. To change the brief, stop the run and discard it, then edit.``
- `finishedReason(entry, archived)`: when the marker is `x`/`X` or the item is archived, return `` `<slug>` is completed or archived and cannot be edited``, else null.
- `atomicWrite(file, text)`: `mkdirSync(dirname, { recursive: true })`, write `${file}.${process.pid}.${Date.now()}.tmp`, then `renameSync`. On error, unlink the temp file and rethrow (same as `editSettings`, `src/config/edit.ts:66-73`).

### `export function readBacklogEdit(place: EditPlace, slug: string): BacklogEditView`
1. If `!safeSlug(slug)`, or `locateItem` returns null, throw `new BacklogEditError(404, `${slug} is not in ${place.backlogDir}/index.md`)`.
2. `parseTitle(entry.rest)` gives title and label type. `brief = readBriefText(...)`.
3. `type` = label type ?? `briefType(brief ?? '')` ?? `'feature'`. `priority = brief ? briefPriority(brief) : null`.
4. `reason = finishedReason(...) ?? startedReason(...) ?? ''`. `editable = !reason`.
5. `status`: marker `x`/`X` → completed, `!` → blocked, `~` → parked, otherwise `branchExists` → in-progress, else pending.
6. Return the view with `hash: versionOf(brief, line)`.

### `export function editBacklogItem(place: EditPlace, slug: string, edit: ItemEdit): ItemEditResult`
Every check runs before any write.
1. Unknown slug (as above): 404.
2. Field checks (400, same messages as `addBacklogItem`):
   - `type` must be `feature`/`bug`: ``type must be feature or bug, not '<v>'``.
   - title trimmed, non-empty, no `\r`/`\n`: `title must be one non-empty line`.
   - `brief` trimmed non-empty: `brief must not be empty`.
   - `priority`, when not undefined, must be one of `PRIORITY_OPTIONS`: ``priority must be one of P0 (security or data loss), P1 (high), P2 (normal), P3 (low), not '<v>'``.
   - `typeof hash !== 'string' || !hash`: `hash is required`.
3. `finishedReason` → 400. `startedReason` → 409.
4. Compute the current version from the brief and line as they are now. If it differs from `edit.hash`, throw `new BacklogEditError(409, `${slug} changed since you opened it; reload and apply the change again`, current)`.
5. Build the brief: `next = edit.brief.endsWith('\n') ? edit.brief : edit.brief + '\n'`. `loadedType` is computed exactly as in `readBacklogEdit` step 3 from the current files. The hash check guarantees these are the files the form loaded.
   - if `edit.type !== loadedType`: `replaceFirst(next, 'Type', edit.type)`. If not done, push `'type'` to `notSaved`.
   - if `edit.priority !== undefined`: `replaceFirst(next, 'Priority', edit.priority)`. If not done, push `'priority'`.
6. Build the index line: `` `- [${entry.marker}] \`${slug}\` - ${Label}: ${title}${note}` ``, where `Label` is `Bug`/`Feature` from `edit.type`. `note` is the original note copied byte for byte: take `entry.rest`, and if `/\s*\((blocked|parked):\s*(.*)\)\s*$/` (the `parseTitle` regex) matches, `note = ' ' + match[0].trim()`. Otherwise `''`. Put back the `\r` if the line had one. Replace `lines[at]` and `join('\n')`, so every other line, the line endings and the trailing newline stay as they were.
7. `atomicWrite(briefFile, next)` then `atomicWrite(indexFile, newIndexText)`. Filesystem errors are rethrown as they are (the server turns them into 500).
8. Return `{ ok: true, index: indexFile, brief: briefFile, hash: versionOf(next, newLine), notSaved }`.

Update the file's header comment (line 1) to mention edits too.

## Step 2: `src/index.ts`
Line 18: add `readBacklogEdit, editBacklogItem, BacklogEditError, type EditPlace, type BacklogEditView, type ItemEdit, type ItemEditResult` to the existing export from `./backlog/index.js`.

## Step 3: `web/server/index.ts` (block `if (what === 'backlog')`, lines 243-258)
Import `readBacklogEdit, editBacklogItem, BacklogEditError` from wherever `addBacklogItem` is imported now (the import list at line 11).

Routes. `readBody` reads only POST bodies, so the write is a POST:
- **Read**: `GET /api/projects/<p>/backlog/<slug>/edit` (`method === 'GET' && parts[3] && parts[4] === 'edit'`). Put this **before** the existing `GET …/backlog/<slug>` branch, and tighten that branch to `parts.length === 4` so its `{ slug, brief }` reply is unchanged for `Run.tsx:279`.
- **Write**: `POST /api/projects/<p>/backlog/<slug>` (`method === 'POST' && parts.length === 4`).

Both use `slugOf(parts[3])` (400 for a bad slug, as now) and `ctx` (the `RunContext` from `contextFor(p)`), which already has `root, backlogDir, branchPrefix, reg, wtBase` and fits `EditPlace`.

Error mapping, in a small local `editErr(e)`:
- `BacklogEditError` with `hash` (stale): `return send(409, { ok: false, error: e.message, hash: e.hash })`. Check how `failure()` in `web/ui/src/api.ts` reads the error field and use the same key as the main error handler (`web/server/index.ts:509`), so the UI shows the message.
- other `BacklogEditError`: `throw new HttpError(e.status, e.message)`.
- anything else: rethrow (the handler at line 509 answers 500).

Write body: `{ title, type, priority?, brief, hash }`. Pass `priority` only when it is a string. A `slug` field in the body is ignored (spec criterion 3). Reply 200 with the `ItemEditResult`.

## Step 4: Web UI

### `web/ui/src/api.ts` (beside `brief`/`addItem`, line 171)
- `export interface BacklogEditView { slug; title; type: 'feature' | 'bug'; priority: string | null; brief: string | null; marker: string; status: string; archived: boolean; editable: boolean; reason: string; hash: string }`
- `editView: (project, slug) => call<BacklogEditView>('GET', `${p(project)}/backlog/${enc(slug)}/edit`)`
- `editItem: (project, slug, body: { title; type; priority?; brief; hash }) => call<{ ok: true; index: string; brief: string; hash: string; notSaved: string[] }>('POST', `${p(project)}/backlog/${enc(slug)}`, body)`

### `web/ui/src/App.tsx`
- Route `/edit/<from>/<slug>`, with `from` ∈ `board` | `run`. `go()` drops query strings (line 80-85), so the origin goes in the path. Before the `/new` branch (line 148): `else if (route.startsWith('/edit/')) { const [, , from, s] = route.split('/'); screen = <NewItem key={route} taken={[]} edit={{ slug: decodeURIComponent(s), back: from === 'run' ? `/run/${s}` : '/board' }} />; }`.

### `web/ui/src/NewItem.tsx`
`NewItem({ taken, edit }: { taken: string[]; edit?: { slug: string; back: string } })`:
- When `edit` is set:
  - Skip the triage `useEffect` (no drawer).
  - On mount, `api.editView(project, edit.slug)`. Set slug, title, `type`, priority via `mapPriority(view.priority ?? '')` (when `view.priority` is null use `P2 (normal)` with the note), and brief = `view.brief ?? template(slug, type, mappedPriority)` (Decision Q7). Keep `loaded = { type, priority, hash, editable, reason }` in state. Load errors go to `ErrorBox`.
  - Heading: `Edit backlog item <slug>` instead of "New backlog item". Hide the "Draft with the triage agent" and "Import from issue URL" buttons and the drawer.
  - Slug input is `readOnly`. The status line under it is not shown (the "already in the backlog" check does not apply).
  - `const locked = !loaded?.editable || busy`. Every input, select, textarea, "Insert template" and Save get `disabled={locked}`. When `!editable`, show `loaded.reason` in a banner above the form.
  - The index preview line shows the loaded marker (e.g. `- [!]`).
  - Buttons: only **Save** and **Cancel**. Cancel goes to `edit.back`. Keep the note "writes in the main working tree · not committed".
  - `saveEdit()`: `api.editItem(project, slug, { title, type, brief, hash: loaded.hash, ...(priority !== loaded.priority ? { priority } : {}) })`, where `loaded.priority` is the mapped option value. On success, show the toast ``Saved `<slug>` (uncommitted)``, plus ` · Type/Priority not saved into the brief (no such line)` when `notSaved` is not empty, then `go(edit.back)`. On error, `setError(message)` and keep the form. The stale message from the server already says to reload.
- When `edit` is not set, the New item behaviour is unchanged.

### `web/ui/src/Board.tsx`
- Backlog card (line 137): next to Open, add `<a href={`#/edit/board/${i.slug}`} onClick=… go(`/edit/board/${i.slug}`)>Edit</a>`.
- `RunCardView` (line 32): the same Edit link for `r.slug`. It opens read-only with the reason, because the item has started.

### `web/ui/src/Run.tsx`
- Header row with `<h1 class="mono">{slug}</h1>` (line 333): add a `btn btn-s` "Edit" link to `/edit/run/${slug}`.

## Step 5: Tests (Red tests stage)

### `test/backlog-edit.test.ts` (new): imports `readBacklogEdit`, `editBacklogItem`, `BacklogEditError` from `../src/backlog/index.js`, and `runContext` from `../src/runs/index.js`
Fixture, following `repoWithRun` in `test/view.test.ts:33`: a temp git repo (`tmp`, `write` from `test/helpers.ts`), `sdlc.config.json` as in view.test, and index.md:
```
# Backlog

- [ ] `one` - Feature: First thing
- [!] `blk` - Bug: Blocked thing (blocked: waits on api)
- [~] `prk` - Parked no label (parked: later)
- [x] `done` - Feature: Finished
- [ ] `nobrief` - Feature: No brief yet

## Archive

- [ ] `old` - Feature: Archived
```
Add a brief.md for `one`, `blk`, `prk`, `done` and `old` (`one` has `Type: feature` and `Priority: P2 (normal)` lines; `prk` has neither), and an unindexed `stray/brief.md`. git init + commit. `ctx = runContext(root, { ...env, SDLC_WT_BASE: <tmp>/wts })` gives the place.

Cases:
1. **Edit changes only the two files** (criteria 1–3): read `one`, then edit with a new title, type `bug`, priority `P1 (high)` and new brief text containing `Type: feature`/`Priority: P2 (normal)`. Expect: brief.md equals the submitted text with `Type: bug` and `Priority: P1 (high)`, plus a trailing newline. The index line becomes ``- [ ] `one` - Bug: <new title>``. Every other index line is byte-identical. `git status --porcelain` lists only those two paths (and the commit count is unchanged). No new folder. The returned `hash` equals a fresh `readBacklogEdit(...).hash`.
2. **Marker and note kept** (criterion 2): edit `blk` and `prk`. The lines keep `[!]` + ` (blocked: waits on api)` and `[~]` + ` (parked: later)`. `prk` gains the `Feature:` label. `notSaved` holds `type`/`priority` when those changed and the brief has no such line, and the brief has no added line.
3. **Unchanged selects keep the brief lines** (criterion 11): edit `one` with the loaded type, no `priority`, and a brief whose `Type:` line says something else. The brief is saved exactly as sent.
4. **Stale** (criterion 4): read `one`, change brief.md on disk, then edit. Expect `BacklogEditError` with status 409, the message matching `changed since you opened it; reload`, a `hash` equal to the current version, and both files byte-identical to before the call. Repeat with only `one`'s index line changed.
5. **Unrelated change is not stale** (criterion 5): read `one`, rewrite `blk`'s line, edit `one`. It succeeds, and `blk`'s new line is kept.
6. **Started** (criterion 6): one sub-case each, every one 409 with nothing written and `readBacklogEdit` showing `editable: false` with a reason matching `stop the run and discard it`: (a) a record file `<ctx.reg>/one.json` with `state: 'running'`; (b) a record with `state: 'exited', exit_code: '1'` (failed); (c) no record but `git branch sdlc/one`; (d) only the directory `<wtBase>/one`; (e) only `Docs/backlog/one/logs/status.json`.
7. **Discarded is editable** (criterion 7): only `<ctx.reg>/one.discarded` exists, and the edit succeeds.
8. **Unknown** (criterion 8): `stray` (has a brief, no line) and `nope`. Read and edit throw status 404 with message `<slug> is not in Docs/backlog/index.md`. Nothing changes.
9. **Finished** (criterion 9): `done` and `old` give status 400, and nothing is written. Read gives `editable: false` and `archived: true` for `old`.
10. **No brief** (criterion 10): read `nobrief` gives `brief: null` and `type: 'feature'`. Editing with the returned hash succeeds and creates `nobrief/brief.md`. Writing an empty `nobrief/brief.md` before reading gives the same hash as no file (missing brief = empty text).
11. **Invalid fields** (criterion 12): a two-line title, type `chore`, priority `P9`, a blank brief, and a missing hash each give status 400 with the add-item messages, and the files are unchanged.

### `web/test/server.test.ts` (new `describe('editing a backlog item')`)
Use the existing fixture (`ask-one`, `perm-one`, server started with `SDLC_WT_BASE`):
- `GET /api/projects/shop/backlog/ask-one/edit` returns 200 with `editable: true`, `title: 'Ask first'`, `type: 'feature'`, `brief: '# ask-one\n'` and a hash. `POST /api/projects/shop/backlog/ask-one` with a new title and that hash returns 200. index.md has the new line. `GET …/backlog/ask-one` still answers `{ slug, brief }`.
- A second POST with the old hash returns 409 with `hash` in the body and an unchanged file.
- `GET …/backlog/nope/edit` and `POST …/backlog/nope` return 404.
- Start `ask-one` (`POST /api/projects/shop/runs/ask-one/start`), wait with `until` for its record. Then the edit read gives `editable: false`, and the POST returns 409 with index.md and brief.md unchanged.
- A bad type returns 400.

Run each new file on its own with `ai-sdlc-helper run --file test/backlog-edit.test.ts` and `ai-sdlc-helper run --file web/test/server.test.ts`.

The UI (`web/ui/src`) has no test harness in this repo. Check it in the Review stage and by hand (`npm run build`, `node dist/bin.js ui`).

## Step 6: Docs (separate step, not tested)
`docs/web-ui.md`: a short "Editing a backlog item" section. Edit is on Board cards and run pages. It works only before the pipeline starts (to edit again, stop the run and discard it). Slug locked. Save and Cancel only. The change is left uncommitted in the main working tree. Type/Priority rewrite the brief's first `Type:`/`Priority:` line, and nothing is added when the line is missing. The stale-version message: reload and apply the change again.

## Dependencies
- none
