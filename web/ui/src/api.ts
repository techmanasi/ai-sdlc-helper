// The server's API, as the app uses it. The shapes mirror the engine's (RunView, BoardView …); the app keeps its own
// copy so the browser build never pulls in Node code.

export type ViewState = 'not started' | 'running' | 'paused' | 'done' | 'failed' | 'interrupted' | 'stopped' | 'refused';
export interface Project { name: string; path: string; registered: boolean }
export interface BacklogItem { status: string; slug: string; type: string | null; priority: string | null; title: string; note: string; hasBrief: boolean }
export interface TestCounts { passed: number; failed: number; skipped: number; total: number }
export interface RunCard {
  slug: string; state: ViewState; stage: string; agent: string; model: string; effort: string; note: string; updated: string;
  message: string; tests: TestCounts | null; branch: string; questions: number; permissions: number; deniedPermissions?: number;
  changes: { changed: number; uncommitted: number } | null;
}
export interface Board { items: BacklogItem[] | null; runs: RunCard[]; maxParallel: number; running: number }
export interface Question { n: number; title: string; body: string; suggested: string; answer: string }
export interface Ask { stage: string; tool: string; detail: string; rule: string; protected: boolean }
export interface RunView extends Omit<RunCard, 'questions' | 'permissions' | 'changes'> {
  models: Record<string, { model: string; effort: string }>;
  agentStarted: string; runStarted: string;
  record: Record<string, unknown> | null;
  dir: string | null; worktree: string | null; base: string;
  questions: Question[]; permissions: Ask[]; deniedPermissions?: Ask[];
  stageFiles: Record<string, string[]>;
  changes: { changed: number; uncommitted: number; files: string[] } | null;
  tail: string[]; docs: string[]; discarded: string; resumeFrom: string;
}
export interface Outcome { ok: boolean; code: number; out: string[]; err: string[] }
export interface Check { name: string; ok: boolean; required: boolean; detail: string; fix?: string }

export type TriageState = 'running' | 'choosing' | 'waiting' | 'ready' | 'interrupted' | 'stopped' | 'failed' | 'done';
export type DraftStatus = 'pending' | 'saved' | 'skipped';
export interface TriageItem { slug: string; type: string; priority: string; title: string; summary: string }
export interface TriageDraft { slug: string; type: 'bug' | 'feature'; priority: string; title: string; brief: string }
export interface TriageQuestion { id: string; text: string; suggested: string }
export interface TriageRun { runId: string; state: TriageState; worktree: string; slugs: string[]; drafts: { slug: string; status: DraftStatus }[] }
export interface TriageEvent { event: string; data: any }

export class ApiError extends Error {}

async function failure(r: Response): Promise<ApiError> {
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return new ApiError((data && data.error) || text || `${r.status} ${r.statusText}`);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw await failure(r);
  const text = await r.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Reads a Server-Sent Events response (a POST cannot use EventSource) and calls onEvent for each event until the stream ends. */
async function stream(method: string, path: string, body: unknown, onEvent: (e: TriageEvent) => void, signal?: AbortSignal): Promise<void> {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw await failure(r);
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const name = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (name && data) onEvent({ event: name, data: JSON.parse(data) });
    }
  }
}

const p = (project: string) => `/api/projects/${encodeURIComponent(project)}`;
const r = (project: string, slug: string) => `${p(project)}/runs/${encodeURIComponent(slug)}`;

