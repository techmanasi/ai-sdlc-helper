// Dashboard triage runs: the report is split into items by a Claude agent, each item is drafted by its own session (which may
// ask questions), and the drafts are loaded into the new-item form by the browser. A run lives in its own git worktree on its
// own branch; its state is in files there (run.json, events.jsonl), and a pointer in the repository's run registry names the
// active run, so a browser reload or a server restart finds it again. The browser sees the run as Server-Sent Events.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  alive, answerTriageQuestions, buildTriageDraft, createTriageWorktree, killTree, newRunId, parseStreamLine, parseTriageItems,
  pendingTriageQuestions, registryDir, removeTriageWorktree, renderSkill, triageAnsweredMessage, triageContinueMessage,
  triageItemPrompt, triageRunDir, triageSplitPrompt, triageTools, type DraftStatus, type RunContext, type TriageItem, type TriageState,
} from 'ai-sdlc-helper';
import { HttpError, sendJson } from './http.js';

export interface TriageHost {
  env: NodeJS.ProcessEnv;
  /** The command that runs the agent. */
  claude: string;
  project(name: string): Promise<{ name: string; path: string }>;
  projects(): Promise<{ name: string; path: string }[]>;
  contextFor(p: { name: string; path: string }): RunContext;
}

type Current = { phase: 'split' } | { phase: 'item'; slug: string };

interface RunJson {
  runId: string;
  state: TriageState;
  quick: boolean;
  model?: string;
  worktree: string;
  branch: string;
  backlogDir: string;
  pid: number;
  current: Current | null;
  sessions: { split?: string; items: Record<string, string> };
  items: TriageItem[];
  kept: string[];
  drafts: Record<string, DraftStatus>;
  created: string;
  updated: string;
}

interface Pointer { runId: string; worktree: string }
type Pointers = Record<string, Pointer>;

/** One agent process; `ending` is set when we stop it ourselves, so its exit is not a failure. */
interface Session { child: ChildProcess; ending: boolean }

interface Live {
  root: string;
  ctx: RunContext;
  run: RunJson;
  listeners: Set<http.ServerResponse>;
  session: Session | null;
}

const PING_MS = 15000;
const KILL_AFTER_MS = 5000;
const START_WAIT_MS = 10000;

const now = () => new Date().toISOString();
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// --- Registry pointer: <git common dir>/sdlc-runs/triage.json, { <project root>: { runId, worktree } } ---

const pointerFile = (root: string) => path.join(registryDir(root), 'triage.json');
const pointerKey = (root: string) => path.resolve(root);

