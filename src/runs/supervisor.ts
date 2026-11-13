// The supervisor: a small detached Node process per run that outlives the command that started it. It runs the suites'
// setup commands (once per new worktree), then the pipeline, with both writing to run.out; on SIGTERM it stops the
// pipeline and everything it started; when the pipeline ends it writes the final run record. It is plain JavaScript run
// with `node -e`, so it works the same from src/ (tests) and dist/ and needs no file of its own.
//
// Windows: setup commands run with the shell of shellArgv (Git's sh.exe, else cmd.exe), and stopping uses
// `taskkill /T /F`, which ends the pipeline and its children at once (there is no ps to walk the tree).
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { RunRecord } from './records.js';

/** A suite's setup command; argv is how it starts (shell.ts shellArgv: sh -c, or a Windows shell). */
export interface SetupStep { name: string; dir: string; cmd: string; argv: string[] }

export interface Job {
  slug: string;
  /** The record file, the stop marker and the supervisor's own log. */
  recordFile: string;
  interruptFile: string;
  logFile: string;
  /** The pipeline's output, appended to. */
  outFile: string;
  cwd: string;
  /** The pipeline command: program and arguments. */
  argv: string[];
  setup: SetupStep[];
  /** Deleted once every setup step passed, so a failed setup runs again on the next start. */
  setupMarker: string;
  record: RunRecord;
  /** The branch prefix (sdlc/): a moved run's branch is <prefix><slug>_<n>. */
  prefix: string;
}

const SOURCE = String.raw`
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const job = JSON.parse(process.argv[1]);
const p = n => String(n).padStart(2, '0');
const now = (d = new Date()) => d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
const log = t => { try { fs.appendFileSync(job.logFile, t + '\n'); } catch (e) { /* no log */ } };
const out = fs.openSync(job.outFile, 'a');
let child = null;
let stopping = false;
let done = false;

function finish(rc, message) {
  if (done) return;
  done = true;
  // The starting command writes the running record right after the spawn; never overwrite the final record with it.
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    try { if (JSON.parse(fs.readFileSync(job.recordFile, 'utf8')).pid === process.pid) break; } catch (e) { /* not yet */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  // The pipeline may have moved the run to a new branch; record the one the worktree is on now.
  let branch = job.record.branch;
  try {
    const r = spawnSync('git', ['-C', job.record.worktree, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8' });
    const b = String(r.stdout || '').trim();
    const own = job.prefix + job.slug;
    if (r.status === 0 && (b === own || (b.startsWith(own + '_') && /^[1-9][0-9]*$/.test(b.slice(own.length + 1)) && Number(b.slice(own.length + 1)) >= 2))) branch = b;
  } catch (e) { /* keep the old one */ }
  const rec = Object.assign({}, job.record, branch ? { branch } : {}, {
    pid: process.pid, state: 'exited', exit_code: String(rc), interrupted: fs.existsSync(job.interruptFile), finished: now(), message: message || '',
  });
  const tmp = job.recordFile + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(rec) + '\n'); fs.renameSync(tmp, job.recordFile); } catch (e) { log('cannot write the run record: ' + e.message); }
  log('== ' + now() + ' finished ' + job.slug + ' exit ' + rc);
  process.exit(rc);
}

// The pipeline and every process below it (agents, test runs), from one ps listing.
function tree(pid) {
  const all = [pid];
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const kids = new Map();
  for (const line of String(r.stdout || '').split('\n')) {
    const [a, b] = line.trim().split(/\s+/).map(Number);
    if (a && b) kids.set(b, (kids.get(b) || []).concat(a));
  }
  for (let i = 0; i < all.length; i++) for (const c of kids.get(all[i]) || []) if (!all.includes(c)) all.push(c);
  return all;
}

function stop() {
  stopping = true;
  if (child && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); return; }
    for (const pid of tree(child.pid)) { try { process.kill(pid, 'SIGTERM'); } catch (e) { /* gone */ } }
  }
}
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, stop);

const codeOf = (code, signal) => (code !== null ? code : 128 + ((signal && os.constants.signals[signal]) || 0));

function runStep(argv, opts) {
  return new Promise(resolve => {
    const verbatim = process.platform === 'win32' && /^(?:.*\\)?cmd(?:\.exe)?$/i.test(argv[0]);
    child = spawn(argv[0], argv.slice(1), Object.assign({ stdio: ['ignore', out, out], windowsVerbatimArguments: verbatim, windowsHide: true }, opts));
    child.on('error', e => resolve({ code: 127, error: e.message }));
    child.on('exit', (code, signal) => resolve({ code: codeOf(code, signal) }));
  });
}

(async () => {
  for (const s of job.setup) {
    if (stopping) return finish(130, 'stopped during setup');
    fs.writeSync(out, '== ' + now() + ' setup ' + s.name + ' (' + s.dir + '): ' + s.cmd + '\n');
    const r = await runStep(s.argv, { cwd: s.dir });
    if (r.code !== 0) return finish(r.code, 'setup of suite ' + s.name + ' failed (exit ' + r.code + '): ' + s.cmd + (r.error ? ' (' + r.error + ')' : '') + '; see run.out');
  }
  if (job.setup.length) { try { fs.unlinkSync(job.setupMarker); } catch (e) { /* gone */ } }
  if (stopping) return finish(130, '');
  const r = await runStep(job.argv, { cwd: job.cwd });
  finish(r.code, r.error ? 'could not start the pipeline: ' + r.error : '');
})();
`;

/** Starts the supervisor for <job>, detached from this process; returns its pid. <env> is what the pipeline gets. */
export function startSupervisor(job: Job, env: NodeJS.ProcessEnv): number {
  const log = fs.openSync(job.logFile, 'a');
  try {
    const child = spawn(process.execPath, ['-e', SOURCE, JSON.stringify(job)], {
      cwd: job.cwd, env, detached: true, stdio: ['ignore', log, log], windowsHide: true,
    });
    if (!child.pid) throw new Error('the supervisor did not start');
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}
