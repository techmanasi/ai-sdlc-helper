// The local web app's server (`ai-sdlc-helper ui`): the API over the engine, live updates as Server-Sent Events, and the
// built app from dist/web/ui. It listens on 127.0.0.1 only and answers only requests that carry its token. It reaches the
// engine through the package's public entry ('ai-sdlc-helper', which is src/index.ts), never its internals.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AGENT_STAGES, DefaultHarnessRegistry, agentSources, mergeAgent, registryFile, EFFORT_LEVELS, HARNESS_IDS, STAGE_DEFAULTS, addBacklogItem, answerQuestions, archiveCompleted, archiveTask, boardView, createPrForCompleted,
  decide, discard, doctor, editOverrides, editSettings, getCompletedTaskDetail, hashOf, listCompletedTasks, main, readRegistry, repoRulesFile, resolve,
  restart, runContext, runView, start, stop, syncPrComments, type Outcome, type RunContext,
} from 'ai-sdlc-helper';
import { COOKIE, HttpError, guard, hasToken, readBody, sendJson, sendStatic } from './http.js';
import { triageRoutes } from './triage.js';

export interface ServerOptions {
  /** The port to listen on; taken, the next free one (up to 20 more). 0: any free port. Default 4477. */
  port?: number;
  /** The token every request must carry; default: a new random one. */
  token?: string;
  env?: NodeJS.ProcessEnv;
  /** The folder `ui` was started in: a git repository there is offered even when it is not registered. */
  cwd?: string;
  /** The built app; default dist/web/ui beside this server. */
  uiDir?: string;
  /** How to run the command for the command palette; default this Node and dist/bin.js. */
  cli?: string[];
  /** How often the live board is read, in ms (default 2000). */
  pollMs?: number;
  /** The claude command triage runs spawn (tests); default 'claude'. */
  claude?: string;
}

export interface RunningServer {
  url: string;
  /** The URL that signs the browser in (it carries the token once, then a cookie does). */
  openUrl: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export const DEFAULT_PORT = 4477;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND_TIMEOUT_MS = 120000;
const here = path.dirname(fileURLToPath(import.meta.url));

interface Project { name: string; path: string; registered: boolean }

const gitTop = (dir: string, env: NodeJS.ProcessEnv): Promise<string | null> => new Promise(res => {
  const p = spawn('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.on('error', () => res(null));
  p.on('close', code => res(code === 0 ? out.trim() : null));
});

const outcome = (o: Outcome) => ({ ok: o.code === 0, code: o.code, out: o.out, err: o.err });

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const env = opts.env || process.env;
  const token = opts.token || crypto.randomBytes(24).toString('base64url');
  const uiDir = opts.uiDir || path.join(here, '..', 'ui');
  const cli = opts.cli || [process.execPath, path.join(here, '..', '..', 'bin.js')];
  const pollMs = opts.pollMs ?? 2000;
  const current = opts.cwd ? await gitTop(opts.cwd, env) : null;
  let port = opts.port ?? DEFAULT_PORT;

  async function projects(): Promise<Project[]> {
    const list: Project[] = readRegistry(env).map(e => ({ name: e.name, path: e.path, registered: true }));
    if (current && !list.some(p => path.resolve(p.path) === path.resolve(current))) {
      const base = path.basename(current).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '') || 'project';
      list.push({ name: list.some(p => p.name === base) ? `${base}-here` : base, path: current, registered: false });
    }
    return list;
  }

  async function project(name: string): Promise<Project> {
    const p = (await projects()).find(x => x.name === name);
    if (!p) throw new HttpError(404, `no project named '${name}'`);
    return p;
  }

  const contextFor = (p: Project, extra: Record<string, string> = {}): RunContext => {
    try { return runContext(p.path, { ...env, ...extra }); } catch (e) { throw new HttpError(400, (e as Error).message); }
  };

  /** The models each harness offers, with whether they take an effort, for the pickers. */
  const harnessModels = async () => {
    const reg = new DefaultHarnessRegistry();
    const out: Record<string, { id: string; name: string; supportsEffort: boolean; defaultEffort?: string }[]> = {};
    for (const h of reg.list()) out[h.id] = (await h.listModels(env)).map(m => ({ id: m.id, name: m.name, supportsEffort: m.supportsEffort, defaultEffort: m.defaultEffort }));
    return out;
  };