export const api = {
  session: () => call<{ version: string; projects: Project[] }>('GET', '/api/session'),
  projects: () => call<{ projects: Project[] }>('GET', '/api/projects'),
  addProject: (path: string, name?: string) => call<Outcome & { projects: Project[] }>('POST', '/api/projects', { path, name }),
  doctor: (project: string) => call<{ checks: Check[] }>('GET', `${p(project)}/doctor`),
  board: (project: string) => call<Board>('GET', `${p(project)}/board`),
  settings: (project: string) => call<{ config: unknown; errors: string[]; warnings: string[]; raw: string | null }>('GET', `${p(project)}/settings`),
  brief: (project: string, slug: string) => call<{ brief: string | null }>('GET', `${p(project)}/backlog/${encodeURIComponent(slug)}`),
  addItem: (project: string, item: { slug: string; type: string; title: string; brief: string; start?: boolean }) =>
    call<{ ok: boolean; started: Outcome | null }>('POST', `${p(project)}/backlog`, item),
  run: (project: string, slug: string) => call<RunView>('GET', r(project, slug)),
  file: (project: string, slug: string, path: string) => call<{ text: string }>('GET', `${r(project, slug)}/file?path=${encodeURIComponent(path)}`),
  start: (project: string, slug: string, from?: string, env?: Record<string, string>) => call<Outcome>('POST', `${r(project, slug)}/start`, { from, env }),
  stop: (project: string, slug: string) => call<Outcome>('POST', `${r(project, slug)}/stop`, {}),
  discard: (project: string, slug: string) => call<Outcome>('POST', `${r(project, slug)}/discard`, { stop: true }),
  restart: (project: string, slug: string, from?: string, env?: Record<string, string>) => call<Outcome>('POST', `${r(project, slug)}/restart`, { from, env }),
  answers: (project: string, slug: string, answers: Record<number, string>, env?: Record<string, string>) =>
    call<{ total: number; answered: number; resumed: Outcome | null }>('POST', `${r(project, slug)}/answers`, { answers, env }),
  permit: (project: string, slug: string, which: string, choice: 'allow' | 'always' | 'deny', env?: Record<string, string>) =>
    call<{ pending: number; resumed: Outcome | null }>('POST', `${r(project, slug)}/permissions`, { which, choice, env }),
  command: (project: string, args: string[]) => call<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>('POST', `${p(project)}/command`, { args }),
  triage: (project: string) => call<{ run: TriageRun | null }>('GET', `${p(project)}/triage`),
  triageStart: (project: string, body: { report: string; quick: boolean }, onEvent: (e: TriageEvent) => void, signal?: AbortSignal) =>
    stream('POST', `${p(project)}/triage`, body, onEvent, signal),
  triageEvents: (project: string, runId: string, onEvent: (e: TriageEvent) => void, signal?: AbortSignal) =>
    stream('GET', `${p(project)}/triage/events?runId=${encodeURIComponent(runId)}`, undefined, onEvent, signal),
  triageItems: (project: string, runId: string, slugs: string[]) => call<{ ok: true; run: TriageRun }>('POST', `${p(project)}/triage/items`, { runId, slugs }),
  triageAnswer: (project: string, runId: string, slug: string, answers: Record<string, string>) =>
    call<{ ok: true; run: TriageRun }>('POST', `${p(project)}/triage/answer`, { runId, slug, answers }),
  triageSaved: (project: string, runId: string, slug: string) => call<{ ok: true; run: TriageRun }>('POST', `${p(project)}/triage/saved`, { runId, slug }),
  triageSkip: (project: string, runId: string, slug: string) => call<{ ok: true; run: TriageRun }>('POST', `${p(project)}/triage/skip`, { runId, slug }),
  triageStop: (project: string, runId: string) => call<{ ok: true; run: TriageRun }>('POST', `${p(project)}/triage/stop`, { runId }),
  triageResume: (project: string, runId: string) => call<{ ok: true; run: TriageRun }>('POST', `${p(project)}/triage/resume`, { runId }),
  triageDiscard: (project: string, runId: string) => call<{ ok: true }>('POST', `${p(project)}/triage/discard`, { runId }),
};

/** Splits a command line into arguments: spaces separate, single or double quotes group. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of line) {
    if (quote) { if (ch === quote) quote = ''; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** A command line for display: arguments with spaces or quotes are quoted. */
export const cliLine = (args: string[]): string =>
  ['ai-sdlc-helper', ...args].map(a => (/^[\w./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
