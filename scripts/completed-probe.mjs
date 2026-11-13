#!/usr/bin/env node
// Measures the Completed list endpoint (GET /api/projects/<p>/completed): its time and the gh calls it makes, on a
// seeded project with many completed tasks and a fake gh that answers after a fixed delay (default 850 ms, what a live
// `gh pr view` took against this repository). Scenarios, each run <runs> times on the same seeded state:
//   cold     a new server, no pr-status.cache: nothing is known about any PR
//   warm     the same server again, the cache fresh
//   restart  a new server, pr-status.cache from the cold run present (what a restart of `ai-sdlc-helper ui` finds)
//   expired  a server whose poll time (SDLC_PR_POLL_MS) has passed since the statuses were read
// For each request: the endpoint time seen by the client, the gh calls started while it was open, and the gh calls it
// set off in total (counted once nothing more starts). Server-side phases come from the trace (action "completed").
// Usage: npm run build (or tsc of src and web/server), then
//   node scripts/completed-probe.mjs [--root <checkout with dist/>] [--tasks 120] [--runs 5] [--gh-ms 850]
//                                    [--worktrees <n>] [--cpu-prof <dir>] [--json <file>]
//   --worktrees <n>: n merged tasks ran in worktrees of their own and linked their PR in the main checkout's brief
//   (uncommitted there), so each load also finds briefs to clean (cleanMergedRunBrief).
//   --serve <port>: no measuring; serves the seeded project with the built UI (dist/web/ui) for a browser, prints the
//   sign-in URL, and starts a new server on fresh files (nothing known: a cold load) whenever the file it names is
//   touched. Stops at Ctrl-C.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const root = path.resolve(opt('root', path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
const TASKS = Number(opt('tasks', 120));
const RUNS = Number(opt('runs', 5));
const GH_MS = Number(opt('gh-ms', 850));
const cpuProf = opt('cpu-prof', '');
const jsonOut = opt('json', '');
const servePort = Number(opt('serve', 0));
const WORKTREES = Number(opt('worktrees', 0));
const serverJs = path.join(root, 'dist', 'web', 'server', 'index.js');
if (!fs.existsSync(serverJs)) { console.error(`${serverJs} is missing: build first`); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); };

