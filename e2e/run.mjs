#!/usr/bin/env node
/* global process, console, setTimeout, clearTimeout */
// End-to-end checks: the built command (dist/bin.js) runs the whole pipeline on small sample projects (e2e/projects),
// with a recorded stand-in for `claude` (e2e/claude-stub) on PATH. Each case copies a project to a temporary folder,
// makes it a git repository, installs its devDependencies and drives the real CLI: doctor, detect, then the pipeline
// (in the foreground, or through start / watch --follow / status), and checks the outcome.
//
//   node e2e/run.mjs [case ...]      (npm run e2e builds first)
//   E2E_KEEP=1                       keep the temporary folder (it is always kept when a case fails)
//   E2E_JOBS=<n>                     cases run at once, each in its own process (default 3)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const E2E = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(E2E);
const BIN = path.join(REPO, 'dist', 'bin.js');
const STUB = path.join(E2E, 'claude-stub', 'claude.mjs');
const MINUTE = 60 * 1000;

/**
 * Cases known to be blocked by a bug in src/ (reported, not fixed here): case name -> reason. A skipped case is
 * reported as such and does not fail the run.
 */
const SKIP = {};

/** The sample projects: the backlog item, the files the cycle adds, and what detection should find. */
const PROJECTS = {
  'jest-cjs': { slug: 'add-discount', detect: 'jest', runner: 'jest', test: '__tests__/discount.test.js', source: 'src/discount.js' },
  'vitest-ts': { slug: 'add-item-count', detect: 'vitest', runner: 'vitest', test: 'test/count.test.ts', source: 'src/count.ts' },
  mocha: { slug: 'add-truncate', detect: 'mocha', runner: 'mocha', test: 'test/truncate.test.js', source: 'src/truncate.js' },
  // Detection sees `node --test`; sdlc.config.json makes it a generic-junit suite that reads junit.xml.
  'junit-node-test': { slug: 'add-kelvin', detect: 'node-test', runner: 'generic-junit', test: 'test/kelvin.test.mjs', source: 'src/temperature.mjs' },
};

const CASES = [
  { name: 'jest-cjs', project: 'jest-cjs', mode: 'foreground', covers: 'Node + Jest (CommonJS), pipeline in the foreground' },
  { name: 'vitest-ts', project: 'vitest-ts', mode: 'controls', covers: 'TypeScript + Vitest (ESM), start + watch --follow + status in a worktree' },
  { name: 'mocha', project: 'mocha', mode: 'foreground', covers: 'Node + Mocha (ESM), pipeline in the foreground' },
  { name: 'junit-node-test', project: 'junit-node-test', mode: 'foreground', covers: 'generic-junit (node:test JUnit report) via sdlc.config.json' },
  { name: 'jest-cjs-paused', project: 'jest-cjs', mode: 'paused', covers: 'Spec questions: exit 2, answer, rerun to done' },
];

// ---------------------------------------------------------------------------------------------------------------- helpers

class CheckError extends Error {}
const check = (ok, message) => { if (!ok) throw new CheckError(message); };
const tail = (s, n = 25) => String(s || '').trimEnd().split('\n').slice(-n).join('\n');
const seconds = ms => `${(ms / 1000).toFixed(1)}s`;

function run(cmd, args, { cwd, env, timeout = 5 * MINUTE, input } = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout, input, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status === null ? (r.error ? 127 : 1) : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : ''), ms: Date.now() - t0 };
}

function git(cwd, ...args) {
  const r = run('git', args, { cwd });
  if (r.status !== 0) throw new CheckError(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The environment of every command: nothing from the caller that steers a run, the stand-in first on PATH. */
function baseEnv(tmp, bin) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(SDLC_|MODEL_|EFFORT_|ANTHROPIC_|AI_SDLC_HELPER_|MAX_|E2E_|CLAUDE_|GIT_|npm_)/.test(k) && !['FROM', 'NODE_OPTIONS'].includes(k)));
  const gitConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n\tname = e2e\n\temail = e2e@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n'
    + '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');
  return {
    ...env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    // The user's own settings stay out: the tool's config folder, the model registry, git's global configuration.
    AI_SDLC_HELPER_CONFIG_DIR: path.join(tmp, 'config'),
    AI_SDLC_HELPER_MODELS_FILE: path.join(tmp, 'config', 'no-models.json'),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
}

