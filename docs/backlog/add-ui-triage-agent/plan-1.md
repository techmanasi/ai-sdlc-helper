# Plan: add-ui-triage-agent

Source: `specs-1.md` (binding) and `decisions.md` Rounds 1–5. Section numbers (§) refer to the spec.

## Dependencies
- none

No new packages. Everything uses Node 18 built-ins (`node:child_process`, `node:fs`, `node:crypto`) and what the package already has. The browser reads the POST stream with `fetch` and `ReadableStream.getReader()` plus `TextDecoder`, which every supported browser has.

## Overview of the change

| Layer | File | What |
|---|---|---|
| Engine | `src/triage.ts` | Dashboard-run helpers: run ids, worktree set-up and removal, prompts, `items.json` parsing, drafts, questions, stream-json parsing |
| Engine | `src/index.ts` | Export the new helpers, plus `alive` and `killTree` from `runs/records.ts` |
| Assets | `assets/prompts/triage-split.md`, `triage-item.md`, `triage-answered.md`, `triage-continue.md` | Dashboard-run instruction texts |
| Server | `web/server/triage.ts` (new) | Run lifecycle, registry pointer, SSE fan-out, routes of §6, start-up recovery, `close()` |
| Server | `web/server/index.ts` | Wire the triage module into `api()`, `startServer` and `close()`; new `ServerOptions.claude` |
| UI | `web/ui/src/api.ts` | Types and client calls; SSE reader over `fetch` |
| UI | `web/ui/src/NewItem.tsx` | Enabled button, drawer, P0 option, priority mapping, reopen on load |
| Tests | `test/triage.test.ts`, `web/test/server.test.ts` | Acceptance criteria 1–22 |
| Docs | `docs/web-ui.md`, `docs/design/web-ui/Roadmap.dc.html` | §10 |

Spec §8 puts the server work in `web/server/index.ts`. `index.ts` is already ~300 lines, so the triage routes and lifecycle go in a sibling module, `web/server/triage.ts`. `index.ts` imports it and dispatches to it. It is still the web server, and it still reaches the engine only through `'ai-sdlc-helper'`.

---

## Step 1: Engine helpers in `src/triage.ts`

Add these after `triageTools` (L71-75). Leave the existing `triage`, `triagePrompt`, `runClaude` and `commitTriage` unchanged, so the CLI keeps its behaviour (R2 Q1).

New imports: `crypto` from `node:crypto`; `pickBase`, `type RunContext` from `./runs/index.js` (no cycle: `runs/index.ts` does not import `triage.ts`); `parseQuestions`, `answerQuestions` from `./runs/view.js`; `ASSETS_DIR`, `CONFIG_FILE` from `./util.js`.

### 1.1 Types
```ts
export type TriageState = 'running' | 'choosing' | 'waiting' | 'ready' | 'interrupted' | 'stopped' | 'failed' | 'done';
export type DraftStatus = 'pending' | 'saved' | 'skipped';
export interface TriageItem { slug: string; type: string; priority: string; title: string; summary: string }
export interface TriageDraft { slug: string; type: 'bug' | 'feature'; priority: string; title: string; brief: string }
export interface TriageQuestion { id: string; text: string; suggested: string }
export interface TriageStreamPart { sessionId?: string; texts: string[]; tools: { name: string; summary: string }[] }
export const TRIAGE_DIR = '.triage';
```

### 1.2 `newRunId(date = new Date()): string`
Returns `YYYYMMDD-HHMMSS-<4 hex>`, for example `20261030-142501-a3f9`, using `crypto.randomBytes(2).toString('hex')`. This matches `/^[a-z0-9][a-z0-9-]*$/` (§3.1).

### 1.3 `triageRunDir(backlogDir: string, runId: string): string`
Returns the run folder relative to the worktree: `${backlogDir}/.triage/${runId}`.

