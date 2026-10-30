import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { main } from '../src/cli/main.js';
import { alive, killTree, projectRoot } from '../src/runs/records.js';
import { repoRulesFile } from '../src/permissions/index.js';
import { pipelineArgv, pipelineEnv } from '../src/runs/index.js';
import { tmp as mkTmp } from './helpers.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// The stand-in pipeline: records where and how it ran and what it inherited, writes a status.json, then sleeps,
// fails or pauses as the slug asks.
const STUB = `#!/bin/sh
slug="$1"; shift
echo "cwd=$(pwd -P) slug=$slug args=$* sdlc_slug=\${SDLC_SLUG:-} plugins=\${CLAUDE_CODE_PLUGIN_DIRS:-} leaked=\${FROM:-}\${SDLC_BASE:-}\${SDLC_WT_BASE:-}\${SDLC_MAX_PARALLEL:-}\${SDLC_ALLOW_MERGED:-}\${AI_SDLC_HELPER_PIPELINE_CMD:-}" >> ran.txt
mkdir -p "Docs/backlog/$slug/logs"
printf '{"slug":"%s","state":"running"}\\n' "$slug" > "Docs/backlog/$slug/logs/status.json"
echo "pipeline output for $slug"
case "$slug" in
  slow*) sleep 300 & echo $! > sleep.pid; wait $! ;;
  fail*) exit 1 ;;
  pause*) exit 2 ;;
esac
exit 0
`;
const SETTINGS = {
  suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }],
  agent: { codeSearch: 'none' }, ui: { timezone: 'UTC' }, worktree: { link: ['server/node_modules', 'graft', 'missing'] },
};
const SLUGS = ['alpha', 'slow-one', 'slow-two', 'fail-one', 'pause-one'];

let template: string;
function buildTemplate(): string {
  const base = mkTmp('runs-tpl-');
  const r = path.join(base, 'repo');
  const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(r, rel)), { recursive: true }); fs.writeFileSync(path.join(r, rel), text); };
  w('sdlc.config.json', JSON.stringify(SETTINGS));
  w('server/node_modules/x.js', '');
  w('graft/index', '');
  for (const s of SLUGS) w(`Docs/backlog/${s}/brief.md`, `# ${s}\n`);
  w('.gitignore', 'node_modules/\n/graft/\nran.txt\nsleep.pid\nsetup.txt\nDocs/backlog/*/logs/\n');
  git(r, 'init', '-q', '-b', 'main');
  // No background maintenance or gc: they create and delete files in .git while the template is copied.
  git(r, 'config', 'maintenance.auto', 'false');
  git(r, 'config', 'gc.auto', '0');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(base, 'stub.sh'), STUB, { mode: 0o755 });
  return base;
}

let tmp: string;
let repo: string;
let wts: string;
let cfg: string;

beforeEach(() => {
  template ||= buildTemplate();
  tmp = fs.realpathSync(mkTmp('runs-'));
  repo = path.join(tmp, 'repo');
  wts = path.join(tmp, 'wts');
  cfg = path.join(tmp, 'config');
  fs.cpSync(path.join(template, 'repo'), repo, { recursive: true });
});

const reg = () => path.join(repo, '.git/sdlc-runs');
const record = (slug: string) => JSON.parse(fs.readFileSync(path.join(reg(), `${slug}.json`), 'utf8'));
const hasRecord = (slug: string) => fs.existsSync(path.join(reg(), `${slug}.json`));

afterEach(() => {
  for (const f of fs.existsSync(reg()) ? fs.readdirSync(reg()) : []) {
    if (!f.endsWith('.json')) continue;
    try { killTree(Number(JSON.parse(fs.readFileSync(path.join(reg(), f), 'utf8')).pid), 'SIGKILL'); } catch { /* none */ }
  }
  for (const d of [wts, path.join(tmp, 'other')]) {
    for (const slug of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      try { process.kill(Number(fs.readFileSync(path.join(d, slug, 'sleep.pid'), 'utf8')), 'SIGKILL'); } catch { /* gone */ }
    }
  }
  spawnSync('pkill', ['-f', tmp]);
  fs.rmSync(tmp, { recursive: true, force: true });
});
afterAll(() => { if (template) fs.rmSync(template, { recursive: true, force: true }); });

const baseEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SDLC_|FROM$|AI_SDLC_HELPER_)/.test(k)) delete env[k];
  return {
    ...env, ...GIT_ENV, SDLC_WT_BASE: wts, SDLC_PLUGIN_DIRS: '', AI_SDLC_HELPER_CONFIG_DIR: cfg,
    AI_SDLC_HELPER_PIPELINE_CMD: `sh ${path.join(template, 'stub.sh')}`,
  };
};

