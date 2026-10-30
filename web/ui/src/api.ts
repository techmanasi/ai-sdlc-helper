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

export class ApiError extends Error {}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) throw new ApiError((data && data.error) || text || `${r.status} ${r.statusText}`);
  return data as T;
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