function writePointers(root: string, pointers: Pointers): void {
  const file = pointerFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(pointers, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** The pointers, without those whose worktree is gone (the file is rewritten then). */
function readPointers(root: string): Pointers {
  let data: Pointers = {};
  try {
    const v = JSON.parse(fs.readFileSync(pointerFile(root), 'utf8'));
    if (isObject(v)) data = v as Pointers;
  } catch { /* none, or not JSON */ }
  let dropped = false;
  for (const [k, v] of Object.entries(data)) {
    if (!isObject(v) || typeof v.worktree !== 'string' || typeof v.runId !== 'string' || !fs.existsSync(v.worktree)) { delete data[k]; dropped = true; }
  }
  if (dropped) writePointers(root, data);
  return data;
}

const pointerOf = (root: string): Pointer | null => readPointers(root)[pointerKey(root)] ?? null;
const setPointer = (root: string, ptr: Pointer) => writePointers(root, { ...readPointers(root), [pointerKey(root)]: ptr });
function removePointer(root: string): void {
  const data = readPointers(root);
  delete data[pointerKey(root)];
  writePointers(root, data);
}

// --- Run files ---

const runDirOf = (worktree: string, backlogDir: string, runId: string) => path.join(worktree, triageRunDir(backlogDir, runId));
const runDirAbs = (run: RunJson) => runDirOf(run.worktree, run.backlogDir, run.runId);

function readRunFile(ctx: RunContext, ptr: Pointer): RunJson | null {
  try { return JSON.parse(fs.readFileSync(path.join(runDirOf(ptr.worktree, ctx.backlogDir, ptr.runId), 'run.json'), 'utf8')); } catch { return null; }
}

function saveRun(run: RunJson): void {
  run.updated = now();
  const file = path.join(runDirAbs(run), 'run.json');
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* the worktree is gone (discarded) */ }
}

/** Whether <slug> has a draft; `in` would also see Object.prototype keys such as `constructor`, which are valid slugs. */
const hasDraft = (run: RunJson, slug: string) => Object.prototype.hasOwnProperty.call(run.drafts, slug);

/** The recorded Claude session id of <slug>'s item session, with the same own-property guard as `hasDraft`. */
const itemSession = (run: RunJson, slug: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(run.sessions.items, slug) ? run.sessions.items[slug] : undefined;

const summary = (run: RunJson) => ({
  runId: run.runId, state: run.state, worktree: run.worktree, slugs: run.kept,
  drafts: run.kept.filter(s => hasDraft(run, s)).map(s => ({ slug: s, status: run.drafts[s] })),
});

const allMarked = (run: RunJson) => run.kept.every(s => hasDraft(run, s) && run.drafts[s] !== 'pending');

const sseBlock = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

export function triageRoutes(host: TriageHost) {
  const live = new Map<string, Live>();

  function liveOf(ctx: RunContext, ptr: Pointer): Live {
    const known = live.get(ptr.runId);
    if (known) return known;
    const run = readRunFile(ctx, ptr);
    if (!run) throw new HttpError(404, `no triage run '${ptr.runId}'`);
    const entry: Live = { root: ctx.root, ctx, run, listeners: new Set(), session: null };
    live.set(ptr.runId, entry);
    return entry;
  }

  function runOf(ctx: RunContext, runId: unknown): Live {
    const ptr = pointerOf(ctx.root);
    if (!ptr || ptr.runId !== runId) throw new HttpError(404, `no triage run '${String(runId)}'`);
    return liveOf(ctx, ptr);
  }

  // --- SSE ---

  function openStream(res: http.ServerResponse, e: Live): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.flushHeaders();
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    res.on('close', () => { clearInterval(ping); e.listeners.delete(res); });
  }

  /**
   * Stores the event and sends it to every viewer. The promise settles once the viewers' connections have taken it, so a
   * route that answers after awaiting it never answers ahead of the event the answer is about.
   */
  function emit(e: Live, name: string, payload: unknown): Promise<void> {
    try { fs.appendFileSync(path.join(runDirAbs(e.run), 'events.jsonl'), `${JSON.stringify({ event: name, data: payload })}\n`); } catch { /* worktree gone */ }
    const block = sseBlock(name, payload);
    const sent: Promise<void>[] = [];
    for (const res of e.listeners) sent.push(new Promise(ok => { res.write(block, () => ok()); }));
    if (name === 'done') {
      for (const res of e.listeners) sent.push(new Promise(ok => { res.end(() => ok()); }));
      e.listeners.clear();
    }
    const flushed = Promise.all(sent).then(() => new Promise<void>(ok => { setImmediate(ok); }));
    return Promise.race([flushed, new Promise<void>(ok => { setTimeout(ok, 1000).unref(); })]);
  }

  // --- Phases ---

  function fail(e: Live, message: string, code: number): void {
    const { run } = e;
    emit(e, 'error', { message });
    run.state = 'failed';
    run.pid = 0;
    saveRun(run);
    emit(e, 'done', { code });
  }

  function finishDone(e: Live): void {
    const { run } = e;
    if (run.state === 'done') return; // two marks that both awaited their event can both see every draft marked
    run.state = 'done';
    run.pid = 0;
    saveRun(run);
    emit(e, 'done', { code: 0 });
    removeTriageWorktree(e.ctx, run.worktree, run.branch);
    removePointer(e.root);
    live.delete(run.runId);
  }

  /** Starts an agent session. Resolves when it has printed something, exited or failed to start. */
  function runSession(e: Live, current: Current, prompt: string, resumeId?: string): Promise<void> {
    const { run } = e;
    const args = [
      '-p', prompt, ...(resumeId ? ['--resume', resumeId] : []), ...(run.model ? ['--model', run.model] : []),
      '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', ...triageTools(run.worktree, host.env),
    ];
    run.state = 'running';
    run.current = current;
    saveRun(run);
    const child = spawn(host.claude, args, { cwd: run.worktree, env: host.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const session: Session = { child, ending: false };
    e.session = session;
    run.pid = child.pid ?? 0;
    saveRun(run);

    let began!: () => void;
    const started = new Promise<void>(res => { began = res; });
    let settled = false;
    let buf = '';
    const errLines: string[] = [];

    const onLine = (line: string) => {
      const part = parseStreamLine(line);
      if (part.sessionId) {
        const known = current.phase === 'split' ? run.sessions.split : itemSession(run, current.slug);
        if (known !== part.sessionId) {
          if (current.phase === 'split') run.sessions.split = part.sessionId; else run.sessions.items[current.slug] = part.sessionId;
          saveRun(run);
        }
      }
      for (const text of part.texts) emit(e, 'text', { text });
      for (const t of part.tools) emit(e, 'tool', { name: t.name, summary: t.summary });
    };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      began();
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!session.ending) onLine(line);
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => { errLines.push(...d.split('\n').filter(l => l.trim())); errLines.splice(0, Math.max(0, errLines.length - 20)); });

    // A session that has ended is forgotten, so a later Discard never signals its pid (which the system may have reused).
    const forget = () => { if (e.session === session) e.session = null; };
    child.on('error', err => {
      if (settled) return;
      settled = true;
      began();
      forget();
      if (session.ending) return;
      run.pid = 0;
      fail(e, (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'claude was not found on PATH' : err.message, 127);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      began();
      forget();
      if (session.ending) return;
      if (buf.trim()) onLine(buf);
      run.pid = 0;
      if (code !== 0) {
        const last = errLines[errLines.length - 1];
        fail(e, `claude exited with code ${code}${last ? `: ${last}` : ''}`, code ?? 1);
      } else if (current.phase === 'split') afterSplit(e);
      else afterItem(e, current.slug);
    });
    return Promise.race([started, new Promise<void>(res => { setTimeout(res, START_WAIT_MS).unref(); })]);
  }

  const reportOf = (run: RunJson) => fs.readFileSync(path.join(runDirAbs(run), 'report.md'), 'utf8');

  function startSplit(e: Live): Promise<void> {
    const { run } = e;
    let prompt: string;
    try { prompt = triageSplitPrompt(run.worktree, reportOf(run), triageRunDir(run.backlogDir, run.runId), { env: host.env }); } catch (err) {
      fail(e, (err as Error).message, 1);
      return Promise.resolve();
    }
    return runSession(e, { phase: 'split' }, prompt);
  }

  /** Starts the session of one item; <extra> is appended to its prompt. */
  function startItem(e: Live, slug: string, extra = ''): Promise<void> {
    const { run } = e;
    const item = run.items.find(i => i.slug === slug);
    // Current before anything can fail, so Resume retries this item rather than the one drafted before it.
    run.current = { phase: 'item', slug };
    let prompt: string;
    try {
      if (!item) throw new Error(`'${slug}' was not proposed`);
      prompt = triageItemPrompt(run.worktree, reportOf(run), item, triageRunDir(run.backlogDir, run.runId), { headless: run.quick, env: host.env });
      if (extra) prompt += `\n${extra}\n`;
    } catch (err) {
      fail(e, (err as Error).message, 1);
      return Promise.resolve();
    }
    return runSession(e, { phase: 'item', slug }, prompt);
  }

  function afterSplit(e: Live): void {
    const { run } = e;
    const label = `${triageRunDir(run.backlogDir, run.runId)}/items.json`;
    let items: TriageItem[];
    try { items = parseTriageItems(path.join(runDirAbs(run), 'items.json'), label); } catch (err) {
      fail(e, (err as Error).message, 1);
      return;
    }
    if (!items.length) { finishDone(e); return; }
    run.items = items;
    if (run.quick) {
      run.kept = items.map(i => i.slug);
      saveRun(run);
      emit(e, 'items', { items });
      void nextItem(e);
      return;
    }
    run.state = 'choosing';
    run.pid = 0;
    saveRun(run);
    emit(e, 'items', { items });
  }

  function afterItem(e: Live, slug: string): void {
    const { run } = e;
    if (!run.quick) {
      const questions = pendingTriageQuestions(path.join(runDirAbs(run), `${slug}-questions.md`));
      if (questions.length) {
        run.state = 'waiting';
        run.pid = 0;
        saveRun(run);
        emit(e, 'question', { slug, questions });
        return;
      }
    }
    let draft;
    try { draft = buildTriageDraft(run.worktree, run.backlogDir, slug); } catch (err) {
      fail(e, (err as Error).message, 1);
      return;
    }
    run.drafts[slug] = 'pending';
    saveRun(run);
    emit(e, 'draft', { drafts: [draft] });
    void nextItem(e);
  }

  /** Drafts the next kept item that has no draft yet; when there is none, the run is ready (or done, when all are marked). */
  function nextItem(e: Live): Promise<void> {
    const { run } = e;
    const slug = run.kept.find(s => !hasDraft(run, s));
    if (slug) return startItem(e, slug);
    if (allMarked(run)) finishDone(e);
    else {
      run.state = 'ready';
      run.current = null;
      run.pid = 0;
      saveRun(run);
      emit(e, 'done', { code: 0 });
    }
    return Promise.resolve();
  }

  function stopSession(e: Live, signal: NodeJS.Signals): void {
    const s = e.session;
    // No session of ours, but a recorded agent that is still alive (it outlived an earlier server): that one is stopped.
    if (!s) {
      if (alive(e.run.pid)) killTree(e.run.pid, 'SIGKILL');
      return;
    }
    s.ending = true;
    const pid = s.child.pid ?? 0;
    killTree(pid, signal);
    if (signal !== 'SIGKILL') setTimeout(() => { if (alive(pid)) killTree(pid, 'SIGKILL'); }, KILL_AFTER_MS).unref();
  }

  // --- Routes ---

  const stringBody = (body: any, key: string): string => {
    if (typeof body[key] !== 'string') throw new HttpError(400, `${key} must be a string`);
    return body[key];
  };

  async function start(res: http.ServerResponse, name: string, body: any): Promise<void> {
    const report = body.report;
    if (typeof report !== 'string' || !report.trim()) throw new HttpError(400, 'report is required');
    if (body.quick !== undefined && typeof body.quick !== 'boolean') throw new HttpError(400, 'quick must be true or false');
    if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim())) throw new HttpError(400, 'model must be a non-empty string');
    const p = await host.project(name);
    if (renderSkill('triage', p.path, { env: host.env }) === null) throw new HttpError(400, 'the triage prompt is missing from this installation');
    const ctx = host.contextFor(p);
    if (pointerOf(ctx.root)) throw new HttpError(409, `a triage run is already active for ${p.name}`);

    const runId = newRunId();
    let made: { worktree: string; branch: string };
    try { made = createTriageWorktree(ctx, runId); } catch (err) { throw new HttpError(400, (err as Error).message); }
    const run: RunJson = {
      runId, state: 'running', quick: body.quick === true, ...(body.model ? { model: body.model } : {}),
      worktree: made.worktree, branch: made.branch, backlogDir: ctx.backlogDir, pid: 0, current: { phase: 'split' },
      sessions: { items: {} }, items: [], kept: [], drafts: {}, created: now(), updated: now(),
    };
    try {
      const dir = runDirAbs(run);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
      fs.writeFileSync(path.join(dir, 'report.md'), report);
      fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
      fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
      setPointer(ctx.root, { runId, worktree: made.worktree });
    } catch (err) {
      removeTriageWorktree(ctx, made.worktree, made.branch);
      try { removePointer(ctx.root); } catch { /* none was written */ }
      throw new HttpError(400, (err as Error).message);
    }

    const e: Live = { root: ctx.root, ctx, run, listeners: new Set(), session: null };
    live.set(runId, e);
    openStream(res, e);
    e.listeners.add(res);
    emit(e, 'started', { runId });
    void startSplit(e);
  }

  function events(res: http.ServerResponse, e: Live): void {
    openStream(res, e);
    let replay = '';
    try {
      for (const line of fs.readFileSync(path.join(runDirAbs(e.run), 'events.jsonl'), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        replay += sseBlock(ev.event, ev.data);
      }
    } catch { /* no events yet */ }
    if (replay) res.write(replay);
    e.listeners.add(res);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], url: URL, body: any): Promise<void> {
    const method = req.method || 'GET';
    const action = parts[3];
    const name = parts[1];
    const send = (v: unknown) => sendJson(res, 200, v);
    const forEntry = async (runId: unknown) => {
      const ctx = host.contextFor(await host.project(name));
      return runOf(ctx, runId);
    };

    if (!action) {
      if (method === 'POST') return start(res, name, body);
      if (method !== 'GET') throw new HttpError(405, 'use GET or POST');
      const ctx = host.contextFor(await host.project(name));
      const ptr = pointerOf(ctx.root);
      const known = ptr ? live.get(ptr.runId)?.run ?? readRunFile(ctx, ptr) : null;
      return send({ run: known ? summary(known) : null });
    }
    if (action === 'events') {
      if (method !== 'GET') throw new HttpError(405, 'use GET');
      const e = await forEntry(url.searchParams.get('runId') || '');
      return events(res, e);
    }
    if (method !== 'POST') throw new HttpError(405, 'use POST');

    if (action === 'items') {
      if (!Array.isArray(body.slugs) || !body.slugs.every((s: unknown) => typeof s === 'string')) throw new HttpError(400, 'slugs must be a list of strings');
      const e = await forEntry(body.runId);
      const { run } = e;
      for (const s of body.slugs) if (!run.items.some(i => i.slug === s)) throw new HttpError(400, `'${s}' was not proposed`);
      if (run.state !== 'choosing') throw new HttpError(409, `run ${run.runId} is ${run.state}, not choosing`);
      run.kept = run.items.map(i => i.slug).filter(s => body.slugs.includes(s));
      if (!run.kept.length) {
        finishDone(e);
        return send({ ok: true, run: summary(run) });
      }
      saveRun(run);
      void nextItem(e);
      return send({ ok: true, run: summary(run) });
    }

    if (action === 'answer') {
      const slug = stringBody(body, 'slug');
      if (!isObject(body.answers) || !Object.values(body.answers).every(v => typeof v === 'string')) throw new HttpError(400, 'answers must be an object of strings');
      const e = await forEntry(body.runId);
      const { run } = e;
      const rel = `${triageRunDir(run.backlogDir, run.runId)}/${slug}-questions.md`;
      const file = path.join(run.worktree, rel);
      if (!run.kept.includes(slug) || !fs.existsSync(file)) throw new HttpError(404, `no questions for '${slug}'`);
      if (run.state !== 'waiting' || run.current?.phase !== 'item' || run.current.slug !== slug) throw new HttpError(409, `run ${run.runId} is ${run.state}, not waiting`);
      try { answerTriageQuestions(file, body.answers as Record<string, string>); } catch (err) { throw new HttpError(400, (err as Error).message); }
      // Without a recorded session id there is nothing to continue: the item's session starts afresh, pointed at the answers.
      const id = itemSession(run, slug);
      void (id ? runSession(e, { phase: 'item', slug }, triageAnsweredMessage(rel), id) : startItem(e, slug, triageAnsweredMessage(rel)));
      return send({ ok: true, run: summary(run) });
    }

    if (action === 'saved' || action === 'skip') {
      const slug = stringBody(body, 'slug');
      const e = await forEntry(body.runId);
      const { run } = e;
      if (!hasDraft(run, slug)) throw new HttpError(404, `'${slug}' has no draft`);
      if (run.drafts[slug] !== 'pending') throw new HttpError(409, `'${slug}' is already ${run.drafts[slug]}`);
      const status: DraftStatus = action === 'saved' ? 'saved' : 'skipped';
      run.drafts[slug] = status;
      saveRun(run);
      await emit(e, 'marked', { slug, status });
      const reply = summary(run);
      if (allMarked(run)) finishDone(e);
      return send({ ok: true, run: reply });
    }

    if (action === 'stop') {
      const e = await forEntry(body.runId);
      const { run } = e;
      if (run.state !== 'running') throw new HttpError(409, `run ${run.runId} is ${run.state}, not running`);
      stopSession(e, 'SIGTERM');
      run.state = 'stopped';
      run.pid = 0;
      saveRun(run);
      await emit(e, 'done', { code: 130 });
      return send({ ok: true, run: summary(run) });
    }

    if (action === 'resume') {
      const e = await forEntry(body.runId);
      const { run } = e;
      if (!['stopped', 'interrupted', 'failed'].includes(run.state)) throw new HttpError(409, `run ${run.runId} is ${run.state}, not stopped, interrupted or failed`);
      const cur = run.current;
      let began: Promise<void>;
      if (!cur) began = nextItem(e);
      else if (cur.phase === 'split') {
        const id = run.sessions.split;
        began = id ? runSession(e, cur, triageContinueMessage(), id) : startSplit(e);
      } else {
        const id = itemSession(run, cur.slug);
        began = id ? runSession(e, cur, triageContinueMessage(), id) : startItem(e, cur.slug);
      }
      await began;
      return send({ ok: true, run: summary(run) });
    }

    if (action === 'discard') {
      const e = await forEntry(body.runId);
      stopSession(e, 'SIGKILL');
      removeTriageWorktree(e.ctx, e.run.worktree, e.run.branch);
      removePointer(e.root);
      for (const l of e.listeners) l.end();
      e.listeners.clear();
      live.delete(e.run.runId);
      return send({ ok: true });
    }

    throw new HttpError(404, 'no such API');
  }

  /** At start-up: a run recorded as running whose agent is gone was interrupted. Stale pointers are dropped. */
  async function recover(): Promise<void> {
    for (const p of await host.projects()) {
      let ctx: RunContext;
      try { ctx = host.contextFor(p); } catch { continue; }
      const ptr = pointerOf(ctx.root);
      const run = ptr ? readRunFile(ctx, ptr) : null;
      if (run && run.state === 'running' && !alive(run.pid)) {
        run.state = 'interrupted';
        run.pid = 0;
        saveRun(run);
      }
    }
  }

  /** When the server stops: the agents are killed and their runs marked interrupted. */
  function close(): void {
    for (const e of live.values()) {
      if (e.session && e.run.state === 'running') {
        stopSession(e, 'SIGKILL');
        e.run.state = 'interrupted';
        e.run.pid = 0;
        saveRun(e.run);
      }
      for (const l of e.listeners) l.end();
      e.listeners.clear();
    }
  }

  return { handle, recover, close };
}