  /** The runs of <p> that are running or paused: a settings change reaches only the runs started after it. */
  const activeRuns = (p: Project): string[] => {
    try { return boardView(contextFor(p), { changes: false }).runs.filter(r => r.state === 'running' || r.state === 'paused').map(r => r.slug); } catch { return []; }
  };

  const slugOf = (s: string): string => { if (!SLUG.test(s)) throw new HttpError(400, `not a backlog slug: '${s}'`); return s; };

  const envOf = (v: unknown): Record<string, string> => {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'env must be an object of names and values');
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (!ENV_NAME.test(k)) throw new HttpError(400, `not a variable name: '${k}'`);
      out[k] = String(val ?? '');
    }
    return out;
  };

  const fromOf = (v: unknown): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !SLUG.test(v)) throw new HttpError(400, `not a stage: '${String(v)}'`);
    return v;
  };

  /** Runs a command line of this tool in <cwd>, as the palette does: a separate process, so a long one cannot block us. */
  const runCommand = (args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> =>
    new Promise(res => {
      const p = spawn(cli[0], [...cli.slice(1), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, COMMAND_TIMEOUT_MS);
      p.stdout.on('data', d => { if (stdout.length < 1e6) stdout += d; });
      p.stderr.on('data', d => { if (stderr.length < 1e6) stderr += d; });
      p.on('error', e => { clearTimeout(timer); res({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut }); });
      p.on('close', code => { clearTimeout(timer); res({ code, stdout, stderr, timedOut }); });
    });

  /** A file of the item's folder (in the run's worktree when it has one), named relative to that folder. */
  function itemFile(ctx: RunContext, slug: string, rel: string): string {
    const v = runView(ctx, slug, { changes: false, tailLines: 0 });
    const dir = path.resolve(v.dir || ctx.root, ctx.backlogDir, slug);
    const file = path.resolve(dir, rel);
    if (!rel || (file !== dir && !file.startsWith(dir + path.sep))) throw new HttpError(400, `not a file of ${slug}: '${rel}'`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, `no file ${rel} for ${slug}`);
    return file;
  }

  const triage = triageRoutes({ env, claude: opts.claude || 'claude', project, projects, contextFor });

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // after "api"
    const method = req.method || 'GET';
    const body = method === 'POST' ? await readBody(req) : {};
    const send = (status: number, v: unknown) => sendJson(res, status, v);
    // Triage runs check their input (400) before the project is looked up (404).
    if (parts[0] === 'projects' && parts[1] && parts[2] === 'triage') return triage.handle(req, res, parts, url, body);

    if (parts[0] === 'session' && method === 'GET') {
      let version = 'unknown';
      try { version = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'package.json'), 'utf8')).version; } catch { /* source run */ }
      return send(200, { version, projects: await projects() });
    }
    if (parts[0] === 'projects' && parts.length === 1) {
      if (method === 'GET') return send(200, { projects: await projects() });
      if (method === 'POST') {
        if (typeof body.path !== 'string' || !body.path) throw new HttpError(400, 'path is required');
        const args = ['add', body.path, '--yes', ...(typeof body.name === 'string' && body.name ? ['--name', body.name] : [])];
        const out: string[] = [];
        const err: string[] = [];
        const code = await main(args, { out: t => out.push(t), err: t => err.push(t), env, cwd: opts.cwd });
        return send(code === 0 ? 200 : 400, { ok: code === 0, code, out, err, projects: await projects() });
      }
    }
    if (parts[0] !== 'projects' || !parts[1]) throw new HttpError(404, 'no such API');
    const p = await project(parts[1]);
    const what = parts[2];

    if (what === 'doctor' && method === 'GET') return send(200, { checks: doctor(p.path, { env }) });
    if (what === 'board' && method === 'GET') return send(200, boardView(contextFor(p)));
    if (what === 'settings' && method === 'GET') {
      const r = resolve(p.path, { env });
      const file = path.join(p.path, 'sdlc.config.json');
      const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const entry = readRegistry(env).find(e => e.name === p.name);
      let fileJson: Record<string, any> = {};
      try { fileJson = raw ? JSON.parse(raw) : {}; } catch { /* the settings errors already say so */ }
      const fileAgent = Object.fromEntries(Object.entries((fileJson.agent || {}) as Record<string, unknown>).filter(([k]) => ['harness', 'model', 'effort', 'stages'].includes(k)));
      const personalAgent = (entry?.overrides?.agent || undefined) as Record<string, any> | undefined;
      return send(200, {
        ...r, raw, hash: hashOf(raw ?? ''), overrides: entry?.overrides || {}, registered: Boolean(entry),
        fileAgent, personalAgent: personalAgent || {}, sources: agentSources(mergeAgent(fileAgent, personalAgent), personalAgent),
        files: { project: path.join(p.path, 'sdlc.config.json'), personal: registryFile(env) },
        harnesses: [...HARNESS_IDS], stages: [...AGENT_STAGES], efforts: [...EFFORT_LEVELS], stageDefaults: STAGE_DEFAULTS,
        models: await harnessModels(), activeRuns: activeRuns(p),
      });
    }
    if (what === 'settings' && method === 'POST') {
      if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) throw new HttpError(400, 'patch must be an object');
      if (body.hash !== undefined && typeof body.hash !== 'string') throw new HttpError(400, 'hash must be text');
      const r = editSettings(p.path, body.patch, body.hash);
      return send(r.ok ? 200 : 400, { ...r, activeRuns: activeRuns(p) });
    }
    if (what === 'overrides' && method === 'POST') {
      if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) throw new HttpError(400, 'patch must be an object');
      try {
        const r = editOverrides(p.name, body.patch, env);
        return send(r.ok ? 200 : 400, r);
      } catch (e) { throw new HttpError(404, (e as Error).message); }
    }
    if (what === 'command' && method === 'POST') {
      if (!Array.isArray(body.args) || !body.args.every((a: unknown) => typeof a === 'string')) throw new HttpError(400, 'args must be a list of strings');
      return send(200, await runCommand(body.args, p.path));
    }
    if (what === 'backlog') {
      const ctx = contextFor(p);
      if (method === 'POST' && parts.length === 3) {
        try {
          const r = addBacklogItem({ root: ctx.root, backlogDir: ctx.backlogDir }, { slug: body.slug, type: body.type, title: body.title, brief: body.brief });
          let started: unknown = null;
          if (body.start === true) started = outcome(start(ctx, body.slug));
          return send(200, { ok: true, ...r, started });
        } catch (e) { throw new HttpError(400, (e as Error).message); }
      }
      if (method === 'GET' && parts[3]) {
        const slug = slugOf(parts[3]);
        const file = path.join(ctx.root, ctx.backlogDir, slug, 'brief.md');
        return send(200, { slug, brief: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null });
      }
    }
    if (what === 'runs' && parts[3]) {
      const slug = slugOf(parts[3]);
      const action = parts[4];
      if (!action && method === 'GET') return send(200, runView(contextFor(p), slug));
      if (action === 'file' && method === 'GET') {
        const file = itemFile(contextFor(p), slug, url.searchParams.get('path') || '');
        return send(200, { path: url.searchParams.get('path'), text: fs.readFileSync(file, 'utf8') });
      }
      if (action === 'pr' && method === 'GET') {
        const ctx = contextFor(p);
        const v = runView(ctx, slug, { changes: false, tailLines: 0 });
        const prCommentsFile = path.join(v.dir || ctx.root, ctx.backlogDir, slug, 'pr-comments.md');
        const markdown = fs.existsSync(prCommentsFile) ? fs.readFileSync(prCommentsFile, 'utf8') : null;
        return send(200, { pr: v.pr || null, state: v.prState || null, markdown });
      }
      if (action === 'test-issues' && method === 'GET') {
        const ctx = contextFor(p);
        const v = runView(ctx, slug, { changes: false, tailLines: 0 });
        if (!v.dir) throw new HttpError(404, `${slug} has no run directory`);
        const issuesFile = path.join(v.dir, ctx.backlogDir, slug, 'test-issues.md');
        return send(200, { slug, text: fs.existsSync(issuesFile) ? fs.readFileSync(issuesFile, 'utf8') : null });
      }
      if (method !== 'POST') throw new HttpError(405, 'use POST');
      const ctx = contextFor(p, envOf(body.env));
      if (action === 'start') return send(200, outcome(start(ctx, slug, { from: fromOf(body.from) })));
      if (action === 'stop') return send(200, outcome(await stop(ctx, slug)));
      if (action === 'discard') return send(200, outcome(await discard(ctx, slug, { yes: true, stop: body.stop === true })));
      if (action === 'restart') return send(200, outcome(await restart(ctx, slug, { yes: true, from: fromOf(body.from) })));
      if (action === 'options') {
        const v = runView(ctx, slug, { changes: false, tailLines: 0 });
        if (v.stage === 'Finalise' || v.state === 'done') {
          throw new HttpError(400, 'Finalise stage has already started; cannot modify PR creation setting');
        }
        const optDir = path.join(v.dir || ctx.root, ctx.backlogDir, slug, 'logs');
        fs.mkdirSync(optDir, { recursive: true });
        const optFile = path.join(optDir, 'finalise-options.json');
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(optFile, 'utf8')); } catch { /* ignore */ }
        if (typeof body.createPr === 'boolean') {
          existing.createPr = body.createPr;
        }
        fs.writeFileSync(optFile, JSON.stringify(existing, null, 2) + '\n');
        return send(200, { ok: true, createPr: existing.createPr === true });
      }
      if (action === 'answers') {
        const v = runView(ctx, slug, { changes: false, tailLines: 0 });
        if (!v.dir) throw new HttpError(404, `${slug} has no run with questions`);
        const qNums = new Set(v.questions.map(q => String(q.n)));
        const rawAnswers = body.answers && typeof body.answers === 'object' ? body.answers as Record<string, unknown> : {};
        const answers: Record<string, string> = {};
        for (const [k, val] of Object.entries(rawAnswers)) {
          if (qNums.has(String(k)) && typeof val === 'string') answers[k] = val;
        }
        let counts: { total: number; answered: number };
        try { counts = answerQuestions(path.join(v.dir, ctx.backlogDir, slug, 'questions.md'), answers); } catch (e) { throw new HttpError(400, (e as Error).message); }
        const resumed = body.resume !== false && counts.answered === counts.total ? outcome(start(ctx, slug, { from: v.resumeFrom || undefined })) : null;
        return send(200, { ok: true, ...counts, resumed });
      }
      if (action === 'permissions') {
        const v = runView(ctx, slug, { changes: false, tailLines: 0 });
        const whichStr = String(body.which ?? '');
        const isFromDenied = whichStr.startsWith('denied:');
        const hasActions = isFromDenied ? (v.deniedPermissions && v.deniedPermissions.length > 0) : v.permissions.length > 0;
        if (!v.dir || !hasActions) throw new HttpError(404, `${slug} has no ${isFromDenied ? 'denied' : 'refused'} actions to decide`);
        const stage = isFromDenied ? (v.deniedPermissions[0]?.stage || 'finalise') : v.permissions[0].stage;
        let pending: number;
        try {
          pending = decide(path.join(v.dir, ctx.backlogDir, slug, 'logs', 'permissions.json'), whichStr, String(body.choice ?? ''), repoRulesFile(ctx.root));
        } catch (e) { throw new HttpError(400, (e as Error).message); }
        // The stage that was refused runs again (Spec from the start, the test audit as part of Implement).
        const from = stage === 'spec' ? undefined : stage === 'test-audit' ? 'implement' : stage;
        const shouldResume = isFromDenied ? (body.resume === true) : (body.resume !== false && pending === 0);
        const resumed = shouldResume ? outcome(start(ctx, slug, { from })) : null;
        return send(200, { ok: true, pending, resumed });
      }
      if (action === 'test-issues') {
        const v = runView(ctx, slug, { changes: false, tailLines: 0 });
        if (!v.dir) throw new HttpError(404, `${slug} has no run directory`);
        const issuesFile = path.join(v.dir, ctx.backlogDir, slug, 'test-issues.md');
        if (typeof body.text !== 'string') throw new HttpError(400, 'text is required');
        fs.mkdirSync(path.dirname(issuesFile), { recursive: true });
        fs.writeFileSync(issuesFile, body.text);
        const resumed = body.resume !== false ? outcome(start(ctx, slug, { from: 'test-repair' })) : null;
        return send(200, { ok: true, text: body.text, resumed });
      }
      if (action === 'pr') {
        const r = createPrForCompleted(ctx, slug);
        return send(r.ok ? 200 : 400, r);
      }
      if (action === 'pr-sync') {
        const r = syncPrComments(ctx, slug);
        return send(r.ok ? 200 : 400, r);
      }
    }
    if (what === 'completed') {
      const ctx = contextFor(p);
      if (method === 'GET' && !parts[3]) {
        return send(200, { completed: listCompletedTasks(ctx) });
      }
      if (parts[3]) {
        const slug = slugOf(parts[3]);
        if (method === 'GET' && parts.length === 4) {
          return send(200, getCompletedTaskDetail(ctx, slug));
        }
        if (method === 'POST' && parts[4] === 'pr') {
          const r = createPrForCompleted(ctx, slug);
          return send(r.ok ? 200 : 400, r);
        }
        if (method === 'POST' && parts[4] === 'sync') {
          const r = syncPrComments(ctx, slug);
          return send(r.ok ? 200 : 400, r);
        }
      }
    }
    if (what === 'archive') {
      const ctx = contextFor(p);
      if (method === 'POST' && parts[3]) {
        const slug = slugOf(parts[3]);
        const ok = archiveTask({ root: ctx.root, backlogDir: ctx.backlogDir }, slug);
        return send(ok ? 200 : 400, { ok, archived: ok });
      }
      if (method === 'POST' && parts.length === 3) {
        const olderThanDays = typeof body.olderThanDays === 'number' ? body.olderThanDays : undefined;
        const all = body.all === true || olderThanDays === undefined;
        const r = archiveCompleted({ root: ctx.root, backlogDir: ctx.backlogDir }, { all, olderThanDays });
        return send(200, { ok: true, ...r });
      }
    }
    throw new HttpError(404, 'no such API');
  }

  /** Live updates: the board of a project whenever it changes, as SSE "board" events. */
  async function events(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const p = await project(url.searchParams.get('project') || '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let last = '';
    let ticks = 0;
    let busy = false;
    const push = () => {
      if (busy) return;
      busy = true;
      try {
        // File counts need git, so they are refreshed every fifth read; the rest of the board every read.
        const board = boardView(contextFor(p), { changes: ticks++ % 5 === 0 });
        const text = JSON.stringify(board);
        if (text !== last) { last = text; res.write(`event: board\ndata: ${text}\n\n`); }
      } catch (e) {
        res.write(`event: problem\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`);
      } finally { busy = false; }
    };
    push();
    const timer = setInterval(push, pollMs);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(timer); clearInterval(ping); });
  }

  const server = http.createServer((req, res) => {
    (async () => {
      guard(req, port);
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      // The opening URL carries the token once: it becomes a cookie, and the address bar drops it.
      if (url.pathname === '/' && url.searchParams.has('t')) {
        const t = url.searchParams.get('t') || '';
        if (t !== token) throw new HttpError(401, 'wrong token: open the URL that ai-sdlc-helper ui printed');
        res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
        return res.end();
      }
      if (!hasToken(req, token)) throw new HttpError(401, 'not signed in: open the URL that ai-sdlc-helper ui printed');
      if (url.pathname === '/api/events') return events(req, res, url);
      if (url.pathname.startsWith('/api/')) return api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'use GET');
      if (!sendStatic(res, uiDir, url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('The web app is not built. Run: npm run build (it builds dist/web/ui).\n');
      }
    })().catch(e => {
      const status = e instanceof HttpError ? e.status : 500;
      if (res.headersSent) { res.end(); return; }
      const wantsJson = (req.url || '').startsWith('/api/') || req.headers.accept?.includes('json');
      if (wantsJson) sendJson(res, status, { ok: false, error: (e as Error).message });
      else { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`${(e as Error).message}\n`); }
    });
  });

  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((res, rej) => {
        server.once('error', rej);
        server.listen(port, '127.0.0.1', () => { server.off('error', rej); res(); });
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0 || attempt >= 20) throw e;
      port++;
    }
  }
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  await triage.recover();
  return {
    url, port, token,
    openUrl: `${url}/?t=${token}`,
    close: () => new Promise(res => { triage.close(); server.closeAllConnections?.(); server.close(() => res()); }),
  };
}
