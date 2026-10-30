## Dashboard run: split phase

This is a dashboard run, split phase. Read the report and the backlog, including the duplicate check above.

Choose a slug for each independent item that is not taken: no folder under the backlog directory and no line in `index.md` may use it. A slug has lowercase letters, digits and dashes only.

Write `{{ITEMS_FILE}}` as a JSON array with one entry per independent item:

```json
[{ "slug": "login-fails", "type": "bug", "priority": "P1 (high)", "title": "Login fails on Safari", "summary": "One or two sentences." }]
```

`type` is `bug` or `feature`. Write `[]` when there is nothing to add (for example, every part of the report is already in the backlog).

Do not write any brief, do not touch `index.md`, and ask nothing. Items are drafted one at a time afterwards.

End with a short prose summary of what you proposed and why.
