// pickBaseAsync (the web server's) gives the base pickBase gives, in every repository shape the candidates cover.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { pickBase, pickBaseAsync, runContext } from '../src/runs/index.js';
import { tmp } from './helpers.js';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};

/** A repository made by <shape>, then both answers compared. */
async function same(shape: (repo: string) => void): Promise<string> {
  const repo = tmp('pick-base-');
  shape(repo);
  const ctx = runContext(repo, { ...GIT_ENV, SDLC_BASE: '' });
  ctx.base = null;
  const sync = pickBase(ctx);
  expect(await pickBaseAsync(ctx)).toBe(sync);
  return sync;
}
const commit = (repo: string, file: string) => { fs.writeFileSync(path.join(repo, file), file); git(repo, 'add', file); git(repo, 'commit', '-q', '-m', file); };

describe('pickBaseAsync', () => {
  test('main with the settings committed', async () => {
    expect(await same(r => { git(r, 'init', '-q', '-b', 'main'); commit(r, 'sdlc.config.json'); })).toBe('main');
  });
  test('on a feature branch: the current branch comes first', async () => {
    expect(await same(r => { git(r, 'init', '-q', '-b', 'main'); commit(r, 'sdlc.config.json'); git(r, 'checkout', '-q', '-b', 'feat/x'); })).toBe('feat/x');
  });
  test('settings only on a later candidate: that candidate', async () => {
    expect(await same(r => { git(r, 'init', '-q', '-b', 'main'); commit(r, 'a.txt'); git(r, 'checkout', '-q', '-b', 'master'); commit(r, 'sdlc.config.json'); git(r, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(r, 'sdlc.config.json'), '{}'); })).toBe('master');
  });
  test('no settings file: the first valid candidate', async () => {
    expect(await same(r => { git(r, 'init', '-q', '-b', 'trunk'); commit(r, 'a.txt'); })).toBe('trunk');
  });
  test('detached HEAD without main: HEAD', async () => {
    expect(await same(r => { git(r, 'init', '-q', '-b', 'trunk'); commit(r, 'a.txt'); commit(r, 'b.txt'); git(r, 'checkout', '-q', '--detach', 'HEAD~1'); git(r, 'branch', '-q', '-m', 'trunk', 'other'); })).toBe('HEAD');
  });
  test('no commit at all: none', async () => {
    expect(await same(r => { git(r, 'init', '-q', '-b', 'main'); })).toBe('');
  });
});
