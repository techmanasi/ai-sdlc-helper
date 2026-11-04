import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SETUP_BRANCH = 'chore/sdlc-setup';

const run = (program: string, cwd: string, args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(program, args, { cwd, encoding: 'utf8', env });
const git = (root: string, args: string[], env: NodeJS.ProcessEnv) => run('git', root, args, env);
const failure = (r: { stderr: string; stdout: string }) => ((r.stderr || r.stdout).trim().split('\n')[0] ?? '');

/** The branch the setup branch starts from: local main, then master, then the one origin/HEAD points to; null when none exists. */
export function setupBase(root: string, env: NodeJS.ProcessEnv): string | null {
  const has = (ref: string) => git(root, ['rev-parse', '--verify', '-q', `refs/heads/${ref}`], env).status === 0;
  for (const b of ['main', 'master']) if (has(b)) return b;
  const head = git(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], env).stdout.trim().replace(/^origin\//, '');
  return head && has(head) ? head : null;
}

/** chore/sdlc-setup, or the first of chore/sdlc-setup-2, -3, ... that no local branch uses. */
export function freeBranch(root: string, env: NodeJS.ProcessEnv): string {
  const taken = (b: string) => git(root, ['rev-parse', '--verify', '-q', `refs/heads/${b}`], env).status === 0;
  if (!taken(SETUP_BRANCH)) return SETUP_BRANCH;
  let n = 2;
  while (taken(`${SETUP_BRANCH}-${n}`)) n++;
  return `${SETUP_BRANCH}-${n}`;
}

export interface SetupCommit { branch: string; base: string; sha: string }

/**
 * Commits <files> (paths inside <root>) on a new setup branch started from the base branch. The work happens in a temporary
 * worktree, so the checked out branch, the index and the working tree are not touched. Throws Error with the git message.
 * Returns null when there is no base branch to start from.
 */
export function commitOnSetupBranch(root: string, files: string[], env: NodeJS.ProcessEnv): SetupCommit | null {
  const base = setupBase(root, env);
  if (!base) return null;
  const branch = freeBranch(root, env);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-sdlc-setup-'));
  const wt = path.join(tmp, 'wt');
  try {
    const add = git(root, ['worktree', 'add', '-q', '-b', branch, wt, base], env);
    if (add.status !== 0) throw new Error(`git worktree add: ${failure(add)}`);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(wt, f));
    }
    const staged = git(wt, ['add', '--', ...files], env);
    if (staged.status !== 0) throw new Error(`git add: ${failure(staged)}`);
    const c = git(wt, ['commit', '-q', '-m', `chore: setup ai-sdlc-helper (${files.join(', ')})`, '--', ...files], env);
    if (c.status !== 0) throw new Error(`git commit: ${failure(c)}`);
    return { branch, base, sha: git(wt, ['rev-parse', '--short', 'HEAD'], env).stdout.trim() };
  } finally {
    git(root, ['worktree', 'remove', '--force', wt], env);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Pushes <branch> to origin and sets its upstream. Throws Error with the git message. */
export function pushBranch(root: string, branch: string, env: NodeJS.ProcessEnv): void {
  const r = git(root, ['push', '-q', '-u', 'origin', branch], env);
  if (r.status !== 0) throw new Error(`git push: ${failure(r)}`);
}

/** True when the gh CLI is installed and logged in. */
export const ghReady = (root: string, env: NodeJS.ProcessEnv): boolean => {
  const r = run('gh', root, ['auth', 'status'], env);
  return !r.error && r.status === 0;
};

/** Opens a pull request from <branch> into <base> and returns its URL. Throws Error with the gh message. */
export function openPullRequest(root: string, branch: string, base: string, files: string[], env: NodeJS.ProcessEnv): string {
  const body = `Adds ${files.join(', ')}.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
  const r = run('gh', root, ['pr', 'create', '--base', base, '--head', branch, '--title', 'chore: setup ai-sdlc-helper', '--body', body], env);
  if (r.status !== 0) throw new Error(`gh pr create: ${failure(r)}`);
  return r.stdout.trim().split('\n').pop() ?? '';
}