/** The stand-in as `claude`: a shell script that runs claude.mjs with this Node. */
function installStub(bin) {
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} "$@"\n`, { mode: 0o755 });
}

/** The folder of <project>'s files with its devDependencies installed (made once, before the cases run). */
const templateDir = (tmp, project) => path.join(tmp, 'templates', project);

/** Installs <project>'s devDependencies in its template folder; resolves the milliseconds it took. */
async function makeTemplate(tmp, project, env) {
  const dir = templateDir(tmp, project);
  fs.cpSync(path.join(E2E, 'projects', project), dir, { recursive: true });
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg.devDependencies || !Object.keys(pkg.devDependencies).length) return 0;
  const r = await runAsync('npm', ['install', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, env, timeout: 5 * MINUTE });
  if (r.status !== 0) throw new CheckError(`npm install in ${project} failed (exit ${r.status}):\n${tail(r.stderr || r.stdout)}`);
  return r.ms;
}

/** A fresh git repository of <project> at <dir>: its files committed on main, node_modules copied in (git-ignored). */
function makeRepo(tmplDir, project, dir, env) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(path.join(E2E, 'projects', project), dir, { recursive: true });
  const g = (...args) => { const r = run('git', args, { cwd: dir, env }); if (r.status !== 0) throw new CheckError(`git ${args.join(' ')}: ${r.stderr}`); };
  g('init', '-q', '-b', 'main');
  // No background maintenance or gc: they create and delete files in .git while the run works in it.
  g('config', 'maintenance.auto', 'false');
  g('config', 'gc.auto', '0');
  g('config', 'core.hooksPath', '/dev/null');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const modules = path.join(tmplDir, 'node_modules');
  // verbatimSymlinks keeps node_modules/.bin links relative, so they point into this copy.
  if (fs.existsSync(modules)) fs.cpSync(modules, path.join(dir, 'node_modules'), { recursive: true, verbatimSymlinks: true });
}

/** Runs the built command. */
const cli = (args, opts) => run(process.execPath, [BIN, ...args], opts);

/** The calls the stand-in logged: [{ stage, source, written }]. */
const stubCalls = file => read(file).split('\n').filter(Boolean).map(l => JSON.parse(l));

/** Runs <cmd> without blocking and resolves when it ends (it is killed after <timeout>). */
function runAsync(cmd, args, { cwd, env, timeout = 5 * MINUTE }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { stderr += `\n(killed after ${seconds(timeout)})`; child.kill('SIGKILL'); }, timeout);
    child.on('error', e => { stderr += e.message; });
    child.on('close', code => { clearTimeout(timer); resolve({ status: code === null ? 1 : code, stdout, stderr, ms: Date.now() - t0 }); });
  });
}
const cliAsync = (args, opts) => runAsync(process.execPath, [BIN, ...args], opts);

// ----------------------------------------------------------------------------------------------------------------- checks

function checkDoctorAndDetect(c, dir, env, steps, save) {
  const p = PROJECTS[c.project];
  const doctor = save('doctor', cli(['doctor', dir, '--run-tests'], { cwd: dir, env }));
  steps.push(`doctor ${seconds(doctor.ms)}`);
  check(doctor.status === 0, `doctor --run-tests exited ${doctor.status}:\n${tail(doctor.stdout + doctor.stderr)}`);
  const detect = save('detect', cli(['detect', dir, '--json'], { cwd: dir, env }));
  check(detect.status === 0, `detect exited ${detect.status}:\n${tail(detect.stdout + detect.stderr)}`);
  const found = JSON.parse(detect.stdout);
  check(found.length === 1 && found[0].runner === p.detect, `detect found ${JSON.stringify(found.map(f => f.runner))}, expected ["${p.detect}"]`);
  const show = cli(['show', dir], { cwd: dir, env });
  check(show.status === 0, `show exited ${show.status}:\n${tail(show.stderr)}`);
  const config = JSON.parse(show.stdout);
  check(config.suites.length === 1 && config.suites[0].runner === p.runner, `show: suites ${JSON.stringify(config.suites.map(s => s.runner))}, expected ["${p.runner}"]`);
}

/** A run that shipped: status done, the three commits in order, the backlog ticked, tests green, ship-skipped.md. */
function checkShipped(c, dir, env, stubLog, output) {
  const p = PROJECTS[c.project];
  const docs = `Docs/backlog/${p.slug}`;
  const status = readJson(path.join(dir, docs, 'logs', 'status.json'));
  check(status.state === 'done', `status.json state is ${status.state}, expected done (stage ${status.stage})`);
  check(status.slug === p.slug, `status.json slug is ${status.slug}`);
  check(/DONE: /.test(output), 'the run did not print DONE');

  const branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  check(branch === `sdlc/${p.slug}`, `on branch ${branch}, expected sdlc/${p.slug}`);
  const subjects = git(dir, 'log', '--reverse', '--format=%s', 'main..HEAD').split('\n').filter(Boolean);
  const expected = [`test(${p.slug}): add failing tests and spec/plan docs`, `feat(${p.slug}): implement per ${docs}/specs-1.md`, `chore(backlog): mark ${p.slug} done`];
  check(JSON.stringify(subjects) === JSON.stringify(expected), `commits on the branch (oldest first):\n  ${subjects.join('\n  ')}\nexpected:\n  ${expected.join('\n  ')}`);

  const filesOf = ref => git(dir, 'show', '--name-only', '--format=', ref).split('\n').filter(Boolean);
  const [red, feat, tick] = git(dir, 'log', '--reverse', '--format=%H', 'main..HEAD').split('\n');
  const redFiles = filesOf(red);
  for (const f of [p.test, `${docs}/specs-1.md`, `${docs}/plan-1.md`, `${docs}/test-cases-1.md`]) check(redFiles.includes(f), `the Red tests commit lacks ${f} (has ${redFiles.join(', ')})`);
  check(!redFiles.includes(p.source), `the Red tests commit already has the implementation ${p.source}`);
  check(!redFiles.some(f => f.includes('/logs/')), `the Red tests commit has run logs: ${redFiles.filter(f => f.includes('/logs/')).join(', ')}`);
  const featFiles = filesOf(feat);
  for (const f of [p.source, `${docs}/review-1.md`]) check(featFiles.includes(f), `the feat commit lacks ${f} (has ${featFiles.join(', ')})`);
  check(!featFiles.includes(p.test), 'the feat commit changes the locked test file');
  check(!featFiles.some(f => f.startsWith('node_modules')), 'the feat commit has node_modules');
  check(JSON.stringify(filesOf(tick)) === JSON.stringify(['Docs/backlog/index.md']), `the backlog commit has ${filesOf(tick).join(', ')}`);
  check(read(path.join(dir, 'Docs/backlog/index.md')).includes(`- [x] \`${p.slug}\``), 'the backlog item is not ticked');
  const dirty = git(dir, 'status', '--porcelain');
  check(dirty === '', `files left uncommitted after Ship:\n${dirty}`);

  check(fs.existsSync(path.join(dir, docs, 'logs', 'finalise-skipped.md')), `${docs}/logs/finalise-skipped.md is missing`);
  const red_ = path.join(dir, docs, 'logs', 'red.json');
  check(fs.existsSync(red_) && readJson(red_).ok === false, 'logs/red.json does not record failing tests at the Red tests commit');

  // The project's own test command passes at the end, and failed at the Red tests commit.
  const test = run('npm', ['test', '--silent'], { cwd: dir, env });
  check(test.status === 0, `npm test fails after the run (exit ${test.status}):\n${tail(test.stdout + test.stderr)}`);

  const stages = stubCalls(stubLog).map(x => x.stage);
  const want = c.mode === 'paused' ? ['spec', 'spec', 'plan', 'red-tests', 'implement', 'review'] : ['spec', 'plan', 'red-tests', 'implement', 'review'];
  check(JSON.stringify(stages) === JSON.stringify(want), `the stand-in ran ${stages.join(', ')}; expected ${want.join(', ')}`);
}

