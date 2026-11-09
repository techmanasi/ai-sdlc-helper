import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runContext } from '../src/runs/index.js';
import { createPrForCompleted } from '../src/runs/completed.js';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const PR = 'https://github.com/o/r/pull/42';
let saved: { PATH?: string; SDLC_WT_BASE?: string };

afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.SDLC_WT_BASE === undefined) delete process.env.SDLC_WT_BASE; else process.env.SDLC_WT_BASE = saved.SDLC_WT_BASE;
});

describe('creating a PR from the UI links it in the brief and pushes the link', () => {
  it('commits the PR link on the PR branch in the run worktree and pushes it; no checkout keeps an uncommitted brief', () => {
    saved = { PATH: process.env.PATH, SDLC_WT_BASE: process.env.SDLC_WT_BASE };
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-pr-link-')));
    const main = path.join(root, 'main');
    fs.mkdirSync(main);
    const origin = path.join(root, 'origin.git');
    const wtBase = path.join(root, 'wt');
    const slug = 'task';
    const brief = `${runContext(main).backlogDir}/${slug}/brief.md`;
    // A fake gh: no PR yet, `pr create` prints the URL.
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr create" ]; then echo ${PR}; exit 0; fi\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.SDLC_WT_BASE = wtBase;

    spawnSync('git', ['init', '-q', '--bare', origin]);
    spawnSync('git', ['init', '-q', '-b', 'main', main]);
    git(main, 'config', 'user.email', 't@example.com');
    git(main, 'config', 'user.name', 'T');
    git(main, 'remote', 'add', 'origin', origin);
    fs.mkdirSync(path.join(main, path.dirname(brief)), { recursive: true });
    fs.writeFileSync(path.join(main, brief), `# ${slug}\n\nBody.\n`);
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'push', '-q', '-u', 'origin', 'main');
    const wt = path.join(wtBase, slug);
    git(main, 'worktree', 'add', '-q', '-b', `sdlc/${slug}`, wt);
    git(wt, 'push', '-q', '-u', 'origin', `sdlc/${slug}`);

    const res = createPrForCompleted(runContext(main), slug);

    expect([res.ok, res.pr, res.err]).toEqual([true, PR, []]);
    // Committed on the PR branch and pushed.
    expect(git(wt, 'status', '--porcelain')).toBe('');
    expect(git(wt, 'log', '-1', '--format=%s')).toBe(`chore(${slug}): link pull request`);
    expect(git(origin, 'show', `sdlc/${slug}:${brief}`)).toContain(`pr: ${PR}`);
    expect(git(origin, 'rev-parse', `sdlc/${slug}`)).toBe(git(wt, 'rev-parse', 'HEAD'));
    // The main checkout is not edited.
    expect(git(main, 'status', '--porcelain')).toBe('');
  });
});
