# Specification: edit-backlog-item-in-ui

Type: feature · Priority: P2 (normal)
Sources: `brief.md`, `decisions.md` (Round 1, binding).

## 1. Summary

The web UI can add a backlog item but cannot change it. This feature adds an **edit mode** to the existing New item form. It lets the developer change an item's brief (`<backlogDir>/<slug>/brief.md`) and its index line (`<backlogDir>/index.md`) **only while the item's pipeline has never started**. The edit is saved to the main working tree and left uncommitted. Overlapping edits are caught with a version hash, the same way the settings editor (`src/config/edit.ts`) does it.

Out of scope: renaming or deleting an item, committing the change, editing a run's logs or its spec and plan documents, and editing an item whose pipeline has started (Decisions Q1, Q5).

## 2. Definitions

- **Known item**: index.md has a line for the slug (`- [<marker>] \`<slug>\` …`, as `parseIndex` reads it). A slug with no such line is unknown, even if `<slug>/brief.md` exists (Decision Q7).
- **Index line parts** (as `parseTitle` reads them): the checkbox marker (` `, `x`/`X`, `!`, `~`), the type label (`Feature:` / `Bug:`, optional), the **title**, and an optional trailing `(blocked: …)` or `(parked: …)` note.
- **Started**: the item's pipeline has started if **any** of these exist:
  - a run record for the slug in the run registry (whatever state the record shows: running, paused, interrupted, stopped, failed, done or refused);
  - the run's worktree;
  - a local or `origin` branch `<branchPrefix><slug>` (what makes `backlogItems` report `in-progress`);
  - an in-place run (`<backlogDir>/<slug>/logs/status.json` in the main working tree).

  A leftover `<slug>.discarded` marker in the registry does **not** count as started. Discarding a run is how the developer makes an item editable again (Decision Q1: "stop execution and discard all changes").
- **Editable item**: a known item that is not started, is not completed (marker `x`/`X`), and is not archived (its line is under `## Archive` in index.md). Pending, blocked (`!`) and parked (`~`) items that meet these rules are editable.
- **Version**: one sha256 hex hash, made the way `hashOf` in `src/config/edit.ts` makes it, over the item's brief.md text **and** its own index line. A missing brief.md counts as empty text. Changes to other lines of index.md do not change the version (Decisions Q3, Q7).

## 3. Behaviour

### 3.1 Edit action (UI)

- Every backlog card on the Board and every run page has an **Edit** action for its slug.
- On an editable item, Edit opens the New item form in edit mode for that slug.
- On an item that is not editable, Edit still opens the form, but read-only (see 3.2), and the form shows the reason:
  - started: "The pipeline for `<slug>` has started. To change the brief, stop the run and discard it, then edit."
  - completed or archived: the item is finished and cannot be edited.

### 3.2 Edit mode of the New item form

- It reuses the New item page (`NewItem.tsx`) and its Markdown editor with preview (write / split / preview). No second form is built.
- The heading says the form is editing `<slug>`, not adding a new item.
- Fields are filled from the server's read response (3.4):
  - **Slug**: shown, cannot be changed. The "already in the backlog" check does not apply.
  - **Title (the index line)**: the index line's title, without the type label and without the blocked/parked note.
  - **Type**: the index line's label. If the line has none, the brief's first `Type:` line. If neither exists, `feature`.
  - **Priority**: the brief's first `Priority:` line, mapped onto the options the way `mapPriority` maps a draft (P0–P3 prefix; otherwise P2 (normal) with a note that the value is not an option).
  - **Brief**: the full brief.md text exactly as stored. For an indexed item without brief.md, the empty New item template filled with the slug, type and priority (Decision Q7).
- The triage-agent drawer, "Import from issue URL" and **Save and start** are not offered in edit mode. Only **Save** and **Cancel** are shown (Decision Q6).
- The form says, near Save, that the change is left uncommitted in the working tree, like Save on a new item.
- If the item is not editable when the form loads (started, completed or archived), every field and Save are read-only (disabled), and the form shows the reason from 3.1.
- Cancel and a successful Save go back to the page the form was opened from: the Board, or that item's run page (Decision Q6). A successful Save also shows a toast, e.g. "Saved `<slug>` (uncommitted)".
- A refused save keeps the form and the developer's text, and shows the server's message. On a stale version, the message tells the developer to reload, as the settings editor does.

### 3.3 What Save writes

Save writes **only** the main working tree's `<backlogDir>/<slug>/brief.md` and that item's single line in `<backlogDir>/index.md`. Nothing else changes.

- **brief.md**: the submitted brief text, with a trailing newline added if it has none. The brief's header line stays as the developer wrote it and is not rewritten from the title (Brief decision). Then:
  - if the Type select differs from the value it was loaded with, the value on the brief's first `Type:` line is replaced with the new type;
  - if the Priority select differs from the value it was loaded with, the value on the brief's first `Priority:` line is replaced with the new priority;
  - if the brief has no such line, no line is added, and the form tells the developer that the field was not saved into the brief (Decision Q4).
  - If brief.md did not exist (indexed item with no brief), Save creates it, and its folder if needed.
- **Index line**: rebuilt as `- [<marker>] \`<slug>\` - <Label>: <title>[ (<blocked|parked>: <reason>)]`, where:
  - `<marker>` is kept exactly as it was (the checkbox and state are never changed);
  - `<Label>` is `Feature` or `Bug`, from the Type field. It is written even if the line had no label before (Decision Q4);
  - `<title>` is the submitted title, trimmed;
  - an existing `(blocked: …)` or `(parked: …)` note is kept exactly as it was.
  - The line stays in place. Every other line of index.md, and the file's line endings and trailing newline, are unchanged.
