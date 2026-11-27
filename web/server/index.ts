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
  AGENT_STAGES, CONFIG_FILE, DefaultHarnessRegistry, configDir, TRACE_FILE, startTrace, stopTrace, trace, traceSettings, agentSources, mergeAgent, registryFile, EFFORT_LEVELS, HARNESS_IDS, STAGE_DEFAULTS, addBacklogItem, syncPr, writeCiFailure, readRunDoc, readBacklogEdit, editBacklogItem, BacklogEditError, answerQuestions, archiveCompleted, archiveTask, boardView, boardInputs, boardIgnores, stampOf as fingerprintOf, prPollOptions, PR_POLL_MS, createPrForCompleted, markPrReadyForRun,
  decide, discard, doctor, editOverrides, editSettings, setRunBehaviour, getCompletedTaskDetailAsync, hashOf, completedListAsync, primeRepoPaths, warmCompletedPrs, keepError, main, readRegistry, repoRulesFile, resolve,
  editorArgv, editorChoices, editorSettingErrors, findContaining, normalizeEditor, readEditorSetting, registryDir, validateCustomEditor, writeEditorSetting,
  restart, discardStage, undoLast, readRecord, alive, runContext, runView, runPaths, runTail, RUN_PARTS, type RunPart, start, stop, type Outcome, type RunContext,
  closeGoneRuns, loadOpencodePrices, parseReviewLimit, REVIEW_LIMIT_ENV, REVIEW_LIMIT_REQUIREMENT,
  inspectCodeSearch, executableBuild, codeIndexers, fileErrors, applyPatch, runBehaviourErrors, runEnvSet, type RunBehaviour,
} from 'ai-sdlc-helper';
import { COOKIE, HttpError, guard, hasToken, readBody, sendJson, sendStatic } from './http.js';
import { triageRoutes } from './triage.js';
import { createRunStreams, type RunSource, type StreamTimings } from './watch.js';
import { BOARD_WATCH_TIMINGS, createBoardWatch, type BoardWatch, type BoardWatchTimings } from './board-watch.js';

/** SDLC_BOARD_SILENCE_MS: how long the board's watcher may be silent before its files are checked (ms; default 30 s, at least 1 s). */
function silenceFrom(env: NodeJS.ProcessEnv): Partial<BoardWatchTimings> {
  const ms = Number(env.SDLC_BOARD_SILENCE_MS);
  return Number.isFinite(ms) && ms >= 1000 ? { silenceMs: ms } : {};
}

export interface ServerOptions {
  /** The port to listen on; an explicitly requested port is fixed. The default tries the next 20 ports. 0: any free port. */
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
  /** No longer used: the board is rebuilt when a file changes (board-watch.ts), not on a clock. Kept so callers that pass it still compile. */
  pollMs?: number;
  /** The board watcher's timings (see board-watch.ts); tests shorten them. */
  boardWatch?: Partial<BoardWatchTimings>;
  /** How often the trace is written to its file (default 1 s); tests set it low to read the trace soon after an event. */
  traceFlushMs?: number;
  /** Timings of the per-run stream (tests): debounce, safety tick, ping and tail throttle, in ms. */
  stream?: Partial<StreamTimings>;
  /** How long after the start the PR statuses of the Completed lists are warmed (default 3000 ms; tests shorten it). */
  warmPrDelayMs?: number;
  /** How often runs whose supervisor is gone are closed (default 30000 ms; tests shorten it). */
  goneSweepMs?: number;
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
  /** The per-run streams open now: pages and watched folders of each (tests). */
  streamStats(): Record<string, { clients: number; watched: number }>;
  /** Resolves once the start-up warm-up of the PR statuses has finished (at once when it is off or the server closed). */
  prWarmup(): Promise<void>;
}

