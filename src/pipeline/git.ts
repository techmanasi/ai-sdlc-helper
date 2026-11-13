// Git for a pipeline run: the branch, the test-file guards, and staging, restoring and fingerprinting files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from '../trace.js';

/** A git command that failed: its arguments and what git said. */
export class GitError extends Error {}

/** Git in one checkout, with the run's environment. */
export class Git {
  constructor(readonly root: string, readonly env: NodeJS.ProcessEnv = process.env) {}

  /** Runs git; throws GitError (with git's message) when it fails. */
  run(...args: string[]): string {
    try {
      return execFileSync('git', args, { cwd: this.root, env: this.env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message: string };
      throw new GitError(`git ${args.join(' ')} failed: ${String(err.stderr || err.stdout || err.message).trim()}`);
    }
  }

  /** Like run, but gives up after <timeoutMs> (a fetch from a remote that does not answer). */
  runTimeout(timeoutMs: number, ...args: string[]): string {
    try {
      return execFileSync('git', args, { cwd: this.root, env: this.env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message: string };
      throw new GitError(`git ${args.join(' ')} failed: ${String(err.stderr || err.stdout || err.message).trim()}`);
    }
  }

  /** Runs git; null when it fails. */
  tryRun(...args: string[]): string | null {
    try { return this.run(...args); } catch { return null; }
  }

  lines(...args: string[]): string[] {
    return this.run(...args).split('\n').filter(Boolean);
  }

  head(): string {
    return this.run('rev-parse', 'HEAD').trim();
  }

  /** Switches to <branch>, creating it from HEAD when it does not exist. */
  checkoutBranch(branch: string): void {
    if (this.tryRun('rev-parse', '--verify', branch) !== null) this.run('checkout', '-q', branch);
    else this.run('checkout', '-q', '-b', branch);
  }

  /** The newest commit (full sha, or empty) whose message matches any of <patterns> (git --grep). */
  findCommit(patterns: string[], format = '%H'): string {
    return this.run('log', `--format=${format}`, '-1', ...patterns.map(p => `--grep=${p}`)).trim();
  }

  /** Test files changed (tracked) since <sha>. */
  testsChangedSince(sha: string, specs: string[]): string[] {
    return this.lines('diff', '--name-only', sha, '--', ...specs);
  }

  /** Stages every changed, new or deleted test file. */
  addTests(specs: string[]): void {
    const files = [...new Set(this.lines('ls-files', '-m', '-o', '-d', '--exclude-standard', '--', ...specs))].sort();
    for (const f of files) this.run('add', '-A', '--', f);
  }

  /** Every test file as it was at <sha>: one that did not exist then is removed, untracked ones are cleaned. */
  restoreTests(sha: string, specs: string[]): void {
    for (const f of this.lines('diff', '--name-only', sha, '--', ...specs)) {
      if (this.tryRun('cat-file', '-e', `${sha}:${f}`) !== null) this.run('checkout', '-q', sha, '--', f);
      else fs.rmSync(path.join(this.root, f), { force: true });
    }
    this.run('clean', '-fdq', '--', ...specs);
  }

  /** A fingerprint of the source (the suites' folders without their tests and the backlog), to see whether it changed. */
  sourceHash(sourceDirs: string[], specs: string[], backlogDir: string): string {
    const spec = [...sourceDirs, ...specs.map(d => (d.startsWith(':(glob)') ? `:(exclude,glob)${d.slice(':(glob)'.length)}` : `:(exclude)${d}`)), `:(exclude)${backlogDir}`];
    return crypto.createHash('sha1').update(this.run('diff', '--', ...spec)).update(this.run('status', '--porcelain', '--', ...spec)).digest('hex');
  }
}