// The fake gh: logs each call's start and end, waits GH_MS, answers `pr view <url|branch>` and `pr list` from prs.json.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const dir = process.env.FAKE_GH_DIR; const a = process.argv.slice(2);
const log = l => fs.appendFileSync(path.join(dir, 'gh-calls.txt'), l + '\\n');
const id = process.pid + ' ' + a.slice(0, 3).join(' ');
log('start ' + id);
const prs = JSON.parse(fs.readFileSync(path.join(dir, 'prs.json'), 'utf8'));
const full = p => ({ url: p.url, state: p.state, number: p.number, isDraft: false, headRefOid: 'a'.repeat(40), mergeable: p.state === 'OPEN' ? 'MERGEABLE' : 'UNKNOWN', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], headRefName: p.branch });
const mode = process.env.FAKE_GH_MODE || 'ok';
setTimeout(() => {
  let code = 0;
  if (mode === 'fail') { process.stderr.write('HTTP 502: Bad Gateway (https://api.github.com/graphql)\\n'); code = 1; }
  else if (a[0] === 'pr' && a[1] === 'view') {
    const p = prs.find(x => x.url === a[2] || x.branch === a[2]);
    if (p) process.stdout.write(JSON.stringify(full(p)) + '\\n');
    else { process.stderr.write('no pull requests found for branch "' + a[2] + '"\\n'); code = 1; }
  } else if (a[0] === 'pr' && a[1] === 'list') process.stdout.write(JSON.stringify(prs.map(full)) + '\\n');
  else { process.stderr.write('fake gh: unknown command ' + a.join(' ') + '\\n'); code = 1; }
  log('end ' + id);
  process.exit(code);
}, mode === 'slow' ? 10000 : Number(process.env.FAKE_GH_MS || 0));
`;

/** A project with TASKS completed tasks: 1 in 20 without a PR, 1 in 20 with an open PR, the rest merged; half have a run record. */
function seedTemplate(dir) {
  const repo = path.join(dir, 'shop');
  fs.mkdirSync(path.join(repo, 'Docs/backlog'), { recursive: true });
  const prs = [];
  const lines = [];
  for (let i = 1; i <= TASKS; i++) {
    const slug = `task-${String(i).padStart(3, '0')}`;
    lines.push(`- [x] \`${slug}\` - Feature: Task number ${i}`);
    fs.mkdirSync(path.join(repo, 'Docs/backlog', slug));
    let brief = `# Task number ${i}\n\nType: feature\nPriority: P2\n`;
    if (i % 20 !== 0) {
      const url = `https://github.com/o/shop/pull/${i}`;
      prs.push({ url, number: i, state: i % 20 === 1 ? 'OPEN' : 'MERGED', branch: `sdlc/${slug}` });
      brief = `---\npr: ${url}\n---\n\n${brief}`;
    }
    fs.writeFileSync(path.join(repo, 'Docs/backlog', slug, 'brief.md'), brief);
  }
  fs.writeFileSync(path.join(repo, 'Docs/backlog/index.md'), `# Backlog\n\n${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } }));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const reg = path.join(repo, '.git', 'sdlc-runs');
  fs.mkdirSync(reg, { recursive: true });
  for (let i = 1; i <= TASKS; i += 2) {
    const slug = `task-${String(i).padStart(3, '0')}`;
    const d = `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T10:${String(i % 60).padStart(2, '0')}:00`;
    fs.writeFileSync(path.join(reg, `${slug}.json`), JSON.stringify({ slug, worktree: '', pid: 0, started: d, state: 'exited', exit_code: '0', interrupted: false, finished: d, message: '', branch: `sdlc/${slug}`, base: 'main' }));
  }
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '<!doctype html><title>app</title>');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'prs.json'), JSON.stringify(prs));
}

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'completed-probe-')));
const template = path.join(base, 'template');
fs.mkdirSync(template);
seedTemplate(template);
let workN = 0;
/** A fresh copy of the seeded state, so every cold run starts from the same files. */
function freshCopy() {
  const d = path.join(base, `w${++workN}`);
  fs.cpSync(template, d, { recursive: true });
  fs.writeFileSync(path.join(d, 'gh-calls.txt'), '');
  if (WORKTREES) addWorktrees(d);
  return d;
}

/** <WORKTREES> merged tasks with a record get a worktree; their main-checkout brief holds the link uncommitted. */
function addWorktrees(d) {
  const repo = path.join(d, 'shop');
  const reg = path.join(repo, '.git', 'sdlc-runs');
  const picked = [];
  for (let i = 3; i <= TASKS && picked.length < WORKTREES; i += 2) if (i % 20 !== 0 && i % 20 !== 1) picked.push(i);
  for (const i of picked) {
    const slug = `task-${String(i).padStart(3, '0')}`;
    const wt = path.join(d, 'wt', slug);
    git(repo, 'worktree', 'add', '-q', '--detach', wt);
    const f = path.join(reg, `${slug}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), worktree: wt, root: repo }));
    const b = path.join(repo, 'Docs/backlog', slug, 'brief.md');
    fs.writeFileSync(`${b}.linked`, fs.readFileSync(b));
    fs.writeFileSync(b, fs.readFileSync(b, 'utf8').replace(/^---\npr: .*\n---\n\n/, ''));
  }
  git(repo, 'commit', '-q', '-am', 'briefs without their links');
  for (const i of picked) {
    const b = path.join(repo, 'Docs/backlog', `task-${String(i).padStart(3, '0')}`, 'brief.md');
    fs.renameSync(`${b}.linked`, b);
  }
}

const calls = dir => fs.readFileSync(path.join(dir, 'gh-calls.txt'), 'utf8').split('\n').filter(l => l.startsWith('start ')).length;
const running = dir => { const t = fs.readFileSync(path.join(dir, 'gh-calls.txt'), 'utf8').split('\n'); return t.filter(l => l.startsWith('start ')).length - t.filter(l => l.startsWith('end ')).length; };
/** Waits until no gh call is running and none started for 400 ms. */
async function settle(dir) {
  let last = -1; let quietSince = performance.now();
  for (;;) {
    const n = calls(dir);
    if (n !== last || running(dir) > 0) { last = n; quietSince = performance.now(); }
    if (performance.now() - quietSince > 400) return n;
    await sleep(50);
  }
}

const CHILD = `
import { startServer } from ${JSON.stringify(serverJs)};
const o = JSON.parse(process.argv[1]);
const s = await startServer({ port: o.port || 0, token: o.token, env: process.env, cwd: o.repo, uiDir: o.ui, traceFlushMs: 50, cli: ['/bin/sh', '-c', 'exit 3', 'sh'] });
process.stdout.write(JSON.stringify({ port: s.port, token: s.token }) + '\\n');
process.stdin.on('data', () => {}); process.stdin.on('end', async () => { await s.close(); process.exit(0); });
`;