- Save never creates a second index line or a second item folder, and never changes the slug.
- The change is not committed.
- Save validates everything (section 5) before it writes either file, so a refused save writes nothing. Each file is written in one step (temporary file plus rename, as `editSettings` does), so a reader never sees a half-written file.

### 3.4 Server route

One route, next to the existing add-item route (`POST /api/projects/<project>/backlog` in `web/server/index.ts`), with a read and a write operation for one slug. It is backed by a new function in `src/backlog/index.ts` beside `addBacklogItem`. Plan picks the exact paths and methods. The existing `GET …/backlog/<slug>` response (`{ slug, brief }`) must keep working for its current callers.

**Read** (load an item for editing). Input: project, slug. Output (200):
- `slug`
- `title`: the index line's title
- `type`: `feature` | `bug` (as filled in 3.2)
- `priority`: the brief's `Priority:` value, or null
- `brief`: brief.md text, or null when there is no brief.md
- `marker` / `status`, and `archived`
- `editable`: boolean
- `reason`: text, set when `editable` is false
- `hash`: the version (section 2)

**Write** (save an edit). Input: project, slug, `title`, `type`, `priority` (only when changed; see 3.3), `brief`, `hash`. Output (200): `{ ok: true, index: <path>, brief: <path>, hash: <new version> }`.

The backlog function re-checks every rule at write time (known, editable, not started, version), so a run started, or a file changed, after the form was loaded is still refused.

## 4. Inputs and validation

| Input | Rule | On failure |
|---|---|---|
| slug (URL) | must be a known item; must pass the existing safe-slug checks | 404 if unknown |
| title | one non-empty line after trimming (same rule as add) | 400 `title must be one non-empty line` |
| type | `feature` or `bug` | 400 `type must be feature or bug, not '<v>'` |
| priority | when given, one of the four options | 400 |
| brief | non-empty after trimming (same rule as add) | 400 `brief must not be empty` |
| hash | required text | 400 if missing or not text |

## 5. Error cases

Every error writes nothing: brief.md and index.md stay byte-for-byte the same.

1. **Unknown slug** (no index line, even if brief.md exists): 404, `<slug> is not in <backlogDir>/index.md`. This applies to read and write.
2. **Started item**: write is refused with 409 (Plan may pick 400, but it must differ from success and come with the message). The message says the pipeline has started and the developer must stop and discard the run to edit. Read answers 200 with `editable: false` and that reason.
3. **Completed or archived item**: write is refused (400) with a message saying the item is completed or archived and cannot be edited. Read answers 200 with `editable: false`.
4. **Stale version**: the current version differs from the submitted `hash`. Write is refused (409) with a message in the settings editor's style: "`<slug>` changed since you opened it; reload and apply the change again". The response carries the current hash.
5. **Invalid field** (section 4): 400 with the message.
6. **index.md missing**: the slug is unknown, so 404.
7. **Write failure** (filesystem error): 500 with the error. The temporary file is removed.

## 6. Acceptance criteria

1. Saving an edit of a pending item with a new title, type, priority and brief text changes that item's brief.md and its index line as section 3.3 says. Every other line of index.md and every other file stays byte-for-byte the same, and no git commit is made.
2. The saved index line keeps the original checkbox marker and any `(blocked: …)` / `(parked: …)` note. Blocked and parked items stay blocked and parked.
3. Saving never adds an index line or an item folder. The slug in the line and the folder name are unchanged. The write takes no field that renames the item.
4. A write with a stale hash, where brief.md or the item's own index line changed after reading, is refused with the stale message, and nothing is written.
5. A change to a **different** item's index line between read and write does not make the version stale. The save succeeds.
6. A write for an item that has a run record (any state: running, paused, interrupted, stopped, failed, done, refused), a worktree, a `<branchPrefix><slug>` branch, or an in-place `logs/status.json` is refused, and nothing is written. Read reports `editable: false` with the stop-and-discard reason.
7. Once a run is discarded (record, worktree and branch removed; a `.discarded` marker may remain), the item is editable again.
8. A write or read for a slug with no index line returns 404, even when `<slug>/brief.md` exists. Nothing is written.
9. A completed (`[x]`) or archived item is refused, and nothing is written.
10. An indexed item without brief.md reads with `brief: null` and the version of empty text. Saving creates brief.md.
11. Changing only the Type select rewrites the index label and the brief's first `Type:` value. Changing only Priority rewrites the brief's first `Priority:` value. A brief with no such line is saved without one, and the response or form says the field was not saved into the brief. Leaving the selects unchanged leaves those brief lines as the developer typed them.
12. Invalid title, type, priority or brief are refused with the add-item messages, and nothing is written.
13. In the UI, the Board card and the run page show Edit. On an editable item it opens the New item form in edit mode with the slug locked, the fields filled, only Save and Cancel, and the uncommitted note. On a started, completed or archived item, the form opens read-only and shows the reason.
14. After Save or Cancel, the UI returns to the page the edit was opened from.

## 7. Tests (required)

Tests in `test/` exercise the real backlog function and the server route (per CLAUDE.md, no assertions on Markdown text of docs):
- An edit changes brief.md and the index line and nothing else (criteria 1–3).
- A stale version is refused and nothing is written (criterion 4). An unrelated index change is not stale (criterion 5).
- An item with a started pipeline (at least a running run record, and a branch with no record) is refused (criterion 6).
- An unknown slug is a 404 and the slug is never changed (criteria 3, 8).
- Completed or archived items are refused, and an indexed item with no brief can be saved (criteria 9, 10).

## 8. Docs

- `docs/web-ui.md`: describe the Edit action on backlog items: where it appears, that it works only before the pipeline starts (stop and discard a run to edit again), that the slug cannot change, that the change is left uncommitted, and the stale-version message.

## 9. Dependencies

No new packages.
