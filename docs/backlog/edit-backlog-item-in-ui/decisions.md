# Decisions for edit-backlog-item-in-ui

## Round 1 (2026-11-09)

### Q1: Which copy of brief.md does an edit change once the item has a worktree?
`start` (src/runs/index.ts) copies brief.md from the main working tree into the run's worktree once, when the worktree is made. After that, the run only reads the worktree copy. The brief puts an Edit action on every run page, including stopped, failed or waiting runs that already have a worktree. If Save changes only the main working tree, those runs never see the edit. If it changes the worktree copy, the edit lands inside a run's tree, which discard-stage and restart treat as run state. Which file or files should Save write when a worktree exists?
**Suggested:** Save writes only the main working tree (brief.md and index.md), as it does for a new item. When the item has a worktree, the form shows a note: "This run uses its own copy of the brief; the edit applies when the run is discarded and started again."
**Answer:** Allow edit only when the pipeline has not yet started. Once started, no editing of backlog, if you want to make any changes, stop execution and discard all changes

### Q2: What counts as "a run in progress" that blocks editing?
An item can be `in-progress` in the backlog because its branch exists, even when no pipeline process is running (stopped, failed, or waiting on questions or permissions). The settings editor's `activeRuns` (web/server/index.ts) counts only runs whose state is `running` or `paused`. Which states should make the form read-only and the server refuse the save?
**Suggested:** Only run states `running` and `paused`, the same test `activeRuns` uses. The server checks again at save time, so a run started after the form was loaded is still refused.
**Answer:** running, paused, interrupted, check if failed is applicable

### Q3: What does the version hash cover?
One save changes two files. index.md also changes whenever any other item is added, archived or ticked off, so hashing the whole index.md would refuse edits for unrelated changes. What should the hash the form loads and sends back cover?
**Suggested:** A single hash (sha256, as `hashOf` in src/config/edit.ts makes) of the item's brief.md text plus its own index line. The save is refused, and nothing is written, when either of those changed. Changes to other index lines do not count.
**Answer:** accept

### Q4: How do the Type and Priority fields relate to the brief's `Type:` and `Priority:` lines?
In the New item form, Type and Priority only seed the template; Priority is stored nowhere but the brief's `Priority:` line. In edit mode, the fields are filled from the index line and the brief (the brief says so). If the developer then changes the Type or Priority select, what should Save do to the brief text, and what if the brief has no such line?
**Suggested:** Type sets the index line's label (`Feature:` or `Bug:`; the label is written even if the line had none) and replaces the value on the brief's first `Type:` line. Priority replaces the value on the brief's first `Priority:` line. When the brief has no such line, it is left without one and the form says the field was not saved into the brief. The index line keeps its checkbox marker and any `(blocked: …)` or `(parked: …)` note as they were.
**Answer:** accept

### Q5: Which items get the Edit action?
The brief says "every backlog card on the Board and every run page". Completed items (`[x]`) and archived items (under `## Archive` in index.md) are already finished, and the Completed page shows their brief as read-only. Should those be editable too?
**Suggested:** Edit is offered for pending, in-progress, blocked and parked items that are not archived. Completed and archived items have no Edit action, and the server refuses a save for them with a 400 that says why.
**Answer:** Allow edit only when the pipeline has not yet started. Once started, no editing of backlog, if you want to make any changes, stop execution and discard all changes

### Q6: Is "Save and start" offered in edit mode?
The New item form has Save and "Save and start". "Save and start" in edit mode would save an existing item and then start (or resume) its run.
**Suggested:** Edit mode shows only Save and Cancel. After a save, the form goes back to the page it was opened from (the Board, or the run page).
**Answer:** accept

### Q7: Items with only half of their entry: a line without brief.md, or brief.md without a line
The backlog lists both kinds of incomplete entry: indexed items marked "no brief", and folders reported as "Not in index". The brief says an unknown slug is a 404 but does not say which side defines "known".
**Suggested:** A slug is known when index.md has a line for it. A slug without one is a 404, even if its brief.md exists. An indexed item without brief.md opens with the empty template, and Save creates brief.md. The hash of a missing brief is the hash of empty text.
**Answer:** accept
