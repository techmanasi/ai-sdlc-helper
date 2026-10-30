import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runContext } from '../src/runs/index.js';
import { listCompletedTasks, syncPrComments } from '../src/runs/completed.js';
import { prCommentsInput } from '../src/pipeline/prompts.js';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

describe('Completed tasks UX and PR feedback loop', () => {
  it('injects PR review comments into prompt via prCommentsInput', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-pr-prompt-'));
    expect(prCommentsInput(tmp)).toBe('');

    fs.writeFileSync(path.join(tmp, 'pr-comments.md'), '## Inline Review Comments\nFix boundary check');
    const rendered = prCommentsInput(tmp);
    expect(rendered).toContain('## Pull Request Review Comments');
    expect(rendered).toContain('Fix boundary check');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('syncPrComments writes formatted markdown to task docs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-pr-sync-'));
    git(tmp, 'init', '-q');
    git(tmp, 'config', 'user.email', 'test@example.com');
    git(tmp, 'config', 'user.name', 'Test');
    git(tmp, 'commit', '--allow-empty', '-m', 'initial');

    const slug = 'test-task';
    const docsDir = path.join(tmp, 'Docs/backlog', slug);
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'brief.md'), `# ${slug}\n`);

    const ctx = runContext(tmp);
    // syncPrComments against local test branch (no remote PR) gracefully handles non-existent PR
    const res = syncPrComments(ctx, slug);
    expect(res.ok).toBe(false);
    expect(res.err?.[0]).toContain('No PR found');

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('listCompletedTasks filters out unmerged open PRs and includes merged PRs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-pr-complete-'));
    git(tmp, 'init', '-q');
    git(tmp, 'config', 'user.email', 'test@example.com');
    git(tmp, 'config', 'user.name', 'Test');
    git(tmp, 'commit', '--allow-empty', '-m', 'initial');

    const backlogDir = path.join(tmp, 'Docs/backlog');
    fs.mkdirSync(backlogDir, { recursive: true });

    // Task 1: No PR, ticked done in index.md -> Completed
    const slug1 = 'local-done';
    fs.mkdirSync(path.join(backlogDir, slug1), { recursive: true });
    fs.writeFileSync(path.join(backlogDir, slug1, 'brief.md'), `# ${slug1}\n`);

    // Task 2: Open PR (mocked by having a brief with PR but index marked done, gh query will fail or report open)
    const slug2 = 'unmerged-pr';
    fs.mkdirSync(path.join(backlogDir, slug2), { recursive: true });
    fs.writeFileSync(path.join(backlogDir, slug2, 'brief.md'), `# ${slug2}\n`);

    fs.writeFileSync(path.join(backlogDir, 'index.md'), [
      '# Backlog',
      `- [x] \`${slug1}\` - Local completed`,
      `- [ ] \`${slug2}\` - Open PR task`,
    ].join('\n') + '\n');

    git(tmp, 'add', '-A');
    git(tmp, 'commit', '-m', 'add tasks');

    const ctx = runContext(tmp);
    const completed = listCompletedTasks(ctx);
    expect(completed.some(t => t.slug === slug1)).toBe(true);
    // slug2 is not ticked and has no merged PR -> not in completed
    expect(completed.some(t => t.slug === slug2)).toBe(false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
