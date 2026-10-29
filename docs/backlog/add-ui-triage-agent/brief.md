# add-ui-triage-agent

Type: feature
Priority: P2 (normal)
Source: User request to enable the triage agent in the web dashboard (engine request E-8)

## Problem
In the web dashboard's "New item" screen (`#/new`), the button "Draft with the triage agent" is disabled and tagged with `Future · E-8`. Users currently must drop into the terminal or run `ai-sdlc-helper triage` via the ⌘K command palette with `--print` to get an AI-drafted backlog item from a bug/feature report. The dashboard lacks an interactive mechanism to run the triage agent, stream its thoughts/questions, and populate the draft brief into the editor.

## Expected behaviour
When a user clicks "Draft with the triage agent" on the New Item screen:
1. A modal or drawer opens prompting the user for an initial issue, bug, or feature report.
2. The web server starts a triage agent process for the project (using the project's triage prompt and Claude harness).
3. The conversation, reasoning, and progress are streamed to the browser via Server-Sent Events (SSE).
4. If the agent asks questions, the UI displays them and allows the user to submit answers back to the agent.
5. On completion, the generated `slug`, `type`, `priority`, `title`, and `brief` content are automatically populated into the New Item form fields and editor for review before saving.

## Decisions
- Backend adds a triage route (`POST /api/projects/:name/triage`) that initiates the triage agent and streams events via SSE.
- Interactive user answers are posted to `POST /api/projects/:name/triage/answer` and delivered to the agent process.
- The UI handles both interactive runs and quick non-interactive runs (equivalent to `--print`).
- The draft brief is loaded directly into the client-side editor state rather than committed immediately, giving the developer final review control before clicking "Save" or "Save and start".

## Scope
- In: `web/server/index.ts`, `web/ui/src/NewItem.tsx`, `web/ui/src/api.ts`, `src/triage.ts` (if streaming hooks or engine helpers are needed).
- Out of scope: E-14 (importing directly from GitHub issue URLs) which remains a separate future enhancement.

## Tests
- `web/test/server.test.ts`: Test triage API endpoint and streaming events.
- `test/triage.test.ts`: Verify triage agent output parsing and answer submission.
- Manual verification: Running the triage agent from the dashboard in `web/ui`.

## Docs
- Update `docs/web-ui.md` and `docs/design/web-ui/Roadmap.dc.html` marking E-8 as completed.

## Open questions
- none
