import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { main } from '../src/cli/main.js';
import { commitOnSetupBranch, freeBranch, pushBranch, setupBase } from '../src/registry/setupBranch.js';
import { project, tmp } from './helpers.js';

const sh = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/** A git repository on <branch> with one commit; <withOrigin> adds a bare repository as origin. */
function repo(branch = 'main', withOrigin = false): { dir: string; origin?: string } {
  const dir = fs.realpathSync(project({ 'package.json': { name: 'app', scripts: { test: 'vitest' } } }));
  sh(dir, 'init', '-q', '-b', branch);
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'initial');
  if (!withOrigin) return { dir };
  const origin = fs.realpathSync(tmp('ai-sdlc-origin-'));
  sh(origin, 'init', '-q', '--bare');
  sh(dir, 'remote', 'add', 'origin', origin);
  return { dir, origin };
}

/** An env whose PATH starts with a fake gh that logs its arguments to <log>; it is not logged in when <authed> is false. */
function envWithGh(authed: boolean): { env: NodeJS.ProcessEnv; log: string } {
  const bin = tmp('ai-sdlc-bin-');
  const log = path.join(bin, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${log}"\n[ "$1" = auth ] && exit ${authed ? 0 : 1}\necho https://example.com/pr/1\n`, { mode: 0o755 });
  return { env: { PATH: `${bin}:/usr/bin:/bin`, AI_SDLC_HELPER_CONFIG_DIR: tmp('ai-sdlc-cfg-') }, log };
}

const noGh = (): NodeJS.ProcessEnv => ({ PATH: '/usr/bin:/bin', AI_SDLC_HELPER_CONFIG_DIR: tmp('ai-sdlc-cfg-') });

async function cli(args: string[], env: NodeJS.ProcessEnv, answers?: string[]) {
  let stdout = '';
  let stderr = '';
  const asked: string[] = [];
  const ask = answers && (async (q: string) => { asked.push(q.trim()); return answers.shift() ?? ''; });
  const status = await main(args, { out: t => { stdout += `${t}\n`; }, err: t => { stderr += `${t}\n`; }, env, ask });
  return { status, stdout, stderr, asked };
}

describe('the setup branch', () => {
  test('starts from main, else master, else the branch origin/HEAD points to; none gives null', () => {
    const env = noGh();
    expect(setupBase(repo('main').dir, env)).toBe('main');
    expect(setupBase(repo('master').dir, env)).toBe('master');
    const trunk = repo('trunk', true);
    expect(setupBase(trunk.dir, env)).toBeNull();
    sh(trunk.dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    sh(trunk.dir, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    expect(setupBase(trunk.dir, env)).toBe('trunk');
  });

  test('is named chore/sdlc-setup, then -2 and -3 when taken', () => {
    const { dir } = repo();
    const env = noGh();
    expect(freeBranch(dir, env)).toBe('chore/sdlc-setup');
    sh(dir, 'branch', 'chore/sdlc-setup');
    expect(freeBranch(dir, env)).toBe('chore/sdlc-setup-2');
    sh(dir, 'branch', 'chore/sdlc-setup-2');
    expect(freeBranch(dir, env)).toBe('chore/sdlc-setup-3');
  });

  test('commits only the given files on the new branch and leaves the checkout, a staged file and the worktree list alone', () => {
    const { dir } = repo();
    const env = noGh();
    sh(dir, 'switch', '-q', '-c', 'feature');
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), '{}\n');
    fs.mkdirSync(path.join(dir, 'docs/backlog'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/backlog/index.md'), '# Backlog\n');
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'x');
    sh(dir, 'add', 'staged.txt');

    const r = commitOnSetupBranch(dir, ['sdlc.config.json', 'docs/backlog/index.md'], env)!;
    expect(r).toMatchObject({ branch: 'chore/sdlc-setup', base: 'main' });
    expect(sh(dir, 'branch', '--show-current').stdout.trim()).toBe('feature');
    expect(sh(dir, 'show', '--name-only', '--format=%s', 'chore/sdlc-setup').stdout.trim().split('\n').filter(Boolean))
      .toEqual(['chore: setup ai-sdlc-helper (sdlc.config.json, docs/backlog/index.md)', 'docs/backlog/index.md', 'sdlc.config.json']);
    expect(sh(dir, 'rev-parse', 'chore/sdlc-setup~1').stdout).toBe(sh(dir, 'rev-parse', 'main').stdout);
    expect(sh(dir, 'status', '--short').stdout).toContain('A  staged.txt');
    expect(fs.existsSync(path.join(dir, 'sdlc.config.json'))).toBe(true);
    expect(sh(dir, 'worktree', 'list').stdout.trim().split('\n')).toHaveLength(1);
  });

  test('returns null without a base branch, and pushing with no origin is an error', () => {
    const { dir } = repo('trunk');
    expect(commitOnSetupBranch(dir, ['package.json'], noGh())).toBeNull();
    expect(() => pushBranch(dir, 'trunk', noGh())).toThrow(/git push/);
  });
});

describe('add: commit, push and pull request', () => {
  const added = (dir: string, ...flags: string[]) => ['add', dir, '--yes', ...flags];

  test('--yes alone writes the files and does not answer the commit question: no answer means no commit', async () => {
    const { dir } = repo();
    const r = await cli(added(dir), noGh(), []);
    expect(r.status).toBe(0);
    expect(r.asked).toHaveLength(1);
    expect(r.stdout).toContain('Not committed');
    expect(sh(dir, 'branch', '--list', 'chore/*').stdout).toBe('');
  });

  test('without a terminal and without flags nothing is committed', async () => {
    const { dir } = repo();
    const r = await cli(['add', dir, '--yes'], noGh());
    expect(r.stdout).toContain('Not committed');
    expect(sh(dir, 'branch', '--list', 'chore/*').stdout).toBe('');
  });

  test('--commit commits on the setup branch while the checkout stays put, and does not push', async () => {
    const { dir, origin } = repo('main', true);
    sh(dir, 'switch', '-q', '-c', 'feature');
    const r = await cli(added(dir, '--commit'), noGh());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Committed sdlc.config.json, Docs/backlog/index.md on chore/sdlc-setup from main');
    expect(r.stdout).toContain('Not pushed');
    expect(sh(dir, 'branch', '--show-current').stdout.trim()).toBe('feature');
    expect(sh(origin!, 'branch', '--list').stdout).toBe('');
    expect(sh(dir, 'log', '-1', '--format=%s', 'chore/sdlc-setup').stdout).toContain('chore: setup ai-sdlc-helper');
  });

  test('--push implies --commit and pushes the branch to origin', async () => {
    const { dir, origin } = repo('main', true);
    const { env } = envWithGh(false);
    const r = await cli(added(dir, '--push'), env);
    expect(r.stdout).toContain('Pushed chore/sdlc-setup to origin');
    expect(r.stdout).toContain('No authenticated gh CLI');
    expect(sh(origin!, 'branch', '--list', 'chore/sdlc-setup').stdout).toContain('chore/sdlc-setup');
  });

  test('--pr runs commit, push and pr create into main and prints the URL', async () => {
    const { dir } = repo('main', true);
    const { env, log } = envWithGh(true);
    const r = await cli(added(dir, '--pr'), env);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Pull request: https://example.com/pr/1');
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toContain('pr create --base main --head chore/sdlc-setup --title chore: setup ai-sdlc-helper');
  });

  test('answers y, y, y commit, push and open the pull request in that order', async () => {
    const { dir } = repo('main', true);
    const { env, log } = envWithGh(true);
    const r = await cli(['add', dir, '--yes'], env, ['y', 'y', 'y']);
    expect(r.asked).toEqual([
      expect.stringContaining('Commit sdlc.config.json, Docs/backlog/index.md on a new branch chore/sdlc-setup from main?'),
      'Push chore/sdlc-setup to origin? [y/N]:',
      'Open a pull request into main? [y/N]:',
    ]);
    expect(fs.readFileSync(log, 'utf8')).toContain('pr create');
    expect(r.stdout).toContain('Pull request:');
  });

  test('answering n after the commit stops there; a failed push names the error, stops, and exits 0', async () => {
    const stop = repo('main', true);
    const r1 = await cli(['add', stop.dir, '--yes'], noGh(), ['y', 'n']);
    expect(r1.stdout).toContain('Not pushed. To push: git push -u origin chore/sdlc-setup');
    expect(sh(stop.origin!, 'branch', '--list').stdout).toBe('');

    const { dir } = repo('main');
    const r2 = await cli(added(dir, '--push'), noGh());
    expect(r2.status).toBe(0);
    expect(r2.stderr).toContain('ERROR: git push:');
    expect(sh(dir, 'branch', '--list', 'chore/sdlc-setup').stdout).toContain('chore/sdlc-setup');
  });

  test('a repository without main or master warns and commits nothing', async () => {
    const { dir } = repo('trunk');
    const r = await cli(added(dir, '--commit'), noGh());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('WARNING: no main or master branch');
    expect(sh(dir, 'log', '--oneline').stdout.trim().split('\n')).toHaveLength(1);
  });
});
