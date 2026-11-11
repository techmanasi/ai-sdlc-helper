import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ciFailureReport, ciOf, ciSummaryOf, clearPrCache, conflictsOf, getPrStatusAsync } from '../src/pipeline/finalise.js';
import { ciFailureInput } from '../src/pipeline/prompts.js';
import { runContext } from '../src/runs/index.js';
import { syncPr, writeCiFailure } from '../src/runs/prsync.js';
import { tmp, write } from './helpers.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }); if (r.status !== 0) throw new Error(r.stderr); };

const run = (name: string, conclusion: string | null, status = 'COMPLETED') => ({ name, status, conclusion, detailsUrl: 'https://github.com/o/r/actions/runs/777/job/1' });

describe('ciOf', () => {
  test('in progress, passed, failed, none', () => {
    expect(ciOf([])).toEqual({ ci: 'none', failing: [] });
    expect(ciOf(undefined)).toEqual({ ci: 'none', failing: [] });
    expect(ciOf([run('a', 'SUCCESS'), run('b', 'SKIPPED')])).toEqual({ ci: 'passed', failing: [] });
    expect(ciOf([run('a', 'SUCCESS'), run('b', null, 'IN_PROGRESS')])).toEqual({ ci: 'in progress', failing: [] });
    expect(ciOf([run('a', null, 'QUEUED')])).toEqual({ ci: 'in progress', failing: [] });
    expect(ciOf([run('check (18)', 'FAILURE'), run('check (20)', 'FAILURE'), run('e2e', 'SUCCESS')])).toEqual({ ci: 'failed', failing: ['check (18)', 'check (20)'] });
  });

  test('a failure counts as failed even while other checks run; commit statuses are read too', () => {
    expect(ciOf([run('a', 'FAILURE'), run('b', null, 'IN_PROGRESS')]).ci).toBe('failed');
    expect(ciOf([{ context: 'ci/x', state: 'SUCCESS' }]).ci).toBe('passed');
    expect(ciOf([{ context: 'ci/x', state: 'PENDING' }]).ci).toBe('in progress');
    expect(ciOf([{ context: 'ci/x', state: 'FAILURE' }])).toEqual({ ci: 'failed', failing: ['ci/x'] });
  });
});

let base: string;
let root: string;
let env: NodeJS.ProcessEnv;

/** A gh: `pr view` prints out.json; `run view 777 --log-failed` prints a CI log in gh's tab-separated format. */
function ghShim(rollup: unknown[]): void {
  fs.writeFileSync(path.join(base, 'out.json'), JSON.stringify({ url: 'https://github.com/o/r/pull/91', state: 'OPEN', number: 91, statusCheckRollup: rollup, comments: [], reviews: [] }));
  const log = [
    'check (18)\tRun npm run lint\t2026-11-09T21:34:53.4641853Z ##[error]  70:81  error  Unnecessary escape character: \\/  no-useless-escape',
    "check (24)\tRun npm run lint\t2026-11-09T21:34:54.1Z ##[error]  70:81  error  Unnecessary escape character: \\/  no-useless-escape",
    'check (18)\tRun npm run lint\t2026-11-09T21:34:53.5Z ##[error]Process completed with exit code 1.',
    'check (18)\tRun npm run lint\t2026-11-09T21:34:53.6Z all good here',
  ].join('\n');
  fs.writeFileSync(path.join(base, 'ci.log'), `${log}\n`);
  fs.mkdirSync(path.join(base, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'bin', 'gh'), `#!/bin/sh
if [ "$1" = "run" ]; then cat "${base}/ci.log"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat "${base}/out.json"; exit 0; fi
exit 1
`, { mode: 0o755 });
  env = { ...GIT_ENV, PATH: `${path.join(base, 'bin')}:${process.env.PATH}` };
}