### 1.4 `createTriageWorktree(ctx: RunContext, runId: string): { worktree: string; branch: string; base: string }`
This follows `start` (`src/runs/index.ts` L217-256) but does not take `withStartLock` and writes no run record.
1. `wt = path.join(ctx.wtBase, \`triage-${runId}\`)`, `branch = \`${ctx.branchPrefix}triage-${runId}\``.
2. `base = pickBase(ctx)`. If it is empty, throw `Error('the repository has no commit to start the branch from; commit first, or set SDLC_BASE')`. This is `start`'s text at L223 (§7.1).
3. If `wt` exists, throw `` `${wt} already exists` ``. If the branch exists (`git show-ref --verify --quiet refs/heads/<branch>`), throw `` `branch ${branch} already exists` ``. Neither check creates anything.
4. `fs.mkdirSync(path.dirname(wt), { recursive: true })`, then `git -C <root> worktree add <wt> -b <branch> <base>`. If it fails, throw with git's stderr (last line, trimmed). Nothing else is created yet, but call `removeTriageWorktree` anyway in case git left a half-made folder or branch.
5. Wrap steps 5–7 in try/catch. If anything throws, call `removeTriageWorktree(ctx, wt, branch)` and rethrow (§7.1: nothing left behind).
6. Copies (§3.1):
   - `sdlc.config.json`: copied from `ctx.root` when it is missing in `wt` and present in the root (as `start` L247-250).
   - `<backlog>/index.md`: copied from `ctx.root` when present there, overwriting the worktree's file.
   - Every directory `d` under `<root>/<backlog>/` that has `brief.md`, where `<wt>/<backlog>/<d>/brief.md` does not exist: `mkdir` and copy. Skip the `.triage` directory.
7. Return `{ worktree: wt, branch, base }`.

A local `git` helper with `ctx.env` is needed. Use the same shape as `runs/index.ts` L44-45: `spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })`.

### 1.5 `removeTriageWorktree(ctx: RunContext, worktree: string, branch: string): void`
1. If `worktree` exists: `git worktree remove --force <wt>`. If that fails, `fs.rmSync(wt, { recursive: true, force: true })`.
2. `git worktree prune`.
3. `git branch -D <branch>` (status ignored).

This is the same sequence as `discard` (L342-344).

### 1.6 Prompts
A small loader: `const triageText = (name: string, values: Record<string,string>) => fs.readFileSync(path.join(ASSETS_DIR, 'prompts', \`triage-${name}.md\`), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (all, k) => k in values ? values[k] : all).trim()`.

- `triageSplitPrompt(root: string, report: string, runDir: string, { env } = {}): string`
  Returns `triagePrompt(root, report, { headless: true, env })` + `\n\n` + `triageText('split', { RUN_DIR: runDir, ITEMS_FILE: \`${runDir}/items.json\` })`.
  The split never asks questions (§5.4 puts questions in item sessions only), hence `headless: true`.
- `triageItemPrompt(root: string, report: string, item: TriageItem, runDir: string, { headless, env }): string`
  Returns `triagePrompt(root, report, { headless, env })` + `\n\n` + `triageText('item', { SLUG, TYPE, PRIORITY, TITLE, SUMMARY, RUN_DIR, QUESTIONS_FILE: \`${runDir}/${slug}-questions.md\`, QUESTIONS })`.
  `QUESTIONS` is an interactive-only paragraph from the same asset: write questions to the file and end the turn, never AskUserQuestion. When `headless` is true it is replaced by `''`, so a quick item prompt has `triagePrompt`'s headless line and no questions instruction (§5.2).
- `triageAnsweredMessage(questionsFile: string): string` → `triageText('answered', { QUESTIONS_FILE })`.
- `triageContinueMessage(): string` → `triageText('continue', {})`.

`triagePrompt` throws `'the triage prompt is missing from this installation'` when the skill is missing. The server maps that to 400 (§6).

### 1.7 `parseTriageItems(file: string, label: string): TriageItem[]`
`label` is the file as shown in messages, for example `Docs/backlog/.triage/<runId>/items.json`. The function throws `Error` with a message that names the label and the problem (§7.2):
- missing: `` `${label} is missing` ``;
- not JSON: `` `${label} is not valid JSON: <parser message>` ``;
- not an array, or an entry missing one of the five string fields: `` `${label} must be a list of { slug, type, priority, title, summary }: entry <i> is not` ``;
- a slug that fails `/^[a-z0-9][a-z0-9-]*$/`: `` `${label}: '<slug>' is not a slug (lowercase letters, digits and dashes)` ``;
- a duplicate: `` `${label}: slug '<slug>' appears twice` ``.

It returns the items in file order. An empty array is valid.

### 1.8 `buildTriageDraft(worktree: string, backlogDir: string, slug: string): TriageDraft`
Errors name the slug, the file and the problem (§7.2):
- `<wt>/<backlog>/<slug>/brief.md` missing → `` `${slug}: ${backlogDir}/${slug}/brief.md is missing` ``.
- `Type:` line (`/^Type:\s*(\S+)/m`, lowercased) not `bug`/`feature` → `` `${slug}: ${backlogDir}/${slug}/brief.md has Type '<v>', not bug or feature` ``.
- No `indexItems(read(<wt>/<backlog>/index.md))` entry with that slug → `` `${slug}: ${backlogDir}/index.md has no line for ${slug}` ``.
- `priority`: from `/^Priority:\s*(.+)$/m`, trimmed; `''` when absent (the UI then falls back to P2 with a note).
- `title`: the index item's title with a leading `Bug:`/`Feature:` (case-insensitive) and the whitespace after it removed.
- `brief`: the full file text.