async function cli(args: string[], extra: NodeJS.ProcessEnv = {}, cwd = repo) {
  let stdout = '';
  let stderr = '';
  const status = await main(args, { out: t => { stdout += `${t}\n`; }, err: t => { stderr += `${t}\n`; }, env: { ...baseEnv(), ...extra }, cwd });
  await new Promise(r => setImmediate(r)); // let the test runner's messages through between git-heavy calls
  return { status, stdout, stderr };
}

async function until<T>(fn: () => T, ms = 30000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 50));
  }
}
const finished = (slug: string) => until(() => hasRecord(slug) && record(slug).state === 'exited' && record(slug));
const sleeping = (slug: string, dir = wts) => until(() => {
  const f = path.join(dir, slug, 'sleep.pid');
  return record(slug).state === 'running' && fs.existsSync(f) && Number(fs.readFileSync(f, 'utf8')) || 0;
});
const ranLines = (wt: string) => fs.readFileSync(path.join(wt, 'ran.txt'), 'utf8').trim().split('\n');
const MERGED = (slug: string) => ['commit', '--allow-empty', '-q', '-m', `test(${slug}): add failing tests and spec/plan docs`];

describe('start', () => {
  test('runs the pipeline in its own worktree on sdlc/<slug>, records the run, links the shared folders, and reuses all of it', async () => {
    const r = await cli(['start', 'alpha']);
    expect(r.status).toBe(0);
    const wt = path.join(wts, 'alpha');
    expect(r.stdout).toContain(`started alpha (pid ${record('alpha').pid}) in ${wt} on sdlc/alpha`);
    const rec = await finished('alpha');
    expect(rec).toMatchObject({ slug: 'alpha', worktree: wt, state: 'exited', exit_code: '0', interrupted: false, branch: 'sdlc/alpha', base: 'main', message: '' });
    expect(rec.started).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
    expect(rec.finished).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sdlc/alpha');
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(ranLines(wt)[0]).toBe(`cwd=${fs.realpathSync(wt)} slug=alpha args= sdlc_slug=alpha plugins= leaked=`);
    expect(fs.readFileSync(path.join(wt, 'Docs/backlog/alpha/logs/run.out'), 'utf8')).toContain('pipeline output for alpha');

    // the shared folders are links, kept out of git status and out of every commit; a missing one is skipped
    expect(fs.lstatSync(path.join(wt, 'server/node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(wt, 'graft')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(wt, 'missing'))).toBe(false);
    expect(git(wt, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    git(wt, 'add', 'server');
    expect(git(wt, 'diff', '--cached', '--name-only')).toBe('');

    expect((await cli(['start', 'alpha'])).status).toBe(0);
    await until(() => ranLines(wt).length === 2 && record('alpha').state === 'exited');
    expect(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8').split('\n').filter(l => l === '/graft')).toHaveLength(1);
  });

  test('the pipeline gets --from, SDLC_SLUG and the plugin folders, but none of the controls\' own variables', async () => {
    const extra = { SDLC_BASE: 'main', SDLC_MAX_PARALLEL: '2', SDLC_ALLOW_MERGED: '1', SDLC_PLUGIN_DIRS: '/x/guard' };
    expect((await cli(['start', 'alpha', '--from', 'plan'], { ...extra, FROM: 'implement' })).status).toBe(0);
    await finished('alpha');
    expect(ranLines(path.join(wts, 'alpha'))[0]).toMatch(/slug=alpha args=--from plan sdlc_slug=alpha plugins=\/x\/guard leaked=$/);
    expect(record('alpha').from).toBe('plan');
    // FROM alone (as the control pane passes it) becomes --from
    expect((await cli(['start', 'alpha'], { FROM: 'implement' })).status).toBe(0);
    await until(() => ranLines(path.join(wts, 'alpha')).length === 2);
    expect(ranLines(path.join(wts, 'alpha'))[1]).toMatch(/args=--from implement .*leaked=$/);

    const bad = await cli(['start', 'alpha', '--from', 'bogus']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--from must be one of spec, plan, red-tests, implement, test-repair, review, finalise');
  });

  test('records failing and paused exit codes; copies a brief not committed yet', async () => {
    await cli(['start', 'fail-one']);
    expect(await finished('fail-one')).toMatchObject({ exit_code: '1', interrupted: false });
    await cli(['start', 'pause-one']);
    expect(await finished('pause-one')).toMatchObject({ exit_code: '2' });

    fs.mkdirSync(path.join(repo, 'Docs/backlog/fresh'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'Docs/backlog/fresh/brief.md'), '# fresh\n');
    expect((await cli(['start', 'fresh'])).status).toBe(0);
    expect(fs.readFileSync(path.join(wts, 'fresh/Docs/backlog/fresh/brief.md'), 'utf8')).toBe('# fresh\n');
    await finished('fresh');
  });

  test('a bad slug is a usage error; a missing brief creates nothing and is recorded with its reason', async () => {
    expect((await cli(['start', '../etc'])).status).toBe(2);
    expect((await cli(['start', 'Bad'])).status).toBe(2);
    expect((await cli(['start'])).status).toBe(2);
    expect((await cli(['start', 'alpha', 'beta'])).status).toBe(2);

    const r = await cli(['start', 'nope']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Missing Docs/backlog/nope/brief.md');
    expect(fs.existsSync(path.join(wts, 'nope'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'sdlc/nope')).toBe('');
    expect(record('nope')).toMatchObject({ state: 'exited', exit_code: '1', message: 'Missing Docs/backlog/nope/brief.md', worktree: '', pid: 0 });
  });

  test('refuses an item already merged into the base (exit 5) and records why; SDLC_ALLOW_MERGED runs it; a slug prefix is not merged', async () => {
    git(repo, ...MERGED('alpha'));
    const r = await cli(['start', 'alpha']);
    expect(r.status).toBe(5);
    expect(fs.existsSync(path.join(wts, 'alpha'))).toBe(false);
    expect(record('alpha').message).toMatch(/alpha is already merged into main/);
    expect((await cli(['start', 'alpha'], { SDLC_ALLOW_MERGED: '1' })).status).toBe(0);
    await finished('alpha');

    git(repo, ...MERGED('fail-one-two'));
    expect((await cli(['start', 'fail-one'])).status).toBe(0);
    await finished('fail-one');
  });

  test('a base without the committed settings is refused before any worktree is made, with what to do', async () => {
    git(repo, 'branch', 'other', 'main');
    // a base that has the brief but not sdlc.config.json
    git(repo, 'checkout', '-q', '-b', 'no-config');
    git(repo, 'rm', '-q', 'sdlc.config.json');
    git(repo, 'commit', '-q', '-m', 'drop settings');
    git(repo, 'checkout', '-q', 'main');
    const r = await cli(['start', 'alpha'], { SDLC_BASE: 'no-config' });
    expect(r.status).toBe(1);
    expect(record('alpha').message).toBe('sdlc.config.json is not committed on no-config, which the worktree starts from. '
      + 'Commit it to no-config, or start from a branch that has it: SDLC_BASE=<branch> (or git.base in sdlc.config.json).');
    expect(fs.existsSync(path.join(wts, 'alpha'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'sdlc/alpha')).toBe('');
    expect((await cli(['start', 'alpha'], { SDLC_BASE: 'other' })).status).toBe(0);
    await finished('alpha');
  });

  test('uncommitted settings in the working tree are mirrored into the new worktree when no explicit base is given', async () => {
    git(repo, 'rm', '-q', 'sdlc.config.json');
    git(repo, 'commit', '-q', '-m', 'clean base without config');
    fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify({ suites: [] }));
    fs.mkdirSync(path.join(repo, 'Docs/backlog/mirror-cfg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'Docs/backlog/mirror-cfg/brief.md'), '# mirror-cfg\n');
    const r = await cli(['start', 'mirror-cfg']);
    expect(r.status).toBe(0);
    const wtConfig = path.join(wts, 'mirror-cfg', 'sdlc.config.json');
    expect(fs.existsSync(wtConfig)).toBe(true);
    expect(JSON.parse(fs.readFileSync(wtConfig, 'utf8'))).toEqual({ suites: [] });
    await finished('mirror-cfg');
  });

  test('refuses a slug already running (exit 4) and more than the cap (exit 3, SDLC_MAX_PARALLEL or maxParallel); two run when the cap allows', async () => {
    expect((await cli(['start', 'slow-one'])).status).toBe(0);
    await sleeping('slow-one');

    let r = await cli(['start', 'slow-two'], { SDLC_MAX_PARALLEL: '1' });
    expect(r.status).toBe(3);
    expect(record('slow-two').message).toMatch(/at most 1 pipelines may run at once/);
    expect(fs.existsSync(path.join(wts, 'slow-two'))).toBe(false);

    // the project's maxParallel in the registry
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'projects.json'), JSON.stringify({ version: 1, projects: [{ name: 'demo', path: repo, addedAt: 'x', overrides: { maxParallel: 1 } }] }));
    expect((await cli(['start', 'slow-two'])).status).toBe(3);
    expect((await cli(['start', 'slow-two'], { SDLC_MAX_PARALLEL: 'x' })).status).toBe(1);
    fs.rmSync(path.join(cfg, 'projects.json'));

    r = await cli(['start', 'slow-one']);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('slow-one is already running');
    expect(record('slow-one').state).toBe('running');

    expect((await cli(['start', 'slow-two'])).status).toBe(0);
    await sleeping('slow-two');
    expect(record('slow-one').worktree).not.toBe(record('slow-two').worktree);
  });

  test('suite setup commands run once in a new worktree; a failed setup is recorded and runs again on the next start', async () => {
    const marker = path.join(tmp, 'fail-setup');
    fs.writeFileSync(marker, '');
    const settings = { ...SETTINGS, suites: [{ ...SETTINGS.suites[0], setup: `echo ran >> setup.txt; test ! -e ${marker}` }] };
    fs.writeFileSync(path.join(repo, 'sdlc.config.json'), JSON.stringify(settings));
    git(repo, 'commit', '-q', '-am', 'setup');
    const wt = path.join(wts, 'alpha');

    await cli(['start', 'alpha']);
    expect(await finished('alpha')).toMatchObject({ exit_code: '1' });
    expect(record('alpha').message).toMatch(/^setup of suite app failed \(exit 1\)/);
    expect(fs.existsSync(path.join(wt, 'ran.txt'))).toBe(false);

    fs.rmSync(marker);
    await cli(['start', 'alpha']);
    expect(await until(() => record('alpha').exit_code === '0' && record('alpha'))).toMatchObject({ message: '' });
    await cli(['start', 'alpha']);
    await until(() => ranLines(wt).length === 2 && record('alpha').state === 'exited');
    expect(fs.readFileSync(path.join(wt, 'setup.txt'), 'utf8')).toBe('ran\nran\n');
    expect(fs.readFileSync(path.join(wt, 'Docs/backlog/alpha/logs/run.out'), 'utf8')).toContain('setup app (');
  });
});

describe('stop and status', () => {
  test('status lists each run; stop interrupts a running pipeline and everything it started', async () => {
    await cli(['start', 'alpha']);
    await finished('alpha');
    await cli(['start', 'slow-one']);
    const sleepPid = await sleeping('slow-one');
    const pid = record('slow-one').pid;
    expect(alive(pid)).toBe(true);
    let out = (await cli(['status'])).stdout;
    expect(out).toMatch(/^exited\s+alpha {2}exit 0$/m);
    expect(out).toMatch(new RegExp(`^running\\s+slow-one {2}pid ${pid}$`, 'm'));
    const json = JSON.parse((await cli(['status', '--json'])).stdout);
    expect(json.map((r: any) => [r.slug, r.run])).toEqual([['alpha', 'exited'], ['slow-one', 'running']]);

    const r = await cli(['stop', 'slow-one']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('stopped slow-one\n');
    expect(record('slow-one')).toMatchObject({ state: 'exited', interrupted: true });
    expect(alive(pid)).toBe(false);
    await until(() => !alive(sleepPid));
    out = (await cli(['status'])).stdout;
    expect(out).toMatch(/^interrupted\s+slow-one/m);

    expect((await cli(['stop', 'alpha'])).stdout).toBe('alpha is not running\n');
    expect((await cli(['stop', 'ghost'])).status).toBe(1);
    expect((await cli(['status', 'extra'])).status).toBe(2);
  });

  test('a supervisor that died without finishing shows as stopped', async () => {
    await cli(['start', 'slow-one']);
    await sleeping('slow-one');
    killTree(record('slow-one').pid, 'SIGKILL');
    await until(() => !alive(record('slow-one').pid));
    expect((await cli(['status'])).stdout).toMatch(/^stopped\s+slow-one/m);
    expect((await cli(['watch', 'slow-one'])).stdout).toContain('run: process has gone (stopped without finishing)');
  });
});

describe('discard and restart', () => {
  async function finishedRunWithWork(slug = 'alpha') {
    expect((await cli(['start', slug])).status).toBe(0);
    await finished(slug);
    return addWork(slug);
  }
  function addWork(slug = 'alpha') {
    const wt = record(slug).worktree;
    fs.writeFileSync(path.join(wt, 'stray.txt'), 'work\n');
    git(wt, 'add', 'stray.txt');
    git(wt, 'commit', '-q', '-m', 'stray work');
    fs.writeFileSync(path.join(wt, 'uncommitted.txt'), 'wip\n');
    return { wt, tip: git(repo, 'rev-parse', `sdlc/${slug}`) };
  }

  test('discard needs --yes (exit 6); with it the worktree, branch and record go, and the saved tip brings the work back', async () => {
    const { wt, tip } = await finishedRunWithWork();
    let r = await cli(['discard', 'alpha']);
    expect(r.status).toBe(6);
    expect(r.stdout).toContain('1 commit(s) not in main, 1 uncommitted file(s)');
    expect(fs.existsSync(wt)).toBe(true);

    r = await cli(['discard', 'alpha', '--yes']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`git branch sdlc/alpha ${tip}`);
    expect(fs.existsSync(wt)).toBe(false);
    expect(git(repo, 'branch', '--list', 'sdlc/alpha')).toBe('');
    expect(hasRecord('alpha')).toBe(false);
    expect(fs.readFileSync(path.join(reg(), 'alpha.discarded'), 'utf8').trim()).toBe(`git branch sdlc/alpha ${tip}`);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    git(repo, 'branch', 'sdlc/alpha', tip);
    expect(git(repo, 'log', '-1', '--format=%s', 'sdlc/alpha')).toBe('stray work');

    expect((await cli(['discard', 'ghost', '--yes'])).status).toBe(1);
    expect((await cli(['discard'])).status).toBe(2);
    expect((await cli(['discard', 'alpha', '--nope'])).status).toBe(2);
  });

  test('discard works when the worktree was deleted by hand, and uses the record\'s path when the settings changed', async () => {
    const { wt } = await finishedRunWithWork();
    fs.rmSync(wt, { recursive: true, force: true });
    expect((await cli(['discard', 'alpha', '--yes'])).status).toBe(0);
    expect(git(repo, 'branch', '--list', 'sdlc/alpha')).toBe('');
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);

    const other = path.join(tmp, 'other');
    await cli(['start', 'fail-one']);
    await finished('fail-one');
    const old = record('fail-one').worktree;
    // the worktree base moved since the run started: the record still finds the old worktree
    expect((await cli(['changes', 'fail-one'], { SDLC_WT_BASE: other })).stdout).toBe('0 0\n');
    const r = await cli(['discard', 'fail-one', '--yes'], { SDLC_WT_BASE: other });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`worktree ${old}`);
    expect(fs.existsSync(old)).toBe(false);
    expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('a running pipeline: discard refuses it (exit 4), restart replaces it, discard --yes --stop stops and deletes it', async () => {
    await cli(['start', 'slow-one']);
    await sleeping('slow-one');
    const oldPid = record('slow-one').pid;

    expect((await cli(['discard', 'slow-one', '--yes'])).status).toBe(4);
    expect((await cli(['discard', 'slow-one', '--stop'])).status).toBe(6);
    expect(alive(oldPid)).toBe(true);

    expect((await cli(['restart', 'slow-one', '--yes'])).status).toBe(0);
    expect(alive(oldPid)).toBe(false);
    await until(() => record('slow-one').pid !== oldPid && sleeping('slow-one'));
    expect(record('slow-one').interrupted).toBe(false);

    const pid = record('slow-one').pid;
    const sleepPid = Number(fs.readFileSync(path.join(wts, 'slow-one/sleep.pid'), 'utf8'));
    expect((await cli(['discard', 'slow-one', '--yes', '--stop'])).status).toBe(0);
    expect(alive(pid)).toBe(false);
    await until(() => !alive(sleepPid));
    expect(fs.existsSync(path.join(wts, 'slow-one'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'sdlc/slow-one')).toBe('');
    expect(hasRecord('slow-one')).toBe(false);
  });

  test('restart needs --yes (exit 6); with it the run starts again from scratch, unless the item is already merged (exit 5)', async () => {
    expect((await cli(['restart', 'alpha'])).status).toBe(0); // nothing to discard: it simply starts
    await finished('alpha');
    const { wt, tip } = addWork();
    expect((await cli(['restart', 'alpha'])).status).toBe(6);
    expect(fs.existsSync(path.join(wt, 'stray.txt'))).toBe(true);

    const r = await cli(['restart', 'alpha', '--yes', '--from', 'spec']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`git branch sdlc/alpha ${tip}`);
    await finished('alpha');
    expect(fs.existsSync(path.join(wt, 'stray.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wt, 'uncommitted.txt'))).toBe(false);
    expect(ranLines(wt)).toHaveLength(1);
    expect(ranLines(wt)[0]).toContain('args=--from spec');
    expect(git(repo, 'rev-parse', 'sdlc/alpha')).toBe(git(repo, 'rev-parse', 'main'));

    addWork();
    git(repo, ...MERGED('alpha'));
    expect((await cli(['restart', 'alpha', '--yes'])).status).toBe(5);
    expect(fs.existsSync(path.join(wt, 'stray.txt'))).toBe(true);
  });
});

describe('watch', () => {
  const writeStatus = (dir: string, slug: string, text: string) => {
    fs.mkdirSync(path.join(dir, 'Docs/backlog', slug, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Docs/backlog', slug, 'logs/status.json'), `${text}\n`);
  };

  test('shows the status.json, run state, files and last 5 run.out lines of the worktree, or of a run in place', async () => {
    expect((await cli(['watch'])).status).toBe(2);
    expect((await cli(['watch', 'Bad'])).status).toBe(2);
    let r = await cli(['watch', 'alpha']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No pipeline for alpha');

    writeStatus(repo, 'alpha', '{"slug":"alpha","state":"in-place"}');
    r = await cli(['watch', 'alpha']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('{"slug":"alpha","state":"in-place"}');

    await cli(['start', 'alpha']);
    await finished('alpha');
    const wt = record('alpha').worktree;
    writeStatus(wt, 'alpha', '{"slug":"alpha","stage":"Red tests"}');
    fs.writeFileSync(path.join(wt, 'in-worktree.txt'), 'x');
    fs.writeFileSync(path.join(repo, 'in-main-tree.txt'), 'x');
    fs.writeFileSync(path.join(wt, 'Docs/backlog/alpha/logs/run.out'), `${Array.from({ length: 9 }, (_, i) => `line${i + 1}`).join('\n')}\n`);
    r = await cli(['watch', 'alpha']);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe('{"slug":"alpha","stage":"Red tests"}');
    expect(lines[1]).toBe('run: finished, exit code 0');
    expect(r.stdout).toContain('?? in-worktree.txt');
    expect(r.stdout).not.toContain('in-main-tree.txt');
    expect(lines.slice(-6)).toEqual(['--- run.out (last 5 lines)', 'line5', 'line6', 'line7', 'line8', 'line9']);

    for (const bad of ['abc', '0', '-1']) expect([bad, (await cli(['watch', 'alpha', '--follow', bad])).status]).toEqual([bad, 2]);
    expect((await cli(['watch', 'alpha', '7'])).status).toBe(2); // seconds without --follow
  });

  test('--follow refreshes until the run ends', async () => {
    await cli(['start', 'slow-one']);
    await sleeping('slow-one');
    let stdout = '';
    const watching = main(['watch', 'slow-one', '--follow', '0.1'], { out: t => { stdout += `${t}\n`; }, err: () => {}, env: baseEnv(), cwd: repo });
    await until(() => stdout.split('\x1b[2J').length - 1 >= 2);
    expect(stdout).toContain('{"slug":"slow-one","state":"running"}');
    await cli(['stop', 'slow-one']);
    expect(await watching).toBe(0);
    expect(stdout.trim().split('\n').some(l => l.includes('run: interrupted (stopped by the user)'))).toBe(true);
  });
});

describe('changes', () => {
  const writeIn = (dir: string, rel: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'x\n');
  };
  const commit = (dir: string, msg: string) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };
  async function pipeline(slug: string) {
    await cli(['start', slug]);
    await finished(slug);
    return record(slug).worktree as string;
  }

  test('counts committed, uncommitted and renamed files in the worktree; --json lists them; errors for an unknown or deleted worktree', async () => {
    const a = await pipeline('alpha');
    writeIn(a, 'a.txt'); writeIn(a, 'b.txt');
    commit(a, 'two files');
    writeIn(a, 'c.txt');
    fs.appendFileSync(path.join(a, 'Docs/backlog/alpha/brief.md'), 'more\n');
    writeIn(repo, 'in-main-tree.txt');
    expect(await cli(['changes', 'alpha'])).toEqual({ status: 0, stdout: '4 2\n', stderr: '' });
    expect((await cli(['changes', 'alpha'], {}, a)).stdout).toBe('4 2\n'); // from inside the worktree: the same numbers
    const j = JSON.parse((await cli(['changes', '--json', 'alpha'])).stdout);
    expect(j).toEqual({ slug: 'alpha', worktree: a, changed: 4, uncommitted: 2, files: ['Docs/backlog/alpha/brief.md', 'a.txt', 'b.txt', 'c.txt'] });

    const f = await pipeline('fail-one');
    git(f, 'mv', 'Docs/backlog/fail-one/brief.md', 'Docs/backlog/fail-one/renamed.md');
    writeIn(f, 'my notes.txt');
    expect(JSON.parse((await cli(['changes', 'fail-one', '--json'])).stdout)).toMatchObject({
      changed: 2, uncommitted: 2, files: ['Docs/backlog/fail-one/renamed.md', 'my notes.txt'],
    });

    let r = await cli(['changes', 'ghost']);
    expect([r.status, r.stdout, r.stderr]).toEqual([1, '', 'No pipeline for ghost\n']);
    expect((await cli(['changes', 'Bad'])).status).toBe(2);
    expect((await cli(['changes', 'alpha', 'beta'])).stderr).toContain('usage: ai-sdlc-helper changes');

    // --all: every recorded run in one JSON line, an error for one that cannot be counted
    fs.rmSync(f, { recursive: true, force: true });
    r = await cli(['changes', '--all']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ runs: { alpha: { changed: 4, uncommitted: 2 }, 'fail-one': { error: 'Worktree for fail-one is gone' } } });
    r = await cli(['changes', '--all', 'alpha', 'ghost']);
    expect(JSON.parse(r.stdout)).toEqual({ runs: { alpha: { changed: 4, uncommitted: 2 }, ghost: { error: 'No pipeline for ghost' } } });
    expect((await cli(['changes', '--all', 'Bad'])).status).toBe(2);

    // the snapshot sub-commands still work beside the run forms
    const baseline = path.join(tmp, 'baseline.json');
    expect((await cli(['changes', 'snapshot', baseline])).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(baseline, 'utf8')).files).toHaveProperty(['in-main-tree.txt']);
  });

  test('counts against the base in the record', async () => {
    const a = await pipeline('alpha');
    git(repo, 'branch', 'root', 'main');
    writeIn(a, 'w.txt'); commit(a, 'w');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm\n'); commit(repo, 'main moves');
    expect((await cli(['changes', 'alpha'])).stdout).toBe('1 0\n');
    const f = path.join(reg(), 'alpha.json');
    fs.writeFileSync(f, JSON.stringify({ ...record('alpha'), base: 'no-such-ref' }));
    expect((await cli(['changes', 'alpha'])).stdout).toBe('0 0\n');
  });
});

describe('permit and --project', () => {
  test('permit decides in the run\'s worktree, also from another checkout; always saves the rule in the run\'s project (an older record: the main working tree)', async () => {
    const runner = path.join(tmp, 'runner');
    git(repo, 'worktree', 'add', '-q', '--detach', runner, 'main');
    const wt = path.join(tmp, 'wts', 'alpha');
    const state = path.join(wt, 'Docs/backlog/alpha/logs/permissions.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, JSON.stringify({ pending: [{ stage: 'red-tests', tool: 'Bash', detail: 'cd x && ls', rule: 'Bash(cd:*)', protected: false }], allow: [], bypass: [], denied: [] }));
    fs.mkdirSync(reg(), { recursive: true });
    fs.writeFileSync(path.join(reg(), 'alpha.json'), JSON.stringify({ slug: 'alpha', worktree: wt, pid: 0, state: 'exited', exit_code: '2' }));

    const r = await cli(['permit', 'alpha', 'always', 'all'], { SDLC_WT_BASE: path.join(tmp, 'elsewhere') }, runner);
    expect([r.status, r.stdout]).toEqual([0, '0\n']);
    expect(JSON.parse(fs.readFileSync(state, 'utf8')).allow).toEqual(['Bash(cd:*)']);
    expect(JSON.parse(fs.readFileSync(path.join(repo, '.claude/sdlc-permissions.json'), 'utf8')).allow).toEqual(['Bash(cd:*)']);
    expect(fs.existsSync(path.join(runner, '.claude/sdlc-permissions.json'))).toBe(false);
    expect((await cli(['permit', 'ghost', 'allow'], {}, runner)).stderr).toContain('No pipeline for ghost');
  });

  test('--project names a registered project, from any folder', async () => {
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'projects.json'), JSON.stringify({ version: 1, projects: [{ name: 'demo', path: repo, addedAt: 'x' }] }));
    const away = fs.realpathSync(os.tmpdir());
    expect((await cli(['start', 'alpha', '--project', 'demo'], {}, away)).status).toBe(0);
    await finished('alpha');
    expect((await cli(['status', '--project', 'demo'], {}, away)).stdout).toMatch(/^exited\s+alpha/m);
    expect((await cli(['changes', 'alpha', '--project', 'demo'], {}, away)).stdout).toBe('0 0\n');
    const r = await cli(['status', '--project', 'nope'], {}, away);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('"nope" is not a registered project');
    expect((await cli(['status', '--project'], {}, away)).status).toBe(2);
  });
});

describe('the pipeline command', () => {
  test('is this tool\'s own `pipeline`, or the command line in AI_SDLC_HELPER_PIPELINE_CMD', () => {
    const own = pipelineArgv('alpha', 'review', {});
    expect(own[0]).toBe(process.execPath);
    expect(own[1]).toMatch(/[/\\]bin\.js$/);
    expect(own.slice(2)).toEqual(['pipeline', 'alpha', '--from', 'review']);
    expect(pipelineArgv('alpha', undefined, { AI_SDLC_HELPER_PIPELINE_CMD: 'my-pipeline --x' })).toEqual(['sh', '-c', 'my-pipeline --x "$@"', 'sh', 'alpha']);
  });
});

describe('a project that is one worktree of a bigger repository', () => {
  test('uses its own settings (base, backlog item), and a run worktree maps back to it, also for saved rules', async () => {
    // another checkout of the same repository, on its own branch, with settings that start runs from that branch
    const trial = path.join(tmp, 'trial');
    git(repo, 'worktree', 'add', '-q', '-b', 'trial', trial, 'main');
    fs.writeFileSync(path.join(trial, 'sdlc.config.json'), JSON.stringify({ ...SETTINGS, git: { base: 'trial' } }));
    fs.mkdirSync(path.join(trial, 'Docs/backlog/trial-only'), { recursive: true });
    fs.writeFileSync(path.join(trial, 'Docs/backlog/trial-only/brief.md'), '# trial-only\n');
    git(trial, 'add', '-A');
    git(trial, 'commit', '-q', '-m', 'trial settings');
    const trialTip = git(trial, 'rev-parse', 'HEAD');

    const r = await cli(['start', 'trial-only'], {}, trial);
    expect([r.status, r.stderr]).toEqual([0, '']);
    const rec = await finished('trial-only');
    expect(rec).toMatchObject({ base: 'trial', root: trial, exit_code: '0' });
    const wt = path.join(wts, 'trial-only');
    expect(git(wt, 'merge-base', '--is-ancestor', trialTip, 'HEAD')).toBe('');

    // from inside the run's worktree, commands work on the checkout that started it, not on the main working tree
    expect(projectRoot(wt)).toBe(trial);
    expect(projectRoot(trial)).toBe(trial);
    expect(projectRoot(repo)).toBe(repo);
    expect(repoRulesFile(wt)).toBe(path.join(trial, '.claude/sdlc-permissions.json'));
    const st = await cli(['status'], {}, wt);
    expect(st.stdout).toMatch(/exited +trial-only/);
  });
});

describe('runs of other checkouts of the repository', () => {
  test('status and changes --all list this project\'s runs only; a record without a root belongs to the main working tree', async () => {
    fs.mkdirSync(reg(), { recursive: true });
    const other = path.join(tmp, 'other-checkout');
    git(repo, 'worktree', 'add', '-q', '-b', 'other', other, 'main');
    fs.writeFileSync(path.join(reg(), 'mine.json'), JSON.stringify({ slug: 'mine', worktree: '', pid: 0, state: 'exited', exit_code: '0', root: repo }));
    fs.writeFileSync(path.join(reg(), 'legacy.json'), JSON.stringify({ slug: 'legacy', worktree: '', pid: 0, state: 'exited', exit_code: '2' }));
    fs.writeFileSync(path.join(reg(), 'theirs.json'), JSON.stringify({ slug: 'theirs', worktree: '', pid: 0, state: 'exited', exit_code: '0', root: other }));
    const slugs = (out: string) => out.split('\n').filter(Boolean).map(l => l.trim().split(/\s+/)[1]).sort();
    expect(slugs((await cli(['status'])).stdout)).toEqual(['legacy', 'mine']);
    expect(slugs((await cli(['status'], {}, other)).stdout)).toEqual(['theirs']);
    expect(JSON.parse((await cli(['status', '--json'], {}, other)).stdout).map((r: { slug: string }) => r.slug)).toEqual(['theirs']);
  });

  test('pipelineEnv passes SDLC_AUTO_ACCEPT to the pipeline while stripping CONTROL_ENV', () => {
    const ctx = {
      root: repo,
      env: { SDLC_AUTO_ACCEPT: '1', SDLC_BASE: 'main', SDLC_WT_BASE: '../wts', FROM: 'plan', OTHER_VAR: 'val' },
    } as any;
    const env = pipelineEnv(ctx, 'item-slug');
    expect(env.SDLC_AUTO_ACCEPT).toBe('1');
    expect(env.OTHER_VAR).toBe('val');
    expect(env.SDLC_SLUG).toBe('item-slug');
    expect(env.SDLC_BASE).toBeUndefined();
    expect(env.SDLC_WT_BASE).toBeUndefined();
    expect(env.FROM).toBeUndefined();
  });
});