export const DEFAULT_PORT = 4477;
const DEV_SIGNIN_TRACKER = `(() => {
  const key = 'ai-sdlc-helper.sign-in-url';
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch('/__dev/signin-url', { cache: 'no-store' });
      if (!response.ok) return;
      const { url } = await response.json();
      if (!url) return;
      const previous = sessionStorage.getItem(key);
      sessionStorage.setItem(key, url);
      if (previous && previous !== url) location.replace(url);
    } catch { /* retry on the next poll */ }
    finally { checking = false; }
  };
  void check();
  setInterval(check, 1000);
})();`;
/** What a Sync PR in flight is doing now, by project and slug: read by the run screen while the slow GitHub call runs. */
const syncProgress = new Map<string, string>();
const syncing = async (key: string, run: (onStep: (label: string) => void) => ReturnType<typeof syncPr>) => {
  try { return await run(label => { syncProgress.set(key, label); }); } finally { syncProgress.delete(key); }
};
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** The longest instruction a user may leave for a resumed stage. */
const MAX_NOTE = 4000;
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
  // Every run this server starts gets its environment from here, so one marker says the web UI started it.
  // `liveEnv` is the caller's own object, never written to: SDLC_BOARD_SILENCE_MS is read from it on each use.
  const liveEnv: NodeJS.ProcessEnv = opts.env || process.env;
  const env: NodeJS.ProcessEnv = { ...liveEnv, SDLC_RUN_TRIGGER: 'ui' };
  delete env[REVIEW_LIMIT_ENV]; // Each request inherits the project budget unless it supplies its own.
  const token = opts.token || crypto.randomBytes(24).toString('base64url');
  const uiDir = opts.uiDir || path.join(here, '..', 'ui');
  const cli = opts.cli || [process.execPath, path.join(here, '..', '..', 'bin.js')];
  const current = opts.cwd ? await gitTop(opts.cwd, env) : null;
  let port = opts.port ?? DEFAULT_PORT;

  // The trace of repeating actions (src/trace.ts): always on, rotating; settings from the opening folder's sdlc.config.json.
  let traceBlock: unknown;
  try { if (current) traceBlock = JSON.parse(fs.readFileSync(path.join(current, 'sdlc.config.json'), 'utf8')).trace; } catch { /* no file or not JSON: defaults */ }
  const tracer = startTrace({ file: path.join(configDir(env), TRACE_FILE), settings: traceSettings(traceBlock, env).settings, rotate: true, ...(opts.traceFlushMs ? { flushMs: opts.traceFlushMs } : {}) });

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

  // One context per project, built again only when what it is made from changes: the project's settings file and the
  // registry (which holds the personal settings and overrides). Building one costs three git calls, and every request
  // and every board rebuild asks for it. A request that changes a project drops its context (see the request handler).
  const contexts = new Map<string, { key: string; ctx: RunContext }>();
  const stampOf = (file: string): string => { try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } };
  const contextKey = (root: string): string => `${stampOf(path.join(root, CONFIG_FILE))}|${stampOf(registryFile(env))}`;
  const contextFor = (p: Project, extra: Record<string, string> = {}): RunContext => {
    try {
      // A request with its own environment (run options) is built on its own, and not kept.
      if (Object.keys(extra).length) return runContext(p.path, { ...env, ...extra });
      const id = `${p.name}\n${p.path}`;
      const hit = contexts.get(id);
      if (hit && hit.key === contextKey(hit.ctx.root)) { trace({ action: 'context', why: 'cached', run: p.name, changed: false }); return { ...hit.ctx }; }
      const ctx = runContext(p.path, env);
      contexts.set(id, { key: contextKey(ctx.root), ctx });
      trace({ action: 'context', why: hit ? 'changed' : 'first', run: p.name, changed: true });
      return { ...ctx };
    } catch (e) { throw new HttpError(400, (e as Error).message); }
  };
  const contextFresh = (p: Project): boolean => { const hit = contexts.get(`${p.name}\n${p.path}`); return Boolean(hit && hit.key === contextKey(hit.ctx.root)); };
  const dropContext = (name: string): void => { for (const id of contexts.keys()) if (id.startsWith(`${name}\n`)) contexts.delete(id); };

  /** The models each harness offers, with whether they take an effort and which providers offer them, for the pickers. */
  const reg = new DefaultHarnessRegistry();
  const harnessModels = async () => {
    const out: Record<string, { id: string; name: string; displayName?: string; supportsEffort: boolean; supportedEfforts?: string[]; defaultEffort?: string; providerId?: string; providerName?: string }[]> = {};
    for (const h of reg.list()) out[h.id] = (await h.listModels(env)).map(m => ({
      id: m.id, name: m.name, displayName: m.displayName, supportsEffort: m.supportsEffort, supportedEfforts: m.supportedEfforts,
      defaultEffort: m.defaultEffort, providerId: m.providerId, providerName: m.providerName,
    }));
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
      if (k === REVIEW_LIMIT_ENV && parseReviewLimit(val) === undefined) throw new HttpError(400, `${k} ${REVIEW_LIMIT_REQUIREMENT}`);
      out[k] = String(val ?? '');
    }
    return out;
  };

  const fromOf = (v: unknown): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string' || !SLUG.test(v)) throw new HttpError(400, `not a stage: '${String(v)}'`);
    return v;
  };

  /** The user's optional instruction for the resumed stage: trimmed, at most 4000 characters, for stage <to>. */
  const noteOf = (v: unknown, to: string | undefined): { to: string; text: string } | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new HttpError(400, 'note must be text');
    const text = v.trim();
    if (text.length > MAX_NOTE) throw new HttpError(400, `note is ${text.length} characters; the limit is ${MAX_NOTE}`);
    return text ? { to: to || 'spec', text } : undefined;
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

  const inFlightBuilds = new Set<string>();

  interface BuildResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    error?: Error;
  }

  /** Runs an indexer build process in <cwd> with the resolved program and argv. */
  const runBuild = (program: string, args: string[], cwd: string): Promise<BuildResult> => new Promise(res => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const p = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });

    const finish = (result: { code: number | null; signal?: NodeJS.Signals | null; error?: Error; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      res({ ...result, signal: result.signal ?? null, stdout, stderr });
    };

    // A timeout kills the child, but the build guard is held until it actually exits: a second setup must not spawn on
    // top of a child that ignored SIGTERM. The force timer is a last resort for a child that never closes its pipes.
    const timer = setTimeout(() => {
      timedOut = true;
      try { p.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* already gone */ } }, 500);
      forceTimer = setTimeout(() => finish({ code: null, signal: null, timedOut: true }), 2000);
    }, COMMAND_TIMEOUT_MS);

    p.stdout?.on('data', d => { if (stdout.length < 1e6) stdout += d; });
    p.stderr?.on('data', d => { if (stderr.length < 1e6) stderr += d; });

    p.on('error', e => finish({ code: null, signal: null, error: e, timedOut }));
    p.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      finish({ code, signal, timedOut });
    });
    p.on('exit', (code, signal) => {
      // The child is gone; a descendant may still hold its output pipes, so settle without waiting for them forever.
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = setTimeout(() => finish({ code, signal, timedOut }), 100);
    });
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
    const body = (method === 'POST' || method === 'PUT') ? await readBody(req) : {};
    const send = (status: number, v: unknown) => sendJson(res, status, v);
    // Triage runs check their input (400) before the project is looked up (404).
    if (parts[0] === 'projects' && parts[1] && parts[2] === 'triage') return triage.handle(req, res, parts, url, body);

    if (parts[0] === 'session' && method === 'GET') {
      let version = 'unknown';
      try { version = JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'package.json'), 'utf8')).version; } catch { /* source run */ }
      return send(200, { version, projects: await projects() });
    }
    // The machine-wide default editor (the registry file root's "editor"), used by "Open in editor" on every page.
    if (parts[0] === 'editor' && parts.length === 1) {
      if (method === 'GET') {
        return send(200, { editor: normalizeEditor(readEditorSetting(env)), editors: editorChoices(process.platform) });
      }
      if (method === 'PUT') {
        const errors = editorSettingErrors(body.choice, body.custom);
        if (errors.length) throw new HttpError(400, errors.join('; '));
        try {
          writeEditorSetting({ choice: body.choice, ...(typeof body.custom === 'string' && body.custom.trim() ? { custom: body.custom } : {}) }, env);
        } catch (e) { throw new HttpError(400, (e as Error).message); }
        return send(200, { ok: true, editor: normalizeEditor(readEditorSetting(env)) });
      }
      throw new HttpError(405, 'use GET or PUT');
    }
    // Opens a folder with that editor: a project's path or a run's worktree, absolute, or relative to a named project.
    if (parts[0] === 'editor' && parts[1] === 'open' && parts.length === 2 && method === 'POST') {
      if (typeof body.path !== 'string' || !body.path.trim()) throw new HttpError(400, 'path is required');
      let dir = body.path.trim();
      if (!path.isAbsolute(dir)) {
        if (typeof body.project !== 'string' || !body.project) throw new HttpError(400, `'${dir}' is not an absolute path; name its project to resolve it`);
        dir = path.resolve((await project(body.project)).path, dir);
      }
      const setting = normalizeEditor(readEditorSetting(env));
      const bad = setting.choice === 'custom' ? validateCustomEditor(setting.custom) : null;
      if (bad) throw new HttpError(400, `the custom editor command is not valid: ${bad}`);
      const argv = editorArgv(setting.choice, setting.custom, dir, process.platform);
      // Spawned detached, without a shell: {path} went in as one argument, so nothing here builds a command string.
      // The spawn itself is awaited, so "code is not installed or not on PATH" reaches the response instead of a console.
      const opened = await new Promise<{ ok: boolean; error?: Error & { code?: string } }>(res => {
        let child: ReturnType<typeof spawn>;
        try { child = spawn(argv.cmd, argv.args, { detached: true, stdio: 'ignore', shell: false }); }
        catch (e) { res({ ok: false, error: e as Error & { code?: string } }); return; }
        let done = false;
        child.once('spawn', () => { if (!done) { done = true; res({ ok: true }); } });
        child.once('error', e => { if (!done) { done = true; res({ ok: false, error: e as Error & { code?: string } }); } });
        child.unref();
      });
      if (opened.ok) return send(200, { ok: true, editor: setting.choice });
      const code = opened.error?.code;
      const message = code === 'ENOENT' ? `${argv.cmd} is not installed or not on PATH` : `${argv.cmd}: ${opened.error?.message || 'could not be started'}`;
      // Recorded like other server errors: the errors.log of the named project, else of the registered project holding
      // the folder. keepError never throws; the response carries the message either way.
      try {
        const entries = readRegistry(env);
        const holder = (typeof body.project === 'string' && entries.find(e => e.name === body.project)) || findContaining(entries, dir);
        if (holder) keepError({ root: registryDir(holder.path), log: '' }, `open in editor: ${dir}`, message);
      } catch { /* the registry was readable when this request read the editor setting; the response already says this */ }
      throw new HttpError(code === 'ENOENT' ? 400 : 500, message);
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

    if (what === 'code-search') {
      if (parts.length === 3 && method === 'GET') {
        const configFile = path.join(p.path, CONFIG_FILE);
        let raw = '';
        if (fs.existsSync(configFile)) {
          try {
            raw = fs.readFileSync(configFile, 'utf8');
          } catch (e) {
            throw new HttpError(400, `could not read ${CONFIG_FILE}: ${(e as Error).message}`);
          }
        }
        let fileJson: any = {};
        if (raw) {
          try {
            fileJson = JSON.parse(raw);
          } catch (e) {
            throw new HttpError(400, `malformed ${CONFIG_FILE}: ${(e as Error).message}`);
          }
        }
        return send(200, inspectCodeSearch(p.path, fileJson, env));
      }

      if (parts.length === 4 && parts[3] === 'setup' && method === 'POST') {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return send(400, { ok: false, error: 'body must be an object' });
        }
        if (typeof body.indexer !== 'string' || !body.indexer) {
          return send(400, { ok: false, error: 'indexer must be a non-empty string' });
        }
        if (body.build !== undefined && typeof body.build !== 'boolean') {
          return send(400, { ok: false, error: 'build must be a boolean' });
        }
        const indexer = body.indexer;
        const shouldBuild = body.build === true;

        if (inFlightBuilds.has(p.path)) {
          return send(400, { ok: false, error: `a build is already in progress for ${p.name}` });
        }

        const configFile = path.join(p.path, CONFIG_FILE);
        let raw = '';
        if (fs.existsSync(configFile)) {
          try {
            raw = fs.readFileSync(configFile, 'utf8');
          } catch (e) {
            return send(400, { ok: false, error: `could not read ${CONFIG_FILE}: ${(e as Error).message}` });
          }
        }
        const initialHash = hashOf(raw);
        let currentConfig: any = {};
        if (raw) {
          try {
            currentConfig = JSON.parse(raw);
          } catch (e) {
            return send(400, { ok: false, error: `${CONFIG_FILE}: not valid JSON (${(e as Error).message})` });
          }
        }

        const all = codeIndexers(currentConfig);
        if (!Object.prototype.hasOwnProperty.call(all, indexer)) {
          return send(400, { ok: false, error: `unknown indexer: '${indexer}'` });
        }

        // Validate prospective config before launching build
        const prospective = applyPatch(currentConfig, { agent: { codeSearch: indexer } });
        const prospectiveErrors = fileErrors(prospective).map(e => `${CONFIG_FILE}: ${e}`);
        if (prospectiveErrors.length) {
          return send(400, { ok: false, error: prospectiveErrors.join(', ') });
        }

        let buildOutput: string | undefined = undefined;

        if (shouldBuild) {
          const spec = executableBuild(all[indexer], env);
          if (!spec) {
            return send(400, {
              ok: false,
              error: `cannot build indexer '${indexer}': no executable build command or binary not on PATH`,
            });
          }
          const label = all[indexer].build || `${indexer} build`;

          inFlightBuilds.add(p.path);
          try {
            const resBuild = await runBuild(spec.program, spec.argv, p.path);
            buildOutput = [resBuild.stdout, resBuild.stderr].filter(Boolean).join('');
            if (resBuild.timedOut) {
              return send(400, {
                ok: false,
                error: 'build timed out after 120s',
                ...(buildOutput ? { output: buildOutput } : {}),
              });
            }
            if (resBuild.error) {
              return send(400, {
                ok: false,
                error: resBuild.error.message,
                ...(buildOutput ? { output: buildOutput } : {}),
              });
            }
            if (resBuild.code !== 0 || resBuild.signal) {
              const status = resBuild.signal ? `signal ${resBuild.signal}` : `code ${resBuild.code}`;
              return send(400, {
                ok: false,
                error: `${label} exited with ${status}`,
                ...(buildOutput ? { output: buildOutput } : {}),
              });
            }
          } finally {
            inFlightBuilds.delete(p.path);
          }
        }

        // Apply setting change
        const saveResult = editSettings(p.path, { agent: { codeSearch: indexer } }, initialHash);
        if (!saveResult.ok) {
          return send(400, {
            ok: false,
            error: saveResult.errors.join(', '),
            ...(buildOutput !== undefined ? { output: buildOutput } : {}),
          });
        }

        dropContext(p.name);
        const checks = doctor(p.path, { env });
        return send(200, {
          ok: true,
          codeSearch: indexer,
          checks,
          ...(buildOutput !== undefined ? { output: buildOutput } : {}),
        });
      }

      throw new HttpError(404, 'no such API');
    }

    // A project whose context must be built: git's part of it is asked first without blocking (about 150 ms of git).
    if (!contextFresh(p)) await primeRepoPaths(p.path, env);

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
        boardSilenceEnvSeconds: envSilenceSeconds(),
        fileAgent, personalAgent: personalAgent || {}, sources: agentSources(mergeAgent(fileAgent, personalAgent), personalAgent),
        files: { project: path.join(p.path, 'sdlc.config.json'), personal: registryFile(env) },
        harnesses: [...HARNESS_IDS], stages: [...AGENT_STAGES], efforts: [...EFFORT_LEVELS], stageDefaults: STAGE_DEFAULTS,
        models: await harnessModels(),
        // Harnesses that run one model through several providers: their picker offers a provider filter.
        multipleProviderHarnesses: reg.list().filter(h => h.multipleProvider).map(h => h.id),
        activeRuns: activeRuns(p),
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
        if (r.ok && 'boardSilenceSeconds' in body.patch) {
          const feed = feeds.get(p.name);
          if (feed) feed.timings.silenceMs = silenceMsFor(p);
        }
        return send(r.ok ? 200 : 400, r.ok ? { ok: true } : r);
      } catch (e) { throw new HttpError(404, (e as Error).message); }
    }
    if (what === 'run-behaviour' && method === 'GET') {
      const entry = readRegistry(env).find(e => e.name === p.name);
      const saved = (entry?.overrides?.run || null) as RunBehaviour | null;
      return send(200, {
        saved,
        envSet: runEnvSet(saved ?? undefined, env),
        registered: Boolean(entry),
      });
    }
    if (what === 'run-behaviour' && method === 'PUT') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'run behaviour must be an object');
      const run: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) if (v !== null && v !== undefined) run[k] = v;
      const errors = runBehaviourErrors(run);
      if (errors.length) return send(400, { ok: false, errors: errors.map(e => `run.${e}`) });
      try {
        const r = setRunBehaviour(p.name, run, env);
        if (!r.ok) return send(400, { ok: false, errors: r.errors });
        return send(200, { ok: true });
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
          // Per-stage picks travel as env overrides, the same way the run page starts one. A request with no overrides
          // keeps the cached context. `start: false` (or absent) writes the item without starting a run.
          const extra = envOf(body.env);
          const startCtx = Object.keys(extra).length ? contextFor(p, extra) : ctx;
          const r = addBacklogItem({ root: startCtx.root, backlogDir: startCtx.backlogDir }, { slug: body.slug, type: body.type, title: body.title, brief: body.brief });
          let started: unknown = null;
          if (body.start === true) started = outcome(start(startCtx, body.slug));
          return send(200, { ok: true, ...r, started });
        } catch (e) { throw new HttpError(400, (e as Error).message); }
      }
      const editErr = (e: unknown): never => {
        if (e instanceof BacklogEditError) throw new HttpError(e.status, e.message);
        throw e;
      };
      if (method === 'GET' && parts[3] && parts[4] === 'edit' && parts.length === 5) {
        const slug = slugOf(parts[3]);
        try { return send(200, readBacklogEdit(ctx, slug)); } catch (e) { return editErr(e); }
      }
      if (method === 'POST' && parts.length === 4) {
        const slug = slugOf(parts[3]);
        try {
          return send(200, editBacklogItem(ctx, slug, {
            title: body.title, type: body.type, brief: body.brief, hash: body.hash,
            ...(body.priority !== undefined && body.priority !== null ? { priority: body.priority } : {}),
          }));
        } catch (e) {
          if (e instanceof BacklogEditError && e.hash) return send(409, { ok: false, error: e.message, hash: e.hash });
          return editErr(e);
        }
      }
      if (method === 'GET' && parts[3] && parts.length === 4) {
        const slug = slugOf(parts[3]);
        const file = path.join(ctx.root, ctx.backlogDir, slug, 'brief.md');
        return send(200, { slug, brief: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null });
      }
    }
    if (what === 'runs' && parts[3]) {
      const slug = slugOf(parts[3]);
      const action = parts[4];
      if (!action && method === 'GET') {
        const asked = (url.searchParams.get('parts') || '').split(',').filter(Boolean);
        if (asked.some(x => !(RUN_PARTS as readonly string[]).includes(x))) throw new HttpError(400, `parts must be some of ${RUN_PARTS.join(', ')}`);
        return send(200, runView(contextFor(p), slug, { cacheGit: true, refresh: url.searchParams.get('refresh') === '1', ...(asked.length ? { parts: asked as RunPart[] } : {}) }));
      }
      if (action === 'file' && method === 'GET') {
        const file = itemFile(contextFor(p), slug, url.searchParams.get('path') || '');
        return send(200, { path: url.searchParams.get('path'), text: fs.readFileSync(file, 'utf8') });
      }
      if (action === 'pr-sync-progress' && method === 'GET') return send(200, { label: syncProgress.get(`${p}/${slug}`) || '' });
      if (action === 'pr' && method === 'GET') {
        const ctx = contextFor(p);
        const v = runView(ctx, slug, { changes: false, tailLines: 0 });
        // The run's copy: its worktree's, else its branch's, else the main checkout's (a merged PR brought it there).
        const markdown = readRunDoc(ctx, slug, 'pr-comments.md');
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
      if (action === 'start') {
        const from = fromOf(body.from);
        const note = noteOf(body.note, from || (body.note ? runView(ctx, slug, { changes: false, tailLines: 0 }).resumeFrom : ''));
        return send(200, outcome(start(ctx, slug, { from, note })));
      }
      if (action === 'stop') return send(200, outcome(await stop(ctx, slug)));
      if (action === 'undo') return send(200, outcome(await undoLast(ctx, slug, { stop: true })));
      if (action === 'discard') return send(200, outcome(await discard(ctx, slug, { yes: true, stop: body.stop === true })));
      if (action === 'discard-stage') {
        const d = await discardStage(ctx, slug, { stage: typeof body.stage === 'string' ? body.stage : undefined, stop: body.stop === true });
        if (d.code !== 0 || body.resume === false) return send(200, outcome(d));
        const resumed = start(ctx, slug, { from: typeof body.stage === 'string' ? body.stage : undefined });
        return send(200, { ...outcome(d), resumed: outcome(resumed) });
      }
      if (action === 'restart') {
        const from = fromOf(body.from);
        return send(200, outcome(await restart(ctx, slug, { yes: true, from, note: noteOf(body.note, from) })));
      }
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
        const r = await syncing(`${p}/${slug}`, onStep => syncPr(ctx, slug, onStep));
        return send(r.ok ? 200 : 400, r);
      }
      if (action === 'pr-ready') {
        const r = await syncing(`${p}/${slug}`, onStep => markPrReadyForRun(ctx, slug, onStep));
        return send(r.ok ? 200 : 400, r);
      }
      if (action === 'ci-fix') {
        // Start Implement again with the CI failure: ci-failure.md is written from GitHub's logs now, and read by the Implement agent.
        // A run in progress (Resolve conflicts included) owns the task's files: leave ci-failure.md alone and refuse.
        const going = readRecord(ctx.reg, slug);
        if (going?.state === 'running' && alive(going.pid)) return send(409, { ok: false, err: [`${slug} is running: wait for it to finish, then restart Implement`] });
        const f = writeCiFailure(ctx, slug);
        if (!f.ok || f.ci !== 'failed') return send(400, { ok: false, err: f.err || [f.ci === 'failed' ? 'the failure could not be read' : `the CI is not failing (${f.ci})`] });
        return send(200, { ok: true, summary: f.summary, ...(f.err ? { err: f.err } : {}), resumed: outcome(start(ctx, slug, { from: 'implement' })) });
      }
    }
    if (what === 'completed') {
      const ctx = contextFor(p);
      if (method === 'GET' && !parts[3]) {
        return send(200, await completedListAsync(ctx, { rowsFirst: url.searchParams.get('rows') === 'first' }));
      }
      if (parts[3]) {
        const slug = slugOf(parts[3]);
        if (method === 'GET' && parts.length === 4) {
          return send(200, await getCompletedTaskDetailAsync(ctx, slug));
        }
        if (method === 'POST' && parts[4] === 'pr') {
          const r = createPrForCompleted(ctx, slug);
          return send(r.ok ? 200 : 400, r);
        }
        if (method === 'POST' && parts[4] === 'sync') {
          const r = await syncing(`${p}/${slug}`, onStep => syncPr(ctx, slug, onStep));
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

  // One board feed per project, shared by every page that shows it: the board is built once a tick however many tabs
  // are open, a page that joins later gets the last board at once, and the feed stops with its last page.
  interface BoardFeed { clients: Set<http.ServerResponse>; last: string; ticks: number; busy: boolean; running: number; hasPr: boolean; builtAt: number; ping: NodeJS.Timeout; watch: BoardWatch; timings: BoardWatchTimings; build(why: string): void }
  const feeds = new Map<string, BoardFeed>();
  const boardEvent = (text: string): string => `event: board\ndata: ${text}\n\n`;

  function savedSilenceMs(p: Project): number | undefined {
    try {
      const s = readRegistry(env).find(e => e.name === p.name)?.overrides?.boardSilenceSeconds;
      return Number.isInteger(s) && (s as number) >= 1 ? (s as number) * 1000 : undefined;
    } catch {
      return undefined;
    }
  }

  function silenceMsFor(p: Project): number {
    return opts.boardWatch?.silenceMs ?? silenceFrom(liveEnv).silenceMs ?? savedSilenceMs(p) ?? BOARD_WATCH_TIMINGS.silenceMs;
  }

  function envSilenceSeconds(): number | null {
    const ms = silenceFrom(liveEnv).silenceMs;
    return ms === undefined ? null : Math.round(ms / 1000);
  }

  function boardFeed(p: Project): BoardFeed {
    const had = feeds.get(p.name);
    if (had) return had;
    const all = (text: string): void => { for (const c of feed.clients) c.write(text); };
    const tick = (why: string): void => {
      if (feed.busy) return;
      feed.busy = true;
      try {
        // A card's file counts come from the per-run git cache (boardView), so every read may ask for them.
        const t0 = performance.now();
        const board = boardView(contextFor(p));
        feed.running = board.running;
        feed.hasPr = board.runs.some(r => r.pullRequest);
        feed.builtAt = Date.now();
        const text = JSON.stringify(board);
        const changed = text !== feed.last;
        trace({ action: 'timer:board-rebuild', why, run: p.name, ms: Math.round((performance.now() - t0) * 1000) / 1000, changed, n: ++feed.ticks });
        if (changed) { feed.last = text; all(boardEvent(text)); trace({ action: 'sse:board', run: p.name, changed: true, n: feed.clients.size }); }
      } catch (e) {
        all(`event: problem\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`);
        trace({ action: 'sse:problem', run: p.name });
      } finally { feed.busy = false; }
    };
    // The board is rebuilt when a file it reads changes (board-watch.ts), not on a clock. Two things no file tells:
    // a run whose process died without a word, which is looked for whenever the watcher finds everything quiet
    // (`quiet`, once per silence period, and only with a run going); and a pull request's status. A pull request's
    // status is written to `pr-status.cache` in the folder of run records when GitHub answers, so the watcher
    // reports it; it is asked for again once an hour from `quiet`.
    const inputs = () => boardInputs(contextFor(p));
    const timings: BoardWatchTimings = {
      ...BOARD_WATCH_TIMINGS,
      ...opts.boardWatch,
      silenceMs: silenceMsFor(p),
    };
    const feed: BoardFeed = {
      clients: new Set(), last: '', ticks: 0, busy: false, running: 0, hasPr: false, builtAt: 0,
      timings,
      build: why => { feed.watch.baseline(); tick(why); },
      watch: createBoardWatch({
        folders: () => inputs().folders,
        fingerprint: () => fingerprintOf(inputs().files),
        ignore: (dir, file) => boardIgnores(dir, file, contextFor(p).root),
        rebuild: tick,
        quiet: () => {
          if (feed.running > 0) return feed.build('liveness');
          // A pull request is asked about again only when a board build finds its status old (once an hour). A board
          // that nothing changes is never built, so it is built here when that hour has passed.
          if (feed.hasPr && Date.now() - feed.builtAt >= (prPollOptions(env).ttlMs ?? PR_POLL_MS)) feed.build('pr-poll');
        },
        trace: e => trace({ ...e, run: p.name }),
      }, timings),
      ping: setInterval(() => { all('event: ping\ndata: {}\n\n'); trace({ action: 'sse:ping', run: p.name }); }, 15000),
    };
    feeds.set(p.name, feed);
    // The first page waits for nothing: the board is built as it joins (events() adds it before this runs).
    queueMicrotask(() => tick('join'));
    return feed;
  }

  /** Live updates: the board of a project whenever it changes, as SSE "board" events. */
  async function events(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const p = await project(url.searchParams.get('project') || '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const feed = boardFeed(p);
    // The text is what every page gets; no page holds the board object, so none can change it for the others.
    if (feed.last) res.write(boardEvent(feed.last));
    feed.clients.add(res);
    req.on('close', () => {
      feed.clients.delete(res);
      if (feed.clients.size || feeds.get(p.name) !== feed) return;
      clearInterval(feed.ping);
      feed.watch.close();
      feeds.delete(p.name);
    });
  }

  const runStreams = createRunStreams(opts.stream);

  /** Live updates of one run, as SSE: a snapshot, then "run" (live part), "tail" (output) and "ping" events. */
  async function runEvents(req: http.IncomingMessage, res: http.ServerResponse, projectName: string, slug: string): Promise<void> {
    const p = await project(projectName);
    let ctx = contextFor(p);
    const source = (): RunSource => ({
      refresh: () => { ctx = contextFor(p); },
      live: () => runView(ctx, slug, { cacheGit: true, parts: ['live', 'git'] }) as unknown as Record<string, unknown>,
      tail: () => runTail(ctx, slug),
      dirs: () => runPaths(ctx, slug).dirs,
      outFile: () => runPaths(ctx, slug).out,
    });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const leave = runStreams.join(`${p.name}/${slug}`, source, { send: (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } });
    req.on('close', leave);
  }

  const server = http.createServer((req, res) => {
    (async () => {
      guard(req, port);
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/') && url.pathname !== '/api/events' && !url.pathname.endsWith('/events')) {
        // One line per API request: the route with its project and slug named, the duration, and the status.
        const t0 = performance.now();
        const parts = url.pathname.split('/');
        const shape = parts.map((x, i) => (parts[i - 1] === 'projects' ? ':project' : parts[i - 1] === 'runs' || parts[i - 1] === 'items' ? ':slug' : x)).join('/');
        res.once('close', () => trace({ action: 'request', why: `${req.method} ${shape}`, run: parts[2] === 'projects' ? parts[4] === 'runs' ? parts[5] : undefined : undefined, ms: Math.round((performance.now() - t0) * 1000) / 1000, code: res.statusCode }));
      }
      // A request that may change a project (a start, a settings save, a palette command) drops its cached context,
      // before it is handled and again when it is answered, so the next read sees the change whatever its mtime.
      if (req.method !== 'GET' && url.pathname.startsWith('/api/projects/')) {
        const name = decodeURIComponent(url.pathname.split('/')[3] || '');
        dropContext(name);
        res.once('close', () => dropContext(name));
      }
      // The opening URL carries the token once: it becomes a cookie, and the address bar drops it.
      if (url.pathname === '/' && url.searchParams.has('t')) {
        const t = url.searchParams.get('t') || '';
        if (t !== token) throw new HttpError(401, 'wrong token: open the URL that ai-sdlc-helper ui printed');
        res.writeHead(302, { 'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
        return res.end();
      }
      if (env.SDLC_DEV === '1' && url.pathname === '/__dev/signin-url') {
        let signInUrl = '';
        try { signInUrl = fs.readFileSync(env.SDLC_UI_SIGNIN_FILE || '', 'utf8').trim(); } catch { /* server not ready */ }
        sendJson(res, signInUrl ? 200 : 503, { url: signInUrl });
        return;
      }
      if (env.SDLC_DEV === '1' && url.pathname === '/__dev/signin-tracker.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(DEV_SIGNIN_TRACKER);
        return;
      }
      if (!hasToken(req, token)) throw new HttpError(401, 'not signed in: open the URL that ai-sdlc-helper ui printed');
      if (url.pathname === '/api/events') return events(req, res, url);
      const runStream = /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (runStream && req.method === 'GET') return runEvents(req, res, decodeURIComponent(runStream[1]), slugOf(decodeURIComponent(runStream[2])));
      if (url.pathname.startsWith('/api/')) return api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'use GET');
      if (env.SDLC_DEV === '1' && url.pathname === '/') {
        const indexFile = path.join(uiDir, 'index.html');
        if (fs.existsSync(indexFile) && fs.statSync(indexFile).isFile()) {
          const html = fs.readFileSync(indexFile, 'utf8').replace('</body>', '<script src="/__dev/signin-tracker.js" defer></script></body>');
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
          });
          res.end(req.method === 'HEAD' ? '' : html);
          return;
        }
      }
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
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === 0 || opts.port !== undefined || attempt >= 20) throw e;
      port++;
    }
  }
  port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  await triage.recover();

  // A run whose supervisor was killed from outside leaves its record running: close it at start and every 30 s.
  const sweepGone = async (): Promise<void> => {
    for (const p of await projects()) {
      try { closeGoneRuns(contextFor(p)); } catch (e) { process.stderr.write(`WARNING: could not close the stopped runs of ${p.name}: ${(e as Error).message}\n`); }
    }
  };
  await sweepGone().catch(() => {});
  const goneTimer = setInterval(() => { void sweepGone().catch(() => {}); }, opts.goneSweepMs ?? 30_000);
  goneTimer.unref();

  // The PR statuses of every project's Completed list, asked a few seconds after the start (never awaited by it or by a
  // request), one project at a time, so the first list finds them cached. A list asked for meanwhile joins these calls.
  let closed = false;
  let warmTimer: NodeJS.Timeout | null = null;
  let warmDone: () => void = () => {};
  const warmed = new Promise<void>(r => { warmDone = r; });
  const warmAll = async (): Promise<void> => {
    for (const p of await projects()) {
      if (closed) return;
      let reg = '';
      try {
        if (!contextFresh(p)) await primeRepoPaths(p.path, env);
        const ctx = contextFor(p);
        reg = ctx.reg;
        const t0 = performance.now();
        const r = await warmCompletedPrs(ctx);
        trace({ action: 'warm:pr', why: 'skipped' in r ? r.skipped : 'asked', run: p.name, n: 'asked' in r ? r.asked : 0, ms: Math.round((performance.now() - t0) * 1000) / 1000 });
        if ('skipped' in r && r.skipped === 'no-gh') {
          const line = "gh is not installed: PR states on the Completed page can't be checked; install GitHub CLI and run gh auth login";
          keepError({ root: reg, log: '' }, `web server start: warm the PR statuses of ${p.name}`, line);
          process.stderr.write(`WARNING: ${line} (${p.name}; see ${path.join(reg, 'errors.log')})\n`);
        }
        if ('errors' in r && r.errors.length) {
          for (const m of r.errors) keepError({ root: reg, log: '' }, `web server start: warm the PR statuses of ${p.name}`, m);
          process.stderr.write(`WARNING: ${r.failed} PR status check(s) of ${p.name} failed at start-up (see ${path.join(reg, 'errors.log')})\n`);
        }
      } catch (e) {
        if (reg) keepError({ root: reg, log: '' }, `web server start: warm the PR statuses of ${p.name}`, (e as Error).stack || String(e));
        process.stderr.write(`WARNING: could not warm the PR statuses of ${p.name}: ${(e as Error).message}${reg ? ` (see ${path.join(reg, 'errors.log')})` : ''}\n`);
      }
    }
  };
  // Model prices, so rounds whose agent reports tokens but no cost show one (models/prices.ts); again every 6 hours.
  const warmPrices = (): void => {
    void loadOpencodePrices(env).catch(e => {
      process.stderr.write(`WARNING: could not read model prices from OpenCode; rounds without a reported cost show tokens only: ${(e as Error).message}\n`);
    });
  };
  warmPrices();
  const pricesTimer = setInterval(warmPrices, 6 * 3600_000);
  pricesTimer.unref();

  if (env.SDLC_WARM_PR_CACHE === '0') warmDone();
  else {
    warmTimer = setTimeout(() => { warmTimer = null; void warmAll().finally(warmDone); }, opts.warmPrDelayMs ?? 3000);
    warmTimer.unref();
  }

  return {
    prWarmup: () => warmed,
    url, port, token,
    openUrl: `${url}/?t=${token}`,
    streamStats: () => runStreams.stats(),
    close: () => new Promise(res => { closed = true; clearInterval(goneTimer); clearInterval(pricesTimer); if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; warmDone(); } for (const f of feeds.values()) { clearInterval(f.ping); f.watch.close(); } feeds.clear(); runStreams.closeAll(); tracer.close(); stopTrace(); triage.close(); server.closeAllConnections?.(); server.close(() => res()); }),
  };
}