beforeEach(() => {
  clearPrCache();
  base = fs.realpathSync(tmp('ci-status-'));
  root = path.join(base, 'repo');
  write(root, 'sdlc.config.json', { suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } });
  write(root, 'Docs/backlog/index.md', '# Backlog\n\n- [ ] `add-tokens` - Feature: Add tokens\n');
  write(root, 'Docs/backlog/add-tokens/brief.md', '# add-tokens\n\nPull request: https://github.com/o/r/pull/91\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const wt = path.join(base, 'wts', 'add-tokens');
  git(root, 'worktree', 'add', '-q', wt, '-b', 'sdlc/add-tokens');
  write(path.join(root, '.git/sdlc-runs'), 'add-tokens.json', { slug: 'add-tokens', worktree: wt, pid: 0, started: '2026-10-19T10:00:00', state: 'exited', exit_code: '0', interrupted: false, finished: '', message: '', branch: 'sdlc/add-tokens', base: 'main' });
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe('the CI of a pull request', () => {
  test('the status read from GitHub carries the CI state and the failing checks', async () => {
    ghShim([run('check (18)', 'FAILURE'), run('e2e (20)', 'SUCCESS')]);
    const r = await getPrStatusAsync(root, 'sdlc/add-tokens', env);
    expect(r.status).toMatchObject({ state: 'OPEN', number: 91, ci: 'failed', failing: ['check (18)'] });
  });

  test('a failing CI is reported with the distinct error lines of its logs, once even when several jobs repeat them', () => {
    ghShim([run('check (18)', 'FAILURE'), run('check (24)', 'FAILURE')]);
    const r = ciFailureReport(root, 'sdlc/add-tokens', env);
    expect(r).toMatchObject({ ok: true, ci: 'failed', failing: ['check (18)', 'check (24)'] });
    expect(r.summary).toEqual(['70:81  error  Unnecessary escape character: \\/  no-useless-escape', 'Process completed with exit code 1.']);
    expect(r.markdown).toContain('Failing checks: check (18), check (24)');
    expect(r.markdown.match(/no-useless-escape/g)).toHaveLength(1);
    expect(r.markdown).not.toContain('all good here');
    expect(ciSummaryOf(r.markdown)).toEqual(r.summary);
  });

  test('a passing or running CI has no failure report', () => {
    ghShim([run('check (18)', 'SUCCESS')]);
    expect(ciFailureReport(root, 'sdlc/add-tokens', env)).toMatchObject({ ok: true, ci: 'passed', markdown: '' });
    ghShim([run('check (18)', null, 'IN_PROGRESS')]);
    expect(ciFailureReport(root, 'sdlc/add-tokens', env).ci).toBe('in progress');
  });

  test('writeCiFailure writes ci-failure.md to the task and the run worktree, and removes it once the CI no longer fails', () => {
    ghShim([run('check (18)', 'FAILURE')]);
    const ctx = runContext(root, env);
    expect(writeCiFailure(ctx, 'add-tokens')).toMatchObject({ ok: true, ci: 'failed', failing: ['check (18)'] });
    const files = [path.join(root, 'Docs/backlog/add-tokens/ci-failure.md'), path.join(base, 'wts/add-tokens/Docs/backlog/add-tokens/ci-failure.md')];
    for (const f of files) expect(fs.readFileSync(f, 'utf8')).toContain('# CI failure of the pull request');
    ghShim([run('check (18)', 'SUCCESS')]);
    clearPrCache();
    expect(writeCiFailure(ctx, 'add-tokens')).toMatchObject({ ok: true, ci: 'passed' });
    for (const f of files) expect(fs.existsSync(f)).toBe(false);
  });

  test('Sync PR brings the state, the CI, the comments and the failure summary in one answer', async () => {
    ghShim([run('check (18)', 'FAILURE')]);
    fs.writeFileSync(path.join(base, 'out.json'), JSON.stringify({ url: 'https://github.com/o/r/pull/91', state: 'OPEN', number: 91, statusCheckRollup: [run('check (18)', 'FAILURE')], comments: [{ body: 'please rename', author: { login: 'rev' }, createdAt: '2026-11-09T10:00:00Z' }], reviews: [] }));
    const ctx = runContext(root, env);
    const r = await syncPr(ctx, 'add-tokens');
    expect(r.ok).toBe(true);
    expect(r.pr).toMatchObject({ state: 'OPEN', number: 91, ci: 'failed', failing: ['check (18)'] });
    expect(r.count).toBe(1);
    expect(r.summary).toContain('Process completed with exit code 1.');
    expect(fs.readFileSync(path.join(root, 'Docs/backlog/add-tokens/pr-comments.md'), 'utf8')).toContain('please rename');
    expect(fs.existsSync(path.join(base, 'wts/add-tokens/Docs/backlog/add-tokens/ci-failure.md'))).toBe(true);
  });
});

describe('Sync PR progress', () => {
  test('names each thing it asks for, and reads the failing CI details only when CI failed', async () => {
    ghShim([run('check (18)', 'FAILURE')]);
    const ctx = runContext(root, env);
    const failed: string[] = [];
    await syncPr(ctx, 'add-tokens', l => failed.push(l));
    expect(failed).toEqual(['Asking GitHub for the PR state and CI', 'Saving the review comments', 'Reading the failing CI details']);
    ghShim([run('check (18)', 'SUCCESS')]);
    clearPrCache();
    const passed: string[] = [];
    await syncPr(ctx, 'add-tokens', l => passed.push(l));
    expect(passed).toEqual(['Asking GitHub for the PR state and CI', 'Saving the review comments']);
  });
});

describe('the conflict state of a pull request', () => {
  test('conflictsOf reads GitHub\'s mergeable', () => {
    expect(conflictsOf('CONFLICTING')).toBe('conflicting');
    expect(conflictsOf('MERGEABLE')).toBe('none');
    expect(conflictsOf('UNKNOWN')).toBe('unknown');
  });

  test('the status read from GitHub carries it, and a PR answered without it carries none', async () => {
    ghShim([run('check (18)', 'SUCCESS')]);
    const out = JSON.parse(fs.readFileSync(path.join(base, 'out.json'), 'utf8'));
    fs.writeFileSync(path.join(base, 'out.json'), JSON.stringify({ ...out, mergeable: 'CONFLICTING' }));
    expect((await getPrStatusAsync(root, 'sdlc/add-tokens', env)).status).toMatchObject({ ci: 'passed', conflicts: 'conflicting' });
    clearPrCache();
    fs.writeFileSync(path.join(base, 'out.json'), JSON.stringify(out));
    expect((await getPrStatusAsync(root, 'sdlc/add-tokens', env)).status?.conflicts).toBeUndefined();
  });
});

describe('the CI failure in the Implement prompt', () => {
  test('is added when ci-failure.md exists, and empty otherwise', () => {
    const docs = tmp('ci-prompt-');
    expect(ciFailureInput(docs)).toBe('');
    fs.writeFileSync(path.join(docs, 'ci-failure.md'), '# CI failure of the pull request\n\nFailing checks: check (18)\n');
    const text = ciFailureInput(docs);
    expect(text).toContain('Failing checks: check (18)');
    expect(text).toContain('Never edit a test to make it pass');
  });
});
