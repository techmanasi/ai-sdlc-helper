import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { Git } from '../src/pipeline/git.js';
import { snapshot } from '../src/changes/index.js';
import {
  finalise, getPrFromBrief, recordPrInBrief,
} from '../src/pipeline/finalise.js';
import {
  archiveCompleted, archiveTask, unarchiveTask,
} from '../src/backlog/archive.js';
import { backlogItems } from '../src/backlog/index.js';
import {
  listCompletedTasks, getCompletedTaskDetail, isArchivedInIndex,
} from '../src/runs/completed.js';
import { runContext } from '../src/runs/index.js';
import { main } from '../src/cli/main.js';
import { tmp } from './helpers.js';

function gitCmd(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function makeRepo(dir: string, slug = 'task-one') {
  gitCmd(dir, 'init', '-q', '-b', 'main');
  gitCmd(dir, 'config', 'user.name', 'test');
  gitCmd(dir, 'config', 'user.email', 'test@example.com');
  fs.mkdirSync(path.join(dir, 'Docs/backlog', slug), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Docs/backlog/index.md'), `# Backlog\n\n- [ ] \`${slug}\` - Feature: Test task\n`);
  fs.writeFileSync(path.join(dir, 'Docs/backlog', slug, 'brief.md'), `# ${slug}\n\nType: feature\nPriority: P1\n`);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test\n');
  gitCmd(dir, 'add', '-A');
  gitCmd(dir, 'commit', '-q', '-m', 'initial commit');
  return dir;
}

describe('Finalise stage & PR workflow', () => {
  test('getPrFromBrief and recordPrInBrief handle YAML frontmatter and body links', () => {
    const briefWithFm = `---
pr: https://github.com/org/repo/pull/42
---

# task-one
Type: feature
`;
    expect(getPrFromBrief(briefWithFm)).toBe('https://github.com/org/repo/pull/42');

    const briefWithoutFm = `# task-two\nType: bug\n`;
    expect(getPrFromBrief(briefWithoutFm)).toBeNull();

    const updated = recordPrInBrief(briefWithoutFm, 'https://github.com/org/repo/pull/100');
    expect(getPrFromBrief(updated)).toBe('https://github.com/org/repo/pull/100');
    expect(updated).toContain('pr: https://github.com/org/repo/pull/100');

    // Updating existing PR
    const updatedAgain = recordPrInBrief(updated, 'https://github.com/org/repo/pull/200');
    expect(getPrFromBrief(updatedAgain)).toBe('https://github.com/org/repo/pull/200');
  });

  test('finalise commits changes, ticks backlog, and records PR when enabled', () => {
    const repo = makeRepo(tmp('finalise-test-'));
    const git = new Git(repo);
    const slug = 'task-one';
    const docs = `Docs/backlog/${slug}`;
    const log = `${docs}/logs`;
    fs.mkdirSync(path.join(repo, log), { recursive: true });
    const baseline = `${log}/baseline.json`;
    snapshot(path.join(repo, baseline), { root: repo });

    // Make code changes
    fs.writeFileSync(path.join(repo, 'new-feature.js'), 'export const hello = "world";\n');

    let out = '';
    let err = '';
    const res = finalise({
      git,
      slug,
      docs,
      baseline,
      backlog: 'Docs/backlog/index.md',
      createPr: false,
      out: l => { out += `${l}\n`; },
      err: l => { err += `${l}\n`; },
    });

    expect(res.committed).toBe(1);
    expect(err).toBe('');
    expect(out).toContain(`DONE: ${slug} on main. Committed 1 file(s)`);
    // Backlog item ticked
    const indexText = fs.readFileSync(path.join(repo, 'Docs/backlog/index.md'), 'utf8');
    expect(indexText).toContain(`- [x] \`${slug}\``);
    // Skips file generated
    expect(fs.existsSync(path.join(repo, log, 'finalise-skipped.md'))).toBe(true);
  });
});

describe('Task Archiving in Docs/backlog/index.md', () => {
  test('archiveTask moves an active item into ## Archive and unarchive moves it back', () => {
    const repo = makeRepo(tmp('archive-test-'));
    const place = { root: repo, backlogDir: 'Docs/backlog' };
    const indexFile = path.join(repo, 'Docs/backlog/index.md');

    // Initially active
    expect(isArchivedInIndex(fs.readFileSync(indexFile, 'utf8'), 'task-one')).toBe(false);

    // Archive it
    const ok = archiveTask(place, 'task-one');
    expect(ok).toBe(true);

    const archivedText = fs.readFileSync(indexFile, 'utf8');
    expect(archivedText).toContain('## Archive');
    expect(archivedText).toContain('- [x] `task-one`');
    expect(isArchivedInIndex(archivedText, 'task-one')).toBe(true);

    // Verify backlog parsing keeps the item and marks it archived
    const parsed = backlogItems({ root: repo, backlogDir: 'Docs/backlog', branchPrefix: 'sdlc/' });
    expect(parsed?.items.length).toBe(1);
    expect(parsed?.items[0].slug).toBe('task-one');
    expect(parsed?.items[0].archived).toBe(true);

    // Unarchive
    const unok = unarchiveTask(place, 'task-one');
    expect(unok).toBe(true);

    const unarchivedText = fs.readFileSync(indexFile, 'utf8');
    expect(isArchivedInIndex(unarchivedText, 'task-one')).toBe(false);
  });

  test('archiveCompleted archives completed tasks and respects olderThanDays', () => {
    const repo = makeRepo(tmp('archive-bulk-'));
    const place = { root: repo, backlogDir: 'Docs/backlog' };
    const indexFile = path.join(repo, 'Docs/backlog/index.md');

    // Add multiple items: one pending, two completed
    fs.writeFileSync(indexFile, `# Backlog\n\n- [ ] \`pending-1\` - Feature: P\n- [x] \`done-1\` - Feature: D1\n- [x] \`done-2\` - Feature: D2\n`);
    fs.mkdirSync(path.join(repo, 'Docs/backlog/done-1'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'Docs/backlog/done-2'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'Docs/backlog/done-1/brief.md'), '# d1\n');
    fs.writeFileSync(path.join(repo, 'Docs/backlog/done-2/brief.md'), '# d2\n');

    const res = archiveCompleted(place, { all: true });
    expect(res.count).toBe(2);
    expect(res.archived).toEqual(['done-1', 'done-2']);

    const text = fs.readFileSync(indexFile, 'utf8');
    expect(text).toContain('- [ ] `pending-1`');
    expect(text).toContain('## Archive\n\n- [x] `done-1`');
    expect(text).toContain('- [x] `done-2`');
  });

  test('CLI archive and unarchive commands work as expected', async () => {
    const repo = makeRepo(tmp('archive-cli-'));
    let out = '';
    let err = '';
    const io = { out: s => { out += s; }, err: s => { err += s; }, cwd: repo };

    const code = await main(['archive', 'task-one'], io);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toContain('Archived task-one');

    out = '';
    const unCode = await main(['unarchive', 'task-one'], io);
    expect(unCode).toBe(0);
    expect(out).toContain('Unarchived task-one');
  });
});

describe('Resilient Completed Tasks view', () => {
  test('listCompletedTasks and getCompletedTaskDetail work directly from git without .git/sdlc-runs', () => {
    const repo = makeRepo(tmp('completed-resilient-'));
    const slug = 'feature-foo';
    const branch = `sdlc/${slug}`;

    // Create branch and make commits on it
    gitCmd(repo, 'checkout', '-q', '-b', branch);
    fs.writeFileSync(path.join(repo, 'foo.ts'), 'export const foo = 1;\n');
    gitCmd(repo, 'add', 'foo.ts');
    gitCmd(repo, 'commit', '-q', '-m', `feat(${slug}): implement foo`);

    // Switch back to main and mark in index
    gitCmd(repo, 'checkout', '-q', 'main');
    fs.mkdirSync(path.join(repo, 'Docs/backlog', slug), { recursive: true });
    fs.writeFileSync(path.join(repo, 'Docs/backlog', slug, 'brief.md'), `---\npr: https://github.com/example/repo/pull/77\n---\n\n# ${slug}\nType: feature\n`);
    fs.appendFileSync(path.join(repo, 'Docs/backlog/index.md'), `- [x] \`${slug}\` - Feature: Foo feature\n`);
    gitCmd(repo, 'add', '-A');
    gitCmd(repo, 'commit', '-q', '-m', `chore: finish ${slug}`);

    // Create a context where .git/sdlc-runs has NO records at all
    const ctx = runContext(repo);
    expect(fs.existsSync(path.join(ctx.reg, `${slug}.json`))).toBe(false);

    // List completed tasks derives info cleanly
    const completed = listCompletedTasks(ctx);
    const task = completed.find(t => t.slug === slug);
    expect(task).toBeDefined();
    expect(task?.pr).toBe('https://github.com/example/repo/pull/77');
    expect(task?.branch).toBe(branch);

    // Detail derives commits and diff directly from git
    const detail = getCompletedTaskDetail(ctx, slug);
    expect(detail.slug).toBe(slug);
    expect(detail.pr).toBe('https://github.com/example/repo/pull/77');
    expect(detail.commits.length).toBeGreaterThan(0);
    expect(detail.commits[0].message).toContain(`feat(${slug})`);
    expect(detail.files.some(f => f.path === 'foo.ts')).toBe(true);
  });
});
