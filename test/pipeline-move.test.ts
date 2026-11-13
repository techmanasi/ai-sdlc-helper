import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LOG, SLUG, fixture, git, pipeline, read, statusOf, type Fixture } from './pipeline-fixture.js';

afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
vi.setConfig({ testTimeout: 300_000 });

const BRANCH = `feature/${SLUG}`;
const NEW_PR = 'https://github.com/o/r/pull/99';

/** A fixture whose first run stopped after Red tests, pushed to a bare origin that another clone then moved on. */
async function originAhead(): Promise<{ f: Fixture; origin: string }> {
  const f = fixture();
  // A gh stand-in first on PATH, so nothing reaches a real GitHub.
  fs.writeFileSync(path.join(f.bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then exit 0; fi',
    `if [ "$1 $2" = "pr create" ]; then echo "$@" >> "${f.fake}/gh-create.log"; echo ${NEW_PR}; exit 0; fi`,
    'exit 1', '',
  ].join('\n'), { mode: 0o755 });
  const r = await pipeline(f, { MAX_ATTEMPTS: '1', FAKE_NO_IMPL: '1' });
  expect(r.status).toBe(1);
  const origin = path.join(path.dirname(f.dir), 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', origin]);
  git(f.dir, 'remote', 'add', 'origin', origin);
  git(f.dir, 'push', '-q', 'origin', 'main', BRANCH);
  const other = path.join(path.dirname(f.dir), 'other');
  spawnSync('git', ['clone', '-q', origin, other]);
  git(other, 'config', 'user.email', 'o@example.com');
  git(other, 'config', 'user.name', 'O');
  git(other, 'checkout', '-q', BRANCH);
  fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'theirs');
  git(other, 'push', '-q', 'origin', BRANCH);
  return { f, origin };
}

describe('a run whose branch cannot be pushed', () => {
  test('a Spec start moves to <branch>-2 and a later resume stays there', async () => {
    const { f, origin } = await originAhead();
    const theirs = git(origin, 'rev-parse', BRANCH);
    let r = await pipeline(f, { MAX_ATTEMPTS: '1', FAKE_NO_IMPL: '1' });
    expect(r.stdout).toContain(`MOVED:`);
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(`${BRANCH}-2`);
    expect(statusOf(f.dir)).toMatchObject({ branch: `${BRANCH}-2`, moved_from: { branch: BRANCH, reason: 'remote-ahead' } });
    // The old branch is left alone, here and on origin.
    expect(git(origin, 'rev-parse', BRANCH)).toBe(theirs);
    expect(git(f.dir, 'branch', '--list', BRANCH)).not.toBe('');
    const moves = read(f.dir, `${LOG}/attempts.jsonl`).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(x => x.kind === 'move');
    expect(moves).toMatchObject([{ from: BRANCH, to: `${BRANCH}-2` }]);

    // A resume at Implement keeps the moved branch, does not go back, and keeps saying where it came from.
    r = await pipeline(f, {}, { from: 'implement' });
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(`${BRANCH}-2`);
    expect(r.stdout).not.toContain('MOVED:');
    expect(git(f.dir, 'branch', '--list', `${BRANCH}-3`)).toBe('');
    expect(statusOf(f.dir)).toMatchObject({ branch: `${BRANCH}-2`, moved_from: { branch: BRANCH } });
  });

  test('SDLC_MOVE_BRANCH=0 keeps the branch', async () => {
    const { f } = await originAhead();
    const r = await pipeline(f, { MAX_ATTEMPTS: '1', FAKE_NO_IMPL: '1', SDLC_MOVE_BRANCH: '0' });
    expect(r.stdout).not.toContain('MOVED:');
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
  });

  test('a start at Review does not move even when origin is ahead', async () => {
    const { f } = await originAhead();
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.stdout).not.toContain('MOVED:');
    expect(git(f.dir, 'symbolic-ref', '--short', 'HEAD')).toBe(BRANCH);
    expect(statusOf(f.dir).moved_from).toBeUndefined();
  });

  test('a start at Resolve conflicts does not move even when origin is ahead', async () => {
    const { f } = await originAhead();
    await pipeline(f, {}, { from: 'resolve-conflicts' });
    expect(git(f.dir, 'branch', '--list', `${BRANCH}-2`)).toBe('');
  });
});
