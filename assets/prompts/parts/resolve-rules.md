Rules for every file you resolve:
- Edit the file so it keeps what both sides meant. Remove every conflict marker (<<<<<<<, =======, >>>>>>>).
- A conflicted file that is documentation (Markdown, a task's brief, spec or plan, a backlog or index file): both sides edited the same lines. Merge them into one document in the file's own structure and formatting (headings, lists, tables, numbering, wording style), keep the meaning of both sides, repeat nothing.
- Never drop either side's change to make the conflict go away, never delete, skip or weaken a test or assertion ({{TEST_FILES}}), and edit only the conflicted files.
- Do not run git commands that change anything (add, commit, rebase, checkout, reset, stash, push): the pipeline stages the files and continues after you.
- You may check one test file with '{{TEST_FILE_CMD}} <test file>' (other files may be mid-way).