async function startChild(dir, extraEnv = {}, tag = '', serve = null) {
  const env = { ...process.env, ...GIT_ENV, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, AI_SDLC_HELPER_CONFIG_DIR: path.join(dir, 'config'), FAKE_GH_DIR: dir, FAKE_GH_MS: String(GH_MS), ...extraEnv };
  const flags = cpuProf ? ['--cpu-prof', `--cpu-prof-dir=${path.resolve(cpuProf)}`, `--cpu-prof-name=completed-${tag}-${workN}.cpuprofile`] : [];
  const child = spawn(process.execPath, [...flags, '--input-type=module', '-e', CHILD, JSON.stringify({ repo: path.join(dir, 'shop'), ui: serve ? path.join(root, 'dist', 'web', 'ui') : path.join(dir, 'ui'), ...(serve || {}) })], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const info = await new Promise((res, rej) => {
    let out = '';
    child.stdout.on('data', c => { out += c; const nl = out.indexOf('\n'); if (nl >= 0) res(JSON.parse(out.slice(0, nl))); });
    child.once('exit', code => rej(new Error(`server exited ${code}`)));
  });
  return { ...info, dir, stop: () => new Promise(r => { child.once('exit', r); child.stdin.end(); }) };
}

const get = (s, p) => new Promise((res, rej) => {
  const t0 = performance.now();
  http.get({ host: '127.0.0.1', port: s.port, path: p, headers: { 'x-sdlc-token': s.token } }, r => {
    let body = '';
    r.on('data', c => { body += c; });
    r.on('end', () => res({ status: r.statusCode || 0, ms: performance.now() - t0, body }));
  }).on('error', rej);
});

/** One timed load: the client's time, gh calls started while it was open, and the total it set off. */
async function load(s) {
  const before = calls(s.dir);
  const r = await get(s, '/api/projects/shop/completed');
  const during = calls(s.dir) - before;
  const total = (await settle(s.dir)) - before;
  if (r.status !== 200) throw new Error(`completed answered ${r.status}: ${r.body.slice(0, 300)}`);
  const body = JSON.parse(r.body);
  return { ms: r.ms, during, total, rows: body.completed.length, body };
}

/** The server's own "completed" trace events (phase spans), when the build writes them. */
function phases(dir) {
  const f = path.join(dir, 'config', 'ui-trace.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.action === 'completed');
}

if (servePort) {
  const control = path.join(base, 'cold');
  const token = 'probe';
  let s = await startChild(freshCopy(), {}, 'serve', { port: servePort, token });
  console.log(`http://127.0.0.1:${servePort}/?t=${token}  (touch ${control} for a cold server)`);
  let seen = 0;
  for (;;) {
    await sleep(200);
    const m = fs.existsSync(control) ? fs.statSync(control).mtimeMs : 0;
    if (m && m !== seen) { seen = m; await s.stop(); s = await startChild(freshCopy(), {}, 'serve', { port: servePort, token }); console.log('cold server ready'); fs.writeFileSync(`${control}.ready`, String(m)); }
  }
}

const results = { cold: [], warm: [], restart: [], expired: [] };
let sample = null;
for (let i = 0; i < RUNS; i++) {
  const dir = freshCopy();
  const s = await startChild(dir, {}, 'cold');
  const c = await load(s);
  results.cold.push({ ...c, phases: phases(dir).slice(-1)[0] });
  sample = sample || c.body;
  const w = await load(s);
  results.warm.push({ ...w, phases: phases(dir).slice(-1)[0] });
  await s.stop();
  // A restart: the same files, the cache file written by the run above.
  const r = await startChild(dir, {}, 'restart');
  const rr = await load(r);
  results.restart.push({ ...rr, phases: phases(dir).slice(-1)[0] });
  await r.stop();
}
for (let i = 0; i < RUNS; i++) {
  const dir = freshCopy();
  const POLL = 3000;
  const s = await startChild(dir, { SDLC_PR_POLL_MS: String(POLL) }, 'expired');
  await load(s);
  await sleep(POLL + 200);
  const e = await load(s);
  results.expired.push({ ...e, phases: phases(dir).slice(-1)[0] });
  await s.stop();
}

const stat = xs => { const s = [...xs].sort((a, b) => a - b); return { median: s[Math.floor((s.length - 1) / 2)], worst: s[s.length - 1] }; };
const rows = Object.entries(results).map(([name, rs]) => {
  const ms = stat(rs.map(r => r.ms));
  return { scenario: name, runs: rs.length, rows: rs[0]?.rows, medianMs: Math.round(ms.median), worstMs: Math.round(ms.worst), ghDuringMedian: stat(rs.map(r => r.during)).median, ghTotalMedian: stat(rs.map(r => r.total)).median, ghTotalWorst: stat(rs.map(r => r.total)).worst };
});
console.log(`Completed endpoint, ${TASKS} completed tasks${WORKTREES ? ` (${WORKTREES} merged in worktrees, briefs to clean)` : ''}, fake gh ${GH_MS} ms per call, ${RUNS} runs each (${root})`);
console.table(rows);
const ph = results.cold.map(r => r.phases).filter(Boolean);
if (ph.length) console.log('cold phases (last run):', JSON.stringify(ph[ph.length - 1]));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ tasks: TASKS, ghMs: GH_MS, rows, sample, results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.map(({ body: _body, ...rest }) => rest)])) }, null, 1));
fs.rmSync(base, { recursive: true, force: true });