// ------------------------------------------------------------------------------------------------------------------ cases

async function runCase(c, tmp, env) {
  const p = PROJECTS[c.project];
  const caseDir = path.join(tmp, 'cases', c.name);
  const repo = path.join(caseDir, c.project);
  const stubLog = path.join(caseDir, 'stub.jsonl');
  makeRepo(templateDir(tmp, c.project), c.project, repo, env);
  const caseEnv = { ...env, E2E_RECORDING: path.join(E2E, 'recordings', c.project), E2E_STUB_LOG: stubLog };
  const steps = [];
  // Every command's output, for a look after a failure (E2E_KEEP=1 keeps them after a pass too).
  let n = 0;
  const save = (name, r) => { fs.writeFileSync(path.join(caseDir, `${String(++n).padStart(2, '0')}-${name}.out`), `exit ${r.status}\n${r.stdout}${r.stderr}`); return r; };

  checkDoctorAndDetect(c, repo, caseEnv, steps, save);

  if (c.mode === 'foreground') {
    const r = save('pipeline', cli(['pipeline', p.slug], { cwd: repo, env: caseEnv, timeout: 8 * MINUTE }));
    steps.push(`pipeline ${seconds(r.ms)}`);
    check(r.status === 0, `pipeline exited ${r.status}:\n${tail(r.stdout + r.stderr, 40)}`);
    checkShipped(c, repo, caseEnv, stubLog, r.stdout);
  } else if (c.mode === 'paused') {
    const qEnv = { ...caseEnv, E2E_SPEC_QUESTIONS: '1' };
    const docs = path.join(repo, 'Docs/backlog', p.slug);
    const first = save('pipeline-paused', cli(['pipeline', p.slug], { cwd: repo, env: qEnv }));
    steps.push(`pipeline (paused) ${seconds(first.ms)}`);
    check(first.status === 2, `the first run exited ${first.status}, expected 2 (paused):\n${tail(first.stdout + first.stderr)}`);
    check(readJson(path.join(docs, 'logs', 'status.json')).state === 'paused', 'status.json is not paused after the Spec questions');
    const questions = path.join(docs, 'questions.md');
    check(fs.existsSync(questions), 'questions.md is missing after the pause');
    check(!fs.existsSync(path.join(docs, 'specs-1.md')), 'specs-1.md was written although Spec asked questions');
    // A rerun with questions left unanswered pauses again, without running an agent.
    const again = save('pipeline-unanswered', cli(['pipeline', p.slug], { cwd: repo, env: qEnv }));
    check(again.status === 2 && /0\/2 questions answered/.test(again.stdout + again.stderr), `a rerun with no answers exited ${again.status}:\n${tail(again.stdout + again.stderr)}`);
    check(stubCalls(stubLog).length === 1, 'a rerun with unanswered questions ran an agent');
    // The developer answers: accept the suggestion for Q1, their own text for Q2.
    let n = 0;
    fs.writeFileSync(questions, read(questions).replace(/^\*\*Answer:\*\*\s*$/gm, () => (++n === 1 ? '**Answer:** accept' : '**Answer:** Throw a RangeError naming the percent.')));
    const second = save('pipeline-answered', cli(['pipeline', p.slug], { cwd: repo, env: qEnv, timeout: 8 * MINUTE }));
    steps.push(`pipeline (resumed) ${seconds(second.ms)}`);
    check(second.status === 0, `the answered run exited ${second.status}:\n${tail(second.stdout + second.stderr, 40)}`);
    check(!fs.existsSync(questions), 'questions.md is still there after the answers were recorded');
    const decisions = read(path.join(docs, 'decisions.md'));
    check(/^## Round 1 /m.test(decisions) && decisions.includes('**Answer:** accept') && decisions.includes('naming the percent'), `decisions.md does not hold the answers:\n${decisions}`);
    check(git(repo, 'show', '--name-only', '--format=', 'HEAD~2').split('\n').includes(`Docs/backlog/${p.slug}/decisions.md`), 'decisions.md is not in the Red tests commit');
    checkShipped(c, repo, caseEnv, stubLog, second.stdout);
  } else { // controls: start in a worktree, follow it, read the status
    const s = save('start', cli(['start', p.slug], { cwd: repo, env: caseEnv }));
    check(s.status === 0, `start exited ${s.status}:\n${tail(s.stdout + s.stderr)}`);
    // watch refreshes while the pipeline commits: its status reads must not take index.lock (git --no-optional-locks).
    const w = save('watch-follow', await cliAsync(['watch', p.slug, '--follow', '1'], { cwd: repo, env: caseEnv, timeout: 8 * MINUTE }));
    steps.push(`start + watch --follow ${seconds(w.ms)}`);
    check(w.status === 0, `watch --follow exited ${w.status}:\n${tail(w.stdout + w.stderr)}`);
    const frames = w.stdout.split('\x1b[H\x1b[2J').filter(Boolean);
    const last = frames[frames.length - 1] || '';
    check(/"state":"done"/.test(last) && /run: finished, exit code 0/.test(last), `the last watch frame does not show a finished, done run:\n${tail(last)}`);
    const st = save('status-json', cli(['status', '--json'], { cwd: repo, env: caseEnv }));
    check(st.status === 0, `status exited ${st.status}: ${st.stderr}`);
    const rec = JSON.parse(st.stdout).find(x => x.slug === p.slug);
    check(rec && rec.run === 'exited' && rec.exit_code === '0' && !rec.interrupted, `status --json: ${JSON.stringify(rec)}`);
    const text = cli(['status'], { cwd: repo, env: caseEnv });
    check(new RegExp(`${p.slug}\\s+exit 0`).test(text.stdout), `status: ${text.stdout}`);
    const wt = rec.worktree;
    check(wt === path.join(caseDir, `${c.project}-sdlc`, p.slug) || fs.realpathSync(wt) === fs.realpathSync(path.join(caseDir, `${c.project}-sdlc`, p.slug)),
      `worktree ${wt}, expected ../${c.project}-sdlc/${p.slug}`);
    check(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main', 'the main working tree left main');
    check(git(repo, 'status', '--porcelain') === '', 'the main working tree has changes');
    const runOut = read(path.join(wt, 'Docs/backlog', p.slug, 'logs', 'run.out'));
    checkShipped(c, wt, caseEnv, stubLog, runOut);
    const one = cli(['watch', p.slug], { cwd: repo, env: caseEnv });
    check(one.status === 0 && /"state":"done"/.test(one.stdout), `watch (one frame) exited ${one.status}: ${tail(one.stdout + one.stderr)}`);
  }
  return steps;
}

// ------------------------------------------------------------------------------------------------------------------- main

/** One case in this process (a worker): writes { result, ms, note } to <tmp>/cases/<name>.result.json. */
async function worker(name, tmp) {
  const c = CASES.find(x => x.name === name);
  const env = baseEnv(tmp, path.join(tmp, 'bin'));
  const t0 = Date.now();
  let res;
  try {
    const steps = await runCase(c, tmp, env);
    res = { result: 'pass', note: steps.join(', ') };
  } catch (e) {
    res = { result: 'FAIL', note: e instanceof CheckError ? e.message : (e && e.stack) || String(e) };
  }
  fs.writeFileSync(path.join(tmp, 'cases', `${name}.result.json`), JSON.stringify({ ...res, ms: Date.now() - t0 }));
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--worker') return worker(args[1], args[2]);
  const unknown = args.filter(n => !CASES.some(c => c.name === n));
  if (unknown.length) { console.error(`Unknown case(s): ${unknown.join(', ')} (cases: ${CASES.map(c => c.name).join(', ')})`); return 2; }
  if (!fs.existsSync(BIN)) { console.error(`${BIN} is missing: run npm run build first (npm run e2e does)`); return 1; }
  const jobs = Number(process.env.E2E_JOBS || 3);
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-sdlc-e2e-')));
  installStub(path.join(tmp, 'bin'));
  fs.mkdirSync(path.join(tmp, 'cases'), { recursive: true });
  const env = baseEnv(tmp, path.join(tmp, 'bin'));
  const version = cli(['--version'], { env }).stdout.trim();
  console.log(`ai-sdlc-helper ${version} end-to-end checks on Node ${process.versions.node}, ${jobs} at a time, in ${tmp}\n`);
  const t0 = Date.now();

  const cases = CASES.filter(x => !args.length || args.includes(x.name));
  const results = [];
  for (const c of cases.filter(x => SKIP[x.name])) {
    results.push({ c, result: 'skip', ms: 0, note: SKIP[c.name] });
    console.log(`SKIP ${c.name}: ${SKIP[c.name]}`);
  }
  const todo = cases.filter(x => !SKIP[x.name]);

  // The projects' devDependencies, installed once each (in parallel), copied into every case of the project.
  const projects = [...new Set(todo.map(c => c.project))];
  const installs = await Promise.all(projects.map(p => makeTemplate(tmp, p, env).then(ms => ({ p, ms }), e => ({ p, error: e.message }))));
  for (const i of installs) console.log(i.error ? `FAIL npm install ${i.p}: ${i.error}` : `     npm install ${i.p}: ${seconds(i.ms)}`);
  const broken = new Set(installs.filter(i => i.error).map(i => i.p));
  console.log('');

  const queue = [...todo];
  const runOne = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      if (broken.has(c.project)) { results.push({ c, result: 'FAIL', ms: 0, note: `npm install ${c.project} failed` }); continue; }
      console.log(`.... ${c.name}: ${c.covers}`);
      const w = await runAsync(process.execPath, [fileURLToPath(import.meta.url), '--worker', c.name, tmp], { env: process.env, timeout: 12 * MINUTE });
      const file = path.join(tmp, 'cases', `${c.name}.result.json`);
      const r = fs.existsSync(file) ? readJson(file) : { result: 'FAIL', ms: w.ms, note: `the worker exited ${w.status} without a result:\n${tail(w.stdout + w.stderr)}` };
      results.push({ c, ...r });
      if (r.result === 'pass') console.log(`PASS ${c.name} in ${seconds(r.ms)} (${r.note})`);
      else {
        console.log(`FAIL ${c.name} in ${seconds(r.ms)}\n${r.note.split('\n').map(l => `     ${l}`).join('\n')}`);
        console.log(`     files: ${path.join(tmp, 'cases', c.name)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, runOne));

  results.sort((a, b) => CASES.indexOf(a.c) - CASES.indexOf(b.c));
  const failed = results.filter(r => r.result === 'FAIL');
  console.log('\nSummary');
  const width = Math.max(...results.map(r => r.c.name.length));
  for (const r of results) console.log(`  ${r.result.padEnd(4)}  ${r.c.name.padEnd(width)}  ${seconds(r.ms).padStart(7)}  ${r.result === 'FAIL' ? r.note.split('\n')[0] : r.result === 'skip' ? r.note : r.c.covers}`);
  console.log(`\n${results.filter(r => r.result === 'pass').length} passed, ${failed.length} failed, ${results.filter(r => r.result === 'skip').length} skipped in ${seconds(Date.now() - t0)}`);
  if (failed.length || process.env.E2E_KEEP) console.log(`Kept: ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
  return failed.length ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, e => { console.error(e); process.exitCode = 1; });