### 1.9 Questions
- `pendingTriageQuestions(file: string): TriageQuestion[]` returns `[]` when the file is missing. Otherwise it returns `parseQuestions(text).filter(q => !q.answer)`, mapped to `{ id: \`Q${q.n}\`, text: [q.title, q.body].filter(Boolean).join('\n'), suggested: q.suggested }`.
- `answerTriageQuestions(file: string, answers: Record<string, string>): void` writes nothing if any check fails:
  1. Every key must match `/^Q\d+$/`. Otherwise throw `` `not a question id: '<k>'` ``.
  2. For every pending question, `answers[id]` must be a non-blank string. Otherwise throw `` `question <id> is not answered` ``.
  3. Call `answerQuestions(file, Object.fromEntries(entries.map(([k,v]) => [k.slice(1), v])))`, the existing writer, which also rejects unknown numbers.

  "accept" is written as it is, as the pipeline does (`web/server/index.ts` L197-205 and the pipeline's "write 'accept' to take the suggestion"). The agent reads it as the Suggested value. Afterwards `pendingTriageQuestions` returns `[]`.

### 1.10 `parseStreamLine(line: string): TriageStreamPart`
This reads one line of `claude -p --output-format stream-json --verbose` output. Lines that are not JSON give an empty part.
- Any object with a string `session_id` → `sessionId`.
- `type === 'assistant'`: for each `message.content[]` entry, `type:'text'` with non-blank `text` → `texts`, and `type:'tool_use'` → `tools.push({ name, summary: toolSummary(name, input) })`. `thinking` entries are ignored (§5.2: raw reasoning is not shown).
- `toolSummary(name, input)`: `name` + ` ` + the first string field present out of `file_path`, `path`, `pattern`, `command`, `url`, `description`, made relative to nothing, collapsed to one line and cut to 120 characters. For example "Read src/triage.ts". Only the name when none is present.

### 1.11 Exports (`src/index.ts` L49)
Extend the triage export line with `newRunId, triageRunDir, createTriageWorktree, removeTriageWorktree, triageSplitPrompt, triageItemPrompt, triageAnsweredMessage, triageContinueMessage, parseTriageItems, buildTriageDraft, pendingTriageQuestions, answerTriageQuestions, parseStreamLine, triageTools, TRIAGE_DIR` and the types `TriageItem, TriageDraft, TriageQuestion, TriageState, DraftStatus, TriageStreamPart`.

Extend L38 with `alive, killTree` from `./runs/records.js`.

## Step 2: Assets (`assets/prompts/`)

These are user-facing prompt texts (CLAUDE.md: they live in `assets/`). Placeholders use `{{NAME}}`.
- `triage-split.md`: "This is a dashboard run, split phase." Read the report and the backlog, including the duplicate check. Choose slugs that are not taken (no folder under the backlog dir and no index line). Write `{{ITEMS_FILE}}` as a JSON array of `{ "slug", "type" ("bug"|"feature"), "priority", "title", "summary" }`, one entry per independent item, and `[]` when there is nothing to add. Write no briefs, do not touch `index.md`, and ask nothing. End with a short prose summary of what was proposed and why.
- `triage-item.md`: "This is a dashboard run, item phase, for exactly one item: `{{SLUG}}` ({{TYPE}}, {{PRIORITY}}): {{TITLE}}. {{SUMMARY}}." Write `<backlog>/{{SLUG}}/brief.md` and its one `index.md` line as the skill says, for this item only. Leave everything uncommitted and do not switch branches. Then `{{QUESTIONS}}`. The interactive paragraph (between markers the loader cuts, or held as a second file `triage-item-questions.md` with `{{QUESTIONS_FILE}}`) says: instead of AskUserQuestion, write at most 4 questions to `{{QUESTIONS_FILE}}`, each `### Q<n>: <title>`, the question, `**Suggested:** …`, then an empty `**Answer:**`, and end your turn. When the file's questions are answered you will be resumed. Put the answers into the brief as decisions. **Choice:** use the second file, `triage-item-questions.md`; `QUESTIONS` is its rendered text or `''`.
- `triage-answered.md`: "The questions in `{{QUESTIONS_FILE}}` are answered (an answer of 'accept' means the Suggested value). Use the answers and finish this item's brief and index line. If something is still open, write new questions to the same file, after the answered ones, and end your turn."
- `triage-continue.md`: "You were interrupted. Carry on where you left off with the same task and the same files."

## Step 3: Server lifecycle in `web/server/triage.ts` (new)

```ts
export interface TriageHost {
  env: NodeJS.ProcessEnv;
  claude: string;                                        // command to spawn; default 'claude'
  project(name: string): Promise<{ name: string; path: string }>;
  projects(): Promise<{ name: string; path: string }[]>;
  contextFor(p): RunContext;                             // index.ts's contextFor (400 on bad settings)
}
export function triageRoutes(host: TriageHost): {
  handle(req, res, parts: string[], url: URL): Promise<void>;   // parts = ['projects', name, 'triage', ...]
  recover(): Promise<void>;
  close(): void;
}
```

### 3.1 Registry pointer (§3.3)
- `pointerFile(root) = path.join(registryDir(root), 'triage.json')`.
- `readPointers(root)` parses the file (`{}` when missing or bad), drops every key whose `worktree` folder does not exist, and rewrites the file if anything was dropped.
- `writePointers(root, obj)` writes `.tmp` and renames it (as `writeRecord`).
- `pointerOf(root)` → `readPointers(root)[path.resolve(root)] ?? null`. Helpers to set and remove one key.

### 3.2 Run files
`RunJson`:
```ts
{ runId, state: TriageState, quick: boolean, model?: string, worktree, branch, backlogDir,
  pid: number, current: { phase: 'split' } | { phase: 'item'; slug: string } | null,
  sessions: { split?: string; items: Record<string, string> },
  items: TriageItem[], kept: string[], drafts: Record<string, DraftStatus>,
  created: string, updated: string }
```
- `runDirAbs = path.join(worktree, triageRunDir(backlogDir, runId))`.
- `readRun(ptr)` and `saveRun(run)` (atomic write; sets `updated`).
- `summary(run)` → `{ runId, state, worktree, slugs: run.kept, drafts: run.kept.filter(s => s in run.drafts).map(s => ({ slug: s, status: run.drafts[s] })) }` (§5.7).

### 3.3 In-memory live state
`const live = new Map<string /* runId */, { root: string; ctx: RunContext; listeners: Set<http.ServerResponse>; child: ChildProcess | null; ending: boolean }>()`.

`liveOf(root, ptr)` creates the entry on demand, for runs found after a restart.

### 3.4 SSE
- `openStream(res)`: `res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })`, plus a 15 s `: ping` interval cleared on `req` close, as `events()` in `index.ts` L224-246 does.
- `emit(run, name, payload)`:
  1. `fs.appendFileSync(<runDir>/events.jsonl, JSON.stringify({ event: name, data: payload }) + '\n')`.
  2. Write `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n` to every listener.
  3. If `name === 'done'`, call `res.end()` on every listener and clear the set (§5.8).
- A listener's `req.on('close')` removes it from the set. It never touches the child (§5.2, criterion 20).

### 3.5 Sessions
`runSession(run, current, args)`:
1. `args` = `['-p', <prompt or message>, ...(resumeId ? ['--resume', resumeId] : []), ...(run.model ? ['--model', run.model] : []), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', ...triageTools(run.worktree, env)]`. `--allowedTools` comes last because it takes several values (as `triage()` L106).
2. Set `run.state = 'running'`, `run.current = current`, `saveRun`.
3. `child = spawn(host.claude, args, { cwd: run.worktree, env, stdio: ['ignore', 'pipe', 'pipe'] })`, then `run.pid = child.pid ?? 0` and `saveRun`.
4. stdout is split into lines; each line goes through `parseStreamLine`:
   - `sessionId` → `sessions.split` or `sessions.items[slug]`, then `saveRun`, the first time only;
   - each `texts` entry → `emit('text', { text })`;
   - each `tools` entry → `emit('tool', { name, summary })`.
5. The last 20 lines of stderr are kept for the error message.
6. A `settled` guard makes `'error'` and `'close'` act once:
   - `'error'` with `ENOENT` → `fail(run, 'claude was not found on PATH', 127)`. Any other error → `fail(run, e.message, 127)`.
   - `'close'(code)`: if `entry.ending` (Stop, Discard, `close()`), do nothing. Otherwise set `run.pid = 0`. `code !== 0` → `fail(run, \`claude exited with code ${code}${tail ? ': ' + lastStderrLine : ''}\`, code ?? 1)`. Code 0 → `afterSplit` or `afterItem(slug)`.

`fail(run, message, code)`: `emit('error', { message })`, `state = 'failed'`, `pid = 0`, `saveRun`, `emit('done', { code })`. `current` is kept, so Resume knows which session to continue (§7.2).

### 3.6 Phase transitions
- `startSplit(run, report)`: `runSession(run, { phase: 'split' }, prompt = triageSplitPrompt(run.worktree, report, triageRunDir(...), { env }))`.
- `afterSplit(run)`:
  - `parseTriageItems(<runDir>/items.json, <rel label>)`. If it throws, `fail(run, e.message, 1)`.
  - If the list is empty, `finishDone(run)`.
  - Otherwise `run.items = items`, `emit('items', { items })`. Quick run: `run.kept = items.map(i => i.slug)`, then `nextItem(run)`. Interactive run: `state = 'choosing'`, `pid = 0`, `saveRun` (no `done`, §5.8).
- `nextItem(run)`:
  - The first slug in `run.kept` with no `run.drafts` entry → `runSession(run, { phase: 'item', slug }, triageItemPrompt(run.worktree, report, item, runDir, { headless: run.quick, env }))`. `report` is read from `report.md`.
  - When there is none: `allMarked(run)` → `finishDone`. Otherwise `state = 'ready'`, `current = null`, `saveRun`, `emit('done', { code: 0 })`.
- `afterItem(run, slug)` (§5.4):
  - Interactive run, and `pendingTriageQuestions(<runDir>/<slug>-questions.md)` is non-empty → `emit('question', { slug, questions })`, `state = 'waiting'`, `pid = 0`, `saveRun`.
  - Otherwise `buildTriageDraft(run.worktree, run.backlogDir, slug)`. If it throws, `fail(run, e.message, 1)`. Otherwise `run.drafts[slug] = 'pending'`, `saveRun`, `emit('draft', { drafts: [draft] })`, `nextItem(run)`.
- `finishDone(run)`: `state = 'done'`, `saveRun`, `emit('done', { code: 0 })`, `removeTriageWorktree(ctx, run.worktree, run.branch)`, remove the pointer key, `live.delete(runId)` (§5.9).
- `allMarked(run)`: every slug in `kept` has a draft whose status is not `pending`.

### 3.7 Routes (`handle`)
`parts[3]` is the action. Order everywhere: 400 bad input, then 404, then 409 (§6). A failing request changes nothing. Helper `runOf(root, runId)` throws `HttpError(404, \`no triage run '${runId}'\`)` unless `pointerOf(root)?.runId === runId` (§6, last line).

| Route | Steps |
|---|---|
| `POST /triage` | 1. `report` must be a string with non-blank text, else 400 `report is required`. `quick` must be boolean or absent, `model` a non-empty string or absent, else 400. 2. `p = await host.project(name)` (404). 3. Check the prompt: `renderSkill('triage', p.path, { env }) === null` → 400 `the triage prompt is missing from this installation`. 4. `pointerOf(p.path)` exists → 409 `` `a triage run is already active for ${p.name}` ``. 5. `ctx = host.contextFor(p)`, `runId = newRunId()`, `createTriageWorktree(ctx, runId)`. If it throws, 400 with its message. 6. `mkdir` the run folder. Write `.gitignore` (`*\n`), `report.md` (report as submitted), `run.json` (`state: 'running'`, `current: { phase: 'split' }`), an empty `events.jsonl`, and the pointer key `{ runId, worktree }` (§5.1 step 3). If any of this throws, remove the worktree and key and answer 400. 7. `openStream(res)`, add `res` as a listener, `emit('started', { runId })`, `startSplit`. |
| `GET /triage` | `p` (404). Pointer → `{ run: summary(readRun) }`, else `{ run: null }`. |
| `GET /triage/events` | `p` (404). `runOf(root, url.searchParams.get('runId'))` (404). `openStream`, then write every line of `events.jsonl` as an SSE block (replay, including earlier `done`). Then add the listener, all synchronously so no event is lost between replay and live. The stream stays open until the next `done` (R3 Q1). |
| `POST /triage/items` | `slugs` must be an array of strings (400). `p`, `runOf` (404). Any slug not in `run.items` → 400 `` `'<slug>' was not proposed` ``. `state !== 'choosing'` → 409 `` `run <runId> is <state>, not choosing` ``. Set `run.kept` = proposed slugs in `items.json` order that are in `slugs`. Empty → `finishDone`, respond `{ ok: true, run: summary }` (summary taken before clean-up). Otherwise respond `{ ok: true, run }`, then `nextItem`. |
| `POST /triage/answer` | `slug` must be a string, `answers` a plain object of strings (400). `p`, `runOf` (404). `slug` not in `run.kept`, or no questions file for it → 404 `` `no questions for '<slug>'` ``. `state !== 'waiting'` or `run.current?.slug !== slug` → 409 `` `run <runId> is <state>, not waiting` ``. `answerTriageQuestions(file, answers)`; if it throws, 400 with its message (nothing is written). Respond `{ ok: true, run }`, then `runSession(run, current, triageAnsweredMessage(<rel questions file>))` with `--resume run.sessions.items[slug]`. |
| `POST /triage/saved`, `/skip` | `slug` must be a string (400). `p`, `runOf` (404). No `run.drafts[slug]` → 404 `` `'<slug>' has no draft` ``. `state === 'done'` → 409. `drafts[slug] !== 'pending'` → 409 `` `'<slug>' is already <status>` ``. Set the status, `saveRun`, `emit('marked', { slug, status })`. Respond `{ ok: true, run: summary }`. Then, if every kept item has a draft and `allMarked`, `finishDone` (sessions still to come are untouched, R3 Q3). |
| `POST /triage/stop` | `p`, `runOf` (404). `state !== 'running'` → 409 `` `run ${runId} is ${state}, not running` ``. `entry.ending = true`, `killTree(pid, 'SIGTERM')` (`SIGKILL` after 5 s if still `alive`), `state = 'stopped'`, `pid = 0`, `saveRun`, `emit('done', { code: 130 })`, `entry.ending = false`. Respond `{ ok: true, run }`. The worktree is kept. |
| `POST /triage/resume` | `p`, `runOf` (404). State not in `stopped`/`interrupted`/`failed` → 409 `` `run <runId> is <state>, not stopped, interrupted or failed` ``. Respond `{ ok: true, run }` with `state` already set to `running`. Then continue `run.current`: if it has a recorded session id, `runSession` with `--resume <id>` and `triageContinueMessage()`; with no id (for example spawn failed, 127), start that phase afresh (`startSplit` or the item prompt). `current === null` (failed after every item ran: not reachable) → `nextItem`. |
| `POST /triage/discard` | `p`, `runOf` (404). Allowed in every state. `entry.ending = true`, kill any child (`killTree`), `removeTriageWorktree`, remove the pointer key, end every listener without a `done`, `live.delete`. Respond `{ ok: true }`. |

All handlers throw `HttpError`, so `index.ts`'s catch (L267-273) produces `{ ok: false, error }`.

### 3.8 `recover()` (§5.10)
For each project in `host.projects()`, call `readPointers(path)` (this drops stale keys). For each remaining key: if `run.json` says `running` and `!alive(run.pid)`, set `state = 'interrupted'`, `pid = 0`, `saveRun`. Other states are unchanged.

### 3.9 `close()`
For each live entry with a child: `entry.ending = true`, `killTree(child.pid, 'SIGKILL')`, `state = 'interrupted'`, `pid = 0`, `saveRun`. Then end every listener (§5.2: killed when the server stops).

## Step 4: Wire it into `web/server/index.ts`
1. `ServerOptions`: add `/** The claude command triage runs spawn (tests); default 'claude'. */ claude?: string;`.
2. In `startServer`, after `contextFor` (L83-85): `const triage = triageRoutes({ env, claude: opts.claude || 'claude', project, projects, contextFor });`.
3. In `api()`, before `const p = await project(parts[1])` (L153): `if (parts[0] === 'projects' && parts[2] === 'triage') return triage.handle(req, res, parts, url, body);`. The body is already read at L133. Pass it in and adjust the signature. This lets body validation (400) run before the project lookup (404).
4. After the listen loop: `await triage.recover();`.
5. `close`: call `triage.close()` before `server.closeAllConnections?.()`.
6. The token check (L259) already covers `/api/...`, so criterion 22 holds with no extra code.

## Step 5: UI client in `web/ui/src/api.ts`
Types: `TriageState`, `TriageItem`, `TriageDraft`, `TriageQuestion`, `DraftStatus`, `TriageRun = { runId; state; worktree; slugs: string[]; drafts: { slug; status }[] }`, `TriageEvent = { event: string; data: any }`.

`async function stream(method, path, body, onEvent, signal): Promise<void>`:
1. `fetch(path, { method, credentials: 'same-origin', headers, body, signal })`.
2. `!r.ok` → parse the JSON error and throw `ApiError`, as `call` does.
3. Otherwise read `r.body!.getReader()` with `TextDecoder`. Split on `\n\n`, parse the `event:` and `data:` lines, and call `onEvent({ event, data: JSON.parse(data) })`. Ignore `:` ping lines. Resolve when the stream ends.

Add to `api`:
```ts
triage: (project) => call<{ run: TriageRun | null }>('GET', `${p(project)}/triage`),
triageStart: (project, body: { report: string; quick: boolean }, onEvent, signal?) => stream('POST', `${p(project)}/triage`, body, onEvent, signal),
triageEvents: (project, runId, onEvent, signal?) => stream('GET', `${p(project)}/triage/events?runId=${encodeURIComponent(runId)}`, undefined, onEvent, signal),
triageItems / triageAnswer / triageSaved / triageSkip / triageStop / triageResume → call<{ ok: true; run: TriageRun }>('POST', `${p(project)}/triage/<action>`, {...}),
triageDiscard → call<{ ok: true }>('POST', ..., { runId }),
```

## Step 6: UI in `web/ui/src/NewItem.tsx`
1. `PRIORITIES = ['P0 (security or data loss)', 'P1 (high)', 'P2 (normal)', 'P3 (low)']`.
2. `export function mapPriority(v: string): { value: string; note: string }`: take the `/^P\d/` prefix of `v` and return the option with the same prefix. Otherwise return `{ value: 'P2 (normal)', note: \`Priority '${v || 'none'}' is not an option; set to P2 (normal).\` }`.
3. The header button: remove `disabled`, the title and `<Future id="E-8" />`. `onClick` opens the drawer. Keep the E-14 button as it is.
4. `function TriageDrawer({ onLoad, onClose })`, in the same file, shown as a `Panel` (`./ui`) above the form. State: `run: TriageRun | null`, `report`, `quick`, `log: string[]` (text and tool lines), `items`, `picked: Set<string>`, `questions: { slug, list }`, `answers`, `drafts: (TriageDraft & { status })[]`, `error`, `confirmDiscard`, plus an `AbortController` per stream.
   - `apply(ev)` is one reducer for live and replayed events: `started` sets runId; `text`/`tool` append to `log`; `items` sets items and ticks every box; `question` sets questions; `draft` adds drafts as `pending`; `marked` updates the status; `error` sets error; `done` records the code and refreshes `api.triage`.
   - Start: `api.triageStart(project, { report, quick }, apply, ac.signal)`. A thrown `ApiError` is shown in `ErrorBox`.
   - Reopen on mount: `api.triage(project)`. If it gives a run, open the drawer, set `run`, merge draft statuses from `run.drafts`, and `api.triageEvents(project, run.runId, apply)` (§5.7).
   - Choosing: checkbox list (slug, type, priority, title, summary) plus "Draft the selected items" → `api.triageItems`.
   - Waiting: one textarea per question, a "Use suggested" button (sets `'accept'`, as `Run.tsx` L168) and "Send answers" → `api.triageAnswer`.
   - Drafts list: status, **Load into form** → `onLoad(draft)`, **Skip** → `api.triageSkip`.
   - **Stop** (running) → `api.triageStop`. **Resume** (stopped/interrupted/failed) → `api.triageResume`, then reattach with `api.triageEvents`. **Discard** uses an inline confirm (as `Run.tsx` L115-119) → `api.triageDiscard`, then clears the drawer.
   - On unmount, abort the streams. This only closes the connection; the run goes on (§5.2).
5. In `NewItem`: track `triageRun` and `loadedFrom: string | null`. `onLoad(draft)`:
   - The form is "edited" when `slug || title || type !== 'feature' || priority !== 'P2 (normal)' || brief !== template('', 'feature', 'P2 (normal)')`. If it is edited, use `window.confirm('Replace the current form with the draft?')`; otherwise fill straight away.
   - Fill slug, type, `mapPriority(draft.priority).value` (show `note` under the select when non-empty), title and brief. Set `loadedFrom = draft.slug`.
6. `save`: after a successful `api.addItem`, if a triage run exists and the saved slug matches one of its drafts, `await api.triageSaved(project, runId, slug)` (errors are toasted, never blocking). Then, when the drawer has another pending draft and the user did not choose start, stay on `/new` with the drawer open and offer it, instead of `go('/board')` (§5.6 "the drawer then offers the next pending draft"). Save and start still navigates to the run.

## Step 7: Tests

The stand-in `claude` is a Node script written by the tests to `<tmp>/bin/claude` (`#!/usr/bin/env node`, mode 755). It is put first on `PATH` in the `env` given to `startServer`, or given as `ServerOptions.claude`. Its behaviour:
- It reads `<cwd>/<backlog>/.triage/*/run.json` to learn `current` (phase and slug), the run folder and `quick`. These are real files the server writes.
- It reads a scenario JSON from `process.env.TRIAGE_SCENARIO`: `{ items: [...], ask: [slugs], noBrief: [slugs], badItems: 'notjson'|..., exit: { split?: n, <slug>?: n }, sleepMs: { split?, <slug>? }, extraQuestionsInQuick: true }`.
- It appends `JSON.stringify(process.argv.slice(2))` to `process.env.TRIAGE_CALLS`.
- It prints stream-json:
  - `{"type":"system","subtype":"init","session_id":"sess-<phase>-<slug>"}`
  - `{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the backlog"},{"type":"tool_use","name":"Read","input":{"file_path":"Docs/backlog/index.md"}}]}}`
  - `{"type":"result","subtype":"success","session_id":...}`
- Split: writes `items.json`.
- Item: in an `ask` slug's first session (no `--resume`), writes `<slug>-questions.md` with two questions and exits 0. Otherwise it writes `brief.md` (`Type:`/`Priority:` lines) and appends the index line.
- It sleeps for `sleepMs`, so Stop and disconnect can be tested, then exits with `exit[...]`.

Test helper `sse(method, path, body)` in `web/test/server.test.ts` returns `{ events: {event,data}[] (live), closed: Promise<void>, abort() }`, built on `http.request` and parsing `event:`/`data:` blocks.

### `test/triage.test.ts` (criteria 1–4, plus helpers)
1. `parseTriageItems`: valid file → items. Missing / not JSON / wrong shape / duplicate / bad slug → each throws with a message containing the label and the specific problem. `[]` → `[]`.
2. `buildTriageDraft` on a temp worktree: brief with `Type: bug`, `Priority: P1 (blocks use)`, and index line `` - [ ] `x` - Bug: Login fails `` → `{ type: 'bug', priority: 'P1 (blocks use)', title: 'Login fails', brief: <file text> }`. `Type: chore` → throws naming the slug and file. No index line → throws naming `index.md`. No brief → throws.
3. `pendingTriageQuestions` finds 2 unanswered questions. `answerTriageQuestions` with one missing answer throws and leaves the file unchanged. With `{ Q1: 'accept', Q2: 'Use X' }` → `pendingTriageQuestions` returns `[]`, and `parseQuestions` shows the answers.
4. `triageSplitPrompt` and `triageItemPrompt` (on the `project()` fixture) contain the report and `renderSkill('triage', dir)` text. The quick item prompt equals the interactive one's base with `triagePrompt(..., { headless: true })` in place of the interactive one: assert it starts with `triagePrompt(dir, report, { headless: true }).trim()`, and that the interactive prompt does not. The item prompt contains the slug and the questions file path given.
5. (extra) `createTriageWorktree` on the fixture with an uncommitted `sdlc.config.json`, an extra index line and an uncommitted brief → the worktree has all three. The branch is `sdlc/triage-<id>`, and `git log` shows no new commit. `removeTriageWorktree` removes the folder and branch. On a repo with no commit, it throws `start`'s text and leaves no folder or branch.
6. (extra) `parseStreamLine`: the session id, texts and a tool summary "Read src/triage.ts". Thinking content and non-JSON lines are ignored.
7. (extra) `newRunId()` matches `/^[a-z0-9][a-z0-9-]*$/`.

### `web/test/server.test.ts`: new `describe('triage')` (criteria 5–22)
One test or more per criterion, as listed in spec §9 items 5–22:
- Assert worktree, branch (`git branch --list`), registry key (`<repo>/.git/sdlc-runs/triage.json`) and run-folder files on disk.
- The calls log gives session order and `--resume sess-item-<slug>`.
- `events.jsonl` content is checked for criterion 20.
- Criterion 7 uses a second server with `cwd` = a repo with `git init` and no commit.
- Criterion 19 "missing claude" uses a second server with `claude: path.join(base, 'no-such-claude')`.
- Criterion 21 writes `triage.json`, a worktree folder and `run.json` (`running`, pid `999999`) by hand, plus a second `waiting` run under another repo root, and a key whose worktree is absent. Then it starts a new server and checks `GET /triage`.
- Criterion 22 posts every route with `token: false` → 401.

Check single files with `ai-sdlc-helper run --file test/triage.test.ts` and `--file web/test/server.test.ts`, then `npm run check`.

## Step 8: Docs (separate from tests; checked in Review)
- `docs/web-ui.md`: describe the triage drawer (report, Quick, item selection, questions, drafts with Load/Skip, Stop/Resume/Discard, reopen on refresh), the worktree and run folder, and the routes of §6 with their event list. Mark E-8 done.
- `docs/design/web-ui/Roadmap.dc.html`: mark E-8 as completed.

## Order of work
1. Step 2 assets, then Step 1 engine helpers and exports, then the `test/triage.test.ts` cases.
2. Step 3 `web/server/triage.ts`, Step 4 wiring, then the `web/test/server.test.ts` cases with the stand-in claude.
3. Steps 5–6 UI (type-checked by `npm run check`; verified by hand, criteria 23–25).
4. Step 8 docs.
5. `npm run check`.
