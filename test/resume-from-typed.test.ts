import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SLUG, fixture, git, pipeline, statusOf } from './pipeline-fixture.js';

// The stop messages name their resume command through resumeCommand; reworded to say nothing a parser could find, the
// run must still record where it resumes (the stop carries the stage as a typed field).
vi.mock('../src/pipeline/hints.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/pipeline/hints.js')>()),
  resumeCommand: (_slug: string, stage: string) => `press the button for ${stage}`,
}));

afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
vi.setConfig({ testTimeout: 300_000 });

let savedPath: string | undefined;
beforeEach(() => { savedPath = process.env.PATH; });
afterEach(() => { process.env.PATH = savedPath; });

test('a stop whose message does not contain the resume command still records resume_from', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.bin, 'gh'), ['#!/bin/sh', 'if [ "$1" = "--version" ]; then exit 0; fi', 'if [ "$1 $2" = "auth status" ]; then exit 0; fi', 'exit 1', ''].join('\n'), { mode: 0o755 });
  process.env.PATH = `${f.bin}:${savedPath}`;
  const origin = path.join(path.dirname(f.dir), 'origin.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  git(f.dir, 'remote', 'add', 'origin', origin);
  git(f.dir, 'push', '-q', 'origin', 'main');
  const other = path.join(path.dirname(f.dir), 'other');
  spawnSync('git', ['clone', '-q', origin, other]);
  git(other, 'config', 'user.email', 'o@example.com');
  git(other, 'config', 'user.name', 'O');
  const commitIn = (dir: string, text: string, msg: string) => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/existing.mjs'), text);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', msg);
  };
  git(f.dir, 'checkout', '-q', '-b', `feature/${SLUG}`);
  commitIn(f.dir, 'export const one = () => 1; // mine\n', 'mine');
  git(f.dir, 'push', '-q', 'origin', `feature/${SLUG}`);
  commitIn(other, 'export const one = () => 1; // theirs\n', 'theirs');
  git(other, 'push', '-q', 'origin', 'main');

  const r = await pipeline(f, { MAX_ATTEMPTS: '1', FAKE_NO_IMPL: '1' });

  expect(r.status).toBe(1);
  expect(r.stdout).toContain('press the button for red-tests');
  expect(statusOf(f.dir).resume_from).toBe('red-tests');
});
