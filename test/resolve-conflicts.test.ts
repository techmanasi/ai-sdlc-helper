// Resolve conflicts on real git repositories in temp folders: a bare "origin", the run's clone on its branch, and another
// clone that moves main (or the PR branch) meanwhile.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test, vi } from 'vitest';
import { Git } from '../src/pipeline/git.js';
import {
  adoptAttempt, failingTestFiles, isDocFile, mergeFailureText, nextFollowUpSlug, outcomeLines, parseResolverReport, parseTestsLog, plainStop, resolveConflicts, reviewSkipped, reviewVerdict, reviewerCount, sharedReviewers, sharedReviewersText, unanimouslySafe, type CodeConflict, type ResolveOptions,
} from '../src/pipeline/resolve-conflicts.js';
import { tmp, write } from './helpers.js';

const ENV: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const BRANCH = 'sdlc/task';

const g = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const setup = (dir: string) => {
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null'], ['gc.auto', '0']]) g(dir, 'config', k, v);
};
const commit = (dir: string, files: Record<string, string>, msg: string): string => {
  for (const [f, t] of Object.entries(files)) write(dir, f, t);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', msg);
  return g(dir, 'rev-parse', 'HEAD');
};
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');

/** Git that remembers every command, to prove which pushes were made. */
class RecordingGit extends Git {
  calls: string[][] = [];
  run(...args: string[]): string { this.calls.push(args); return super.run(...args); }
  pushes(): string[][] { return this.calls.filter(a => a.includes('push')); }
}

const APP = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n';
const NOTES = '# Notes\n\nfirst line\n';
const INDEX = '# Backlog\n\n- [x] `old` - Feature: old\n';

let template = '';
/** Once: origin with main, the run's clone on BRANCH with its red-tests commit, and another clone on main. */
function buildTemplate(): string {
  const root = tmp('sdlc-rc-tpl-');
  const remote = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(root, 'seed');
  g(root, 'clone', '-q', remote, seed);
  setup(seed);
  g(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  commit(seed, { 'src/app.ts': APP, 'docs/notes.md': NOTES, 'docs/backlog/index.md': INDEX }, 'init');
  g(seed, 'push', '-q', 'origin', 'main');
  for (const clone of ['run', 'other']) {
    g(root, 'clone', '-q', remote, path.join(root, clone));
    setup(path.join(root, clone));
  }
  const run = path.join(root, 'run');
  g(run, 'checkout', '-q', '-b', BRANCH);
  commit(run, { 'test/task.test.ts': 'test\n' }, 'test(task): add failing tests and spec/plan docs');
  return root;
}

/** A copy of the template, with the task's commit (<branchFiles>) on BRANCH, pushed. */
function world(branchFiles: Record<string, string> = { 'src/task.ts': 'export const task = true;\n' }) {
  if (!template) template = buildTemplate();
  const root = tmp('sdlc-rc-');
  fs.cpSync(template, root, { recursive: true });
  const remote = path.join(root, 'origin.git');
  const run = path.join(root, 'run');
  const other = path.join(root, 'other');
  for (const clone of [run, other]) g(clone, 'remote', 'set-url', 'origin', remote);
  commit(run, branchFiles, 'feat(task): implement per docs/backlog/task/specs-1.md');
  g(run, 'push', '-q', '-u', 'origin', BRANCH);
  const git = new RecordingGit(run, ENV);
  const remoteSha = () => g(remote, 'rev-parse', BRANCH);
  /** Another task merged into main (the other clone is on main, and only it moves main). */
  const mergeIntoMain = (files: Record<string, string>, msg = 'feat(other): other work (#7)') => {
    const s = commit(other, files, msg);
    g(other, 'push', '-q', 'origin', 'main');
    return s;
  };
  const opts = (o: Partial<ResolveOptions> = {}): ResolveOptions => ({
    git, branch: BRANCH, base: 'main', docDirs: ['docs/backlog'], out: () => {}, recordFile: path.join(root, 'record.json'), ...o,
  });
  return { root, remote, run, other, git, remoteSha, mergeIntoMain, opts };
}

const leasePushes = (git: RecordingGit) => git.pushes();
const noBareForce = (git: RecordingGit) => {
  for (const p of git.pushes()) {
    expect(p).not.toContain('--force');
    expect(p).not.toContain('-f');
    expect(p.filter(a => a.startsWith('--force-with-lease=')).length).toBe(1);
  }
};

describe('resolveConflicts: nothing to do', () => {
  test('a branch that already contains main is left alone: no rebase, no check, no push', async () => {
    const w = world();
    const before = g(w.run, 'rev-parse', 'HEAD');
    const remoteBefore = w.remoteSha();
    const verify = vi.fn(async () => true);
    const r = await resolveConflicts(w.opts({ verify }));
    expect(r.kind).toBe('up-to-date');
    expect(g(w.run, 'rev-parse', 'HEAD')).toBe(before);
    expect(w.remoteSha()).toBe(remoteBefore);
    expect(verify).not.toHaveBeenCalled();
    expect(leasePushes(w.git)).toEqual([]);
    expect(w.git.calls.some(a => a.includes('rebase'))).toBe(false);
  });

  test('no origin remote, or a branch Finalise never pushed: skipped before anything starts', async () => {
    const w = world();
    const onStart = vi.fn();
    g(w.run, 'remote', 'rename', 'origin', 'upstream');
    expect(await resolveConflicts(w.opts({ onStart }))).toMatchObject({ kind: 'skipped' });
    g(w.run, 'remote', 'rename', 'upstream', 'origin');
    g(w.run, 'checkout', '-q', '-b', 'sdlc/unpushed');
    expect(await resolveConflicts(w.opts({ onStart, branch: 'sdlc/unpushed' }))).toMatchObject({ kind: 'skipped' });
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe('resolveConflicts: documentation-only conflicts', () => {
  test('where both sides only added lines are resolved keeping both sides, rebased in a straight line on main, verified and pushed with the lease only', async () => {
    const w = world({ 'docs/notes.md': `${NOTES}the task line\n`, 'docs/backlog/index.md': `${INDEX}- [ ] \`task\` - Feature: task\n`, 'src/task.ts': 'export const task = true;\n' });
    const mainSha = w.mergeIntoMain({ 'docs/notes.md': `${NOTES}the merged line\n`, 'docs/backlog/index.md': `${INDEX}- [ ] \`other\` - Feature: other\n` });
    const remoteBefore = w.remoteSha();
    const resolveCode = vi.fn(async (): Promise<never> => { throw new Error('no agent for docs'); });
    const verify = vi.fn(async () => true);
    const r = await resolveConflicts(w.opts({ resolveCode, verify }));

    expect(r.kind).toBe('pushed');
    if (r.kind !== 'pushed') return;
    expect(resolveCode).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(r.resolved.map(f => [f.file, f.kind]).sort()).toEqual([['docs/backlog/index.md', 'docs'], ['docs/notes.md', 'docs']]);
    // Both sides' content, nothing dropped.
    expect(read(w.run, 'docs/notes.md')).toContain('the merged line');
    expect(read(w.run, 'docs/notes.md')).toContain('the task line');
    expect(read(w.run, 'docs/backlog/index.md')).toContain('`other`');
    expect(read(w.run, 'docs/backlog/index.md')).toContain('`task`');
    // On top of main, no merge commits, and the remote now has exactly the rebased branch.
    expect(g(w.run, 'merge-base', '--is-ancestor', mainSha, 'HEAD')).toBe('');
    expect(g(w.run, 'rev-list', '--merges', `${mainSha}..HEAD`)).toBe('');
    expect(w.remoteSha()).toBe(g(w.run, 'rev-parse', 'HEAD'));
    expect(r.remoteBefore).toBe(remoteBefore);
    // One push, with the lease on the sha fetched before the rebase.
    expect(leasePushes(w.git)).toHaveLength(1);
    expect(leasePushes(w.git)[0]).toContain(`--force-with-lease=${BRANCH}:${remoteBefore}`);
    noBareForce(w.git);
    // Recovery: the shas before the rebase are kept.
    expect(g(w.run, 'rev-parse', `refs/sdlc-backup/${BRANCH}/remote`)).toBe(remoteBefore);
    expect(JSON.parse(read(w.root, 'record.json'))).toMatchObject({ branch: BRANCH, remoteSha: remoteBefore, upstream: mainSha });
  });

  test('where both sides changed the same lines go to the resolver, which keeps the document\'s structure; the rest of the commit is still kept both', async () => {
    const w = world({ 'docs/notes.md': '# Notes\n\nthe task line\n', 'docs/backlog/index.md': `${INDEX}- [ ] \`task\` - Feature: task\n` });
    w.mergeIntoMain({ 'docs/notes.md': '# Notes\n\nthe merged line\n', 'docs/backlog/index.md': `${INDEX}- [ ] \`other\` - Feature: other\n` });
    const resolveCode = vi.fn(async (c: CodeConflict) => {
      expect(c.files).toEqual(['docs/notes.md']);
      expect(c.docs).toEqual(['docs/backlog/index.md']);
      write(w.run, 'docs/notes.md', '# Notes\n\n- the merged line\n- the task line\n');
      return { safe: true, files: [{ file: 'docs/notes.md', why: 'merged the two lines as a list' }] };
    });
    const r = await resolveConflicts(w.opts({ resolveCode, verify: async () => true }));
    expect(r.kind).toBe('pushed');
    if (r.kind !== 'pushed') return;
    expect(resolveCode).toHaveBeenCalledTimes(1);
    expect(read(w.run, 'docs/notes.md')).toBe('# Notes\n\n- the merged line\n- the task line\n');
    expect(r.resolved.map(f => [f.file, f.kind, f.why]).sort()).toEqual([
      ['docs/backlog/index.md', 'docs', "documentation: kept both sides' content"],
      ['docs/notes.md', 'docs', 'merged the two lines as a list'],
    ]);
  });

  test('main moved but nothing conflicts (the user resolved it, or the work is apart): success with nothing changed, no check, no push', async () => {
    const w = world();
    w.mergeIntoMain({ 'src/elsewhere.ts': 'export const x = 1;\n' });
    const before = g(w.run, 'rev-parse', 'HEAD');
    const remoteBefore = w.remoteSha();
    const verify = vi.fn(async () => true);
    const onStart = vi.fn();
    const r = await resolveConflicts(w.opts({ verify, onStart }));
    expect(r).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('no conflicts') });
    expect(onStart).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(g(w.run, 'rev-parse', 'HEAD')).toBe(before);
    expect(w.remoteSha()).toBe(remoteBefore);
    expect(leasePushes(w.git)).toEqual([]);
  });

  test('an already merged PR is success before anything starts', async () => {
    const w = world();
    w.mergeIntoMain({ 'docs/notes.md': 'changed\n' });
    const onStart = vi.fn();
    const r = await resolveConflicts(w.opts({ onStart, mergedReason: () => 'the pull request is already merged' }));
    expect(r).toEqual({ kind: 'skipped', reason: 'the pull request is already merged' });
    expect(onStart).not.toHaveBeenCalled();
    expect(leasePushes(w.git)).toEqual([]);
  });

  test('the PR link Finalise stamps into the brief (uncommitted) does not stop the stage, and is back after it', async () => {
    const brief = 'docs/backlog/task/brief.md';
    const w = world({ 'docs/notes.md': '# Notes\n\nthe task line\n', [brief]: '# task\n\nBody.\n' });
    const header = '---\npr: https://github.com/o/r/pull/1\n---\n\n';
    fs.writeFileSync(path.join(w.run, brief), `${header}# task\n\nBody.\n`);
    const mainSha = w.mergeIntoMain({ 'docs/notes.md': '# Notes\n\nthe merged line\n' });
    const r = await resolveConflicts(w.opts({ verify: async () => true }));
    expect(r).toMatchObject({ kind: 'pushed', pushes: 1 });
    expect(g(w.remote, 'merge-base', '--is-ancestor', mainSha, BRANCH)).toBe('');
    expect(read(w.run, brief)).toBe(`${header}# task\n\nBody.\n`);
    expect(g(w.remote, 'show', `${BRANCH}:${brief}`)).not.toContain('pr:');
  });

  test('any other uncommitted change still stops the stage before it touches anything', async () => {
    const w = world({ 'docs/notes.md': '# Notes\n\nthe task line\n', 'src/task.ts': 'export const task = true;\n' });
    w.mergeIntoMain({ 'docs/notes.md': '# Notes\n\nthe merged line\n' });
    fs.writeFileSync(path.join(w.run, 'src/task.ts'), 'export const task = false;\n');
    const before = g(w.run, 'rev-parse', 'HEAD');
    const r = await resolveConflicts(w.opts({ verify: async () => true }));
    expect(r).toMatchObject({ kind: 'stopped' });
    expect(g(w.run, 'rev-parse', 'HEAD')).toBe(before);
    expect(read(w.run, 'src/task.ts')).toBe('export const task = false;\n');
    expect(leasePushes(w.git)).toEqual([]);
  });
});

describe('resolveConflicts: code conflicts', () => {
  const conflicting = () => {
    const w = world({ 'src/app.ts': APP.replace('b = 2', 'b = 20 // the task') });
    w.mergeIntoMain({ 'src/app.ts': APP.replace('b = 2', 'b = 200 // merged work') });
    return w;
  };

  test('a doubt stops the stage, reports both sides, and neither pushes nor leaves the branch rewritten', async () => {
    const w = conflicting();
    const before = g(w.run, 'rev-parse', 'HEAD');
    const remoteBefore = w.remoteSha();
    let seen: CodeConflict | null = null;
    const r = await resolveConflicts(w.opts({
      resolveCode: async c => { seen = c; return { safe: false, files: [], doubt: 'b is 20 for the task and 200 for the merged work' }; },
      verify: async () => true,
    }));
    expect(r.kind).toBe('stopped');
    if (r.kind !== 'stopped') return;
    expect(r.offer).toBe(true);
    expect(seen!.files).toEqual(['src/app.ts']);
    expect(seen!.commit.subject).toBe('feat(task): implement per docs/backlog/task/specs-1.md');
    expect(r.conflict).toMatchObject({ files: ['src/app.ts'], doubt: 'b is 20 for the task and 200 for the merged work' });
    expect(r.conflict!.sides[0].base).toContain('b = 200 // merged work');
    expect(r.conflict!.sides[0].task).toContain('b = 20 // the task');
    // Nothing pushed, nothing rewritten, no rebase left behind.
    expect(leasePushes(w.git)).toEqual([]);
    expect(w.remoteSha()).toBe(remoteBefore);
    expect(g(w.run, 'rev-parse', 'HEAD')).toBe(before);
    expect(g(w.run, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(fs.existsSync(path.join(w.run, '.git', 'rebase-merge'))).toBe(false);
  });

  test('without a resolver, or with markers left, the stage stops the same way', async () => {
    const w = conflicting();
    const remoteBefore = w.remoteSha();
    expect(await resolveConflicts(w.opts())).toMatchObject({ kind: 'stopped', offer: true });
    const marked = await resolveConflicts(w.opts({ resolveCode: async () => ({ safe: true, files: [{ file: 'src/app.ts', why: 'kept both' }] }) }));
    expect(marked).toMatchObject({ kind: 'stopped', offer: true, reason: 'conflict markers left in src/app.ts' });
    expect(w.remoteSha()).toBe(remoteBefore);
    expect(leasePushes(w.git)).toEqual([]);
  });

  test('a safe resolution is verified, pushed with the lease, and explained per file', async () => {
    const w = conflicting();
    const remoteBefore = w.remoteSha();
    const verify = vi.fn(async (o: { codeResolved: boolean }) => o.codeResolved);
    const r = await resolveConflicts(w.opts({
      resolveCode: async c => {
        fs.writeFileSync(path.join(w.run, c.files[0]), APP.replace('b = 2', 'b = 200 // merged work\nexport const bTask = 20; // the task'));
        return { safe: true, files: [{ file: 'src/app.ts', why: 'kept main\'s b and the task\'s value as bTask' }] };
      },
      verify,
    }));
    expect(r).toMatchObject({ kind: 'pushed', pushes: 1, resolved: [{ file: 'src/app.ts', kind: 'code', why: 'kept main\'s b and the task\'s value as bTask' }] });
    expect(verify).toHaveBeenCalledWith({ codeResolved: true });
    expect(g(w.remote, 'show', `${BRANCH}:src/app.ts`)).toContain('bTask = 20');
    expect(leasePushes(w.git)[0]).toContain(`--force-with-lease=${BRANCH}:${remoteBefore}`);
    noBareForce(w.git);
  });

  test('a failing check after the resolution stops without pushing and keeps the attempt', async () => {
    const w = conflicting();
    const before = g(w.run, 'rev-parse', 'HEAD');
    const remoteBefore = w.remoteSha();
    const r = await resolveConflicts(w.opts({
      resolveCode: async c => { fs.writeFileSync(path.join(w.run, c.files[0]), APP); return { safe: true, files: [] }; },
      verify: async () => false,
    }));
    // A failed check is not a conflict the user can answer for: no follow-up item is offered, a retry is the next step.
    expect(r).toMatchObject({ kind: 'stopped', offer: false, checkFailed: true, attempt: `refs/sdlc-attempt/${BRANCH}` });
    expect(g(w.run, 'rev-parse', 'HEAD')).toBe(before);
    expect(w.remoteSha()).toBe(remoteBefore);
    expect(leasePushes(w.git)).toEqual([]);
  });
});

describe('resolveConflicts: the lease', () => {
  test('fails when someone pushed meanwhile; what arrived is fetched, taken onto the rebased branch, and pushed with a new lease', async () => {
    const w = world({ 'docs/notes.md': '# Notes\n\nthe task line\n', 'src/task.ts': 'export const task = true;\n' });
    const mainSha = w.mergeIntoMain({ 'docs/notes.md': '# Notes\n\nthe merged line\n' });
    const remoteBefore = w.remoteSha();
    let arrived = '';
    // The check runs after the rebase and before the push: a reviewer pushes a fix to the PR branch then.
    const verify = vi.fn(async () => {
      if (!arrived) {
        g(w.other, 'fetch', '-q', 'origin');
        g(w.other, 'checkout', '-q', '-b', 'pr', `origin/${BRANCH}`);
        arrived = commit(w.other, { 'src/review-fix.ts': 'export const fix = 1;\n' }, 'fix(task): reviewer fix');
        g(w.other, 'push', '-q', 'origin', `pr:${BRANCH}`);
      }
      return true;
    });
    const r = await resolveConflicts(w.opts({ verify }));
    expect(r).toMatchObject({ kind: 'pushed', pushes: 2, arrived: [arrived] });
    // The first push was refused by the lease, the second leased on what arrived.
    const pushes = leasePushes(w.git);
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toContain(`--force-with-lease=${BRANCH}:${remoteBefore}`);
    expect(pushes[1]).toContain(`--force-with-lease=${BRANCH}:${arrived}`);
    noBareForce(w.git);
    // Nobody's work is lost: main, the task and the reviewer's fix are all on the remote branch.
    expect(g(w.remote, 'merge-base', '--is-ancestor', mainSha, BRANCH)).toBe('');
    expect(g(w.remote, 'show', `${BRANCH}:src/review-fix.ts`)).toContain('fix = 1');
    expect(g(w.remote, 'show', `${BRANCH}:src/task.ts`)).toContain('task = true');
    expect(verify).toHaveBeenCalledTimes(2);
  });

  test('stops without overwriting when what arrived conflicts with the rebased branch', async () => {
    const w = world({ 'docs/notes.md': '# Notes\n\nthe task line\n', 'src/app.ts': APP.replace('c = 3', 'c = 30') });
    w.mergeIntoMain({ 'docs/notes.md': '# Notes\n\nthe merged line\n', 'src/app.ts': APP.replace('a = 1', 'a = 10') });
    const before = g(w.run, 'rev-parse', 'HEAD');
    let arrived = '';
    const r = await resolveConflicts(w.opts({
      verify: async () => {
        if (!arrived) {
          g(w.other, 'fetch', '-q', 'origin');
          g(w.other, 'checkout', '-q', '-b', 'pr', `origin/${BRANCH}`);
          arrived = commit(w.other, { 'src/app.ts': APP.replace('a = 1', 'a = 99').replace('c = 3', 'c = 30') }, 'fix(task): reviewer a');
          g(w.other, 'push', '-q', 'origin', `pr:${BRANCH}`);
        }
        return true;
      },
    }));
    expect(r).toMatchObject({ kind: 'stopped' });
    expect(w.remoteSha()).toBe(arrived);
    expect(g(w.run, 'rev-parse', 'HEAD')).toBe(before);
    expect(leasePushes(w.git)).toHaveLength(1);
    noBareForce(w.git);
  });
});

describe('follow-up item numbering', () => {
  test('<slug>-resolve-conflict-N takes one above the highest number any folder or index entry uses', () => {
    const a = tmp('sdlc-fu-');
    const b = tmp('sdlc-fu-');
    expect(nextFollowUpSlug([a], 'docs/backlog', 'task')).toBe('task-resolve-conflict-1');
    fs.mkdirSync(path.join(a, 'docs/backlog/task-resolve-conflict-1'), { recursive: true });
    expect(nextFollowUpSlug([a], 'docs/backlog', 'task')).toBe('task-resolve-conflict-2');
    write(a, 'docs/backlog/index.md', '# Backlog\n\n- [x] `task-resolve-conflict-3` - Bug: x\n- [ ] `task-resolve-conflict-1-more` - Bug: not ours\n- [ ] `other-task-resolve-conflict-9` - Bug: not ours\n');
    fs.mkdirSync(path.join(a, 'docs/backlog/task-x-resolve-conflict-7'), { recursive: true });
    expect(nextFollowUpSlug([a], 'docs/backlog', 'task')).toBe('task-resolve-conflict-4');
    // Every checkout counts (the main one and the run's worktree).
    fs.mkdirSync(path.join(b, 'docs/backlog/task-resolve-conflict-5'), { recursive: true });
    expect(nextFollowUpSlug([a, b], 'docs/backlog', 'task')).toBe('task-resolve-conflict-6');
    expect(nextFollowUpSlug([a, b], 'docs/backlog', 'other-task')).toBe('other-task-resolve-conflict-10');
  });
});

describe('helpers', () => {
  test('documentation files: docs/, the backlog folder and Markdown; everything else is code', () => {
    expect(['docs/a.ts', 'README.md', 'work/items/x/brief.txt', 'src/guide.mdx'].map(f => isDocFile(f, ['work/items']))).toEqual([true, true, true, true]);
    expect(['src/a.ts', 'test/a.test.ts', 'docsy/a.ts', 'work/itemsx/a.ts'].map(f => isDocFile(f, ['work/items']))).toEqual([false, false, false, false]);
  });

  test('the resolver report: SAFE only with no doubt; a missing verdict is a doubt', () => {
    expect(parseResolverReport('FILE: src/a.ts :: kept both\nVERDICT: SAFE\n')).toEqual({ safe: true, files: [{ file: 'src/a.ts', why: 'kept both' }], doubt: undefined });
    expect(parseResolverReport('VERDICT: DOUBT\nDOUBT: which b wins?\n')).toMatchObject({ safe: false, doubt: 'which b wins?' });
    expect(parseResolverReport('VERDICT: SAFE\nDOUBT: hmm\n').safe).toBe(false);
    expect(parseResolverReport('')).toMatchObject({ safe: false, doubt: 'the resolver wrote no verdict' });
  });
});

describe('a stop in plain words', () => {
  const resolved = [{ file: 'src/a.ts', commit: 'abc1234', kind: 'code' as const, why: 'kept both' }, { file: 'src/b.ts', commit: 'abc1234', kind: 'code' as const, why: 'kept both' }];
  const stop = (o: Record<string, unknown>) => ({ kind: 'stopped' as const, reason: 'the check failed on the rebased branch', offer: false, resolved, ...o });

  test('a failed check says what failed, that nothing changed, and to try again', () => {
    const check = parseTestsLog('ai-sdlc-helper (vitest): 912 passed, 1 failed, 0 skipped\n  FAIL  test/x.test.ts :: it does a thing\n      Error: boom\n', 'logs/tests.log');
    expect(check).toEqual({ log: 'logs/tests.log', passed: 912, failed: 1, names: ['test/x.test.ts :: it does a thing'] });
    const lines = plainStop(stop({ checkFailed: true }), check);
    expect(lines[0]).toBe('What happened: Fixed the conflicts in 2 files, then the test check failed: 1 test failed, 912 passed (test/x.test.ts :: it does a thing). Nothing was pushed.');
    expect(lines[1]).toContain('exactly as they were');
    expect(lines.join('\n')).toContain('press Resolve conflicts to try again, open logs/tests.log');
    expect(lines.join('\n')).not.toMatch(/follow-up|rebas|lease|refs\//);
  });

  test('a test run that produced no report is said to have not finished, not to have failed a test', () => {
    const check = parseTestsLog('ai-sdlc-helper (vitest): 0 passed, 0 failed, 0 skipped, 1 file errors\n  command: npx vitest\n  ERROR (unknown file): failed to run\n      no report\n', 'logs/tests.log');
    expect(check).toMatchObject({ passed: 0, failed: 0, names: [], didNotRun: true });
    const lines = plainStop(stop({ checkFailed: true }), check);
    expect(lines[0]).toBe('What happened: Fixed the conflicts in 2 files, but the test run itself did not finish (it produced no report). Nothing was pushed.');
    expect(lines[2]).toContain('nothing says the merge is wrong');
    expect(parseTestsLog('ai-sdlc-helper (vitest): 912 passed, 1 failed, 0 skipped, 0 file errors\n', 'l').didNotRun).toBeUndefined();
  });

  test('a doubt names the files and the question; the report leads with the plain words and keeps the git details below', () => {
    const r = stop({ reason: 'the conflict in src/a.ts could break this task', offer: true, conflict: { commit: { sha: 'abc1234def', subject: 'feat: x' }, files: ['src/a.ts'], doubt: 'one() is commented two ways', sides: [] }, attempt: 'refs/sdlc-attempt/b' });
    const lines = outcomeLines(r);
    expect(lines[0]).toBe('What happened: the agent was not sure how to combine the changes in src/a.ts: one() is commented two ways. Nothing was pushed.');
    expect(lines.indexOf('Details:')).toBeGreaterThan(3);
    expect(lines.slice(lines.indexOf('Details:'))).toContain('The rebased attempt is kept at refs/sdlc-attempt/b; the branch is back where it was.');
  });

  test('a stop that cannot go on says why and what to fix; a log without counts still lists nothing wrong', () => {
    expect(plainStop(stop({ reason: 'b has uncommitted changes: commit or discard them first', resolved: [] }))[0])
      .toBe('What happened: B has uncommitted changes: commit or discard them first. Nothing was pushed.');
    expect(parseTestsLog('no counts here', 'logs/integration.log')).toEqual({ log: 'logs/integration.log', names: [] });
  });
});

describe('the independent review of a doubt', () => {
  test('the last verdict line counts; no verdict means UNSAFE; UNSAFE is not read as SAFE', () => {
    expect(reviewVerdict('reasons\nVERDICT: SAFE\n')).toBe('SAFE');
    expect(reviewVerdict('VERDICT: SAFE\nbut then I found a problem\nVERDICT: UNSAFE')).toBe('UNSAFE');
    expect(reviewVerdict('verdict: unsafe')).toBe('UNSAFE');
    expect(reviewVerdict('looks fine to me')).toBe('UNSAFE');
    expect(reviewVerdict('')).toBe('UNSAFE');
  });

  test('only all of the reviewers SAFE overrides the doubt', () => {
    expect(unanimouslySafe(['SAFE', 'SAFE', 'SAFE'], 3)).toBe(true);
    expect(unanimouslySafe(['SAFE', 'SAFE', 'UNSAFE'], 3)).toBe(false);
    expect(unanimouslySafe(['SAFE', 'SAFE'], 3)).toBe(false);
    expect(unanimouslySafe(['SAFE'], 1)).toBe(true);
    expect(unanimouslySafe([], 0)).toBe(false);
  });

  test('the number of reviewers is 3 unless set, 0 to 5, and 0 leaves the doubt to the developer', () => {
    expect(reviewerCount({})).toBe(3);
    expect(reviewerCount({ SDLC_RESOLVE_REVIEWERS: '' })).toBe(3);
    expect(reviewerCount({ SDLC_RESOLVE_REVIEWERS: 'many' })).toBe(3);
    expect(reviewerCount({ SDLC_RESOLVE_REVIEWERS: '1' })).toBe(1);
    expect(reviewerCount({ SDLC_RESOLVE_REVIEWERS: '5' })).toBe(5);
    expect(reviewerCount({ SDLC_RESOLVE_REVIEWERS: '9' })).toBe(5);
    expect(reviewSkipped({ SDLC_RESOLVE_REVIEWERS: '0' })).toBe(true);
    expect(reviewSkipped({ SDLC_RESOLVE_REVIEWERS: '2' })).toBe(false);
  });

  test('SDLC_RESOLVE_REVIEW turns it off', () => {
    expect(reviewSkipped({})).toBe(false);
    expect(reviewSkipped({ SDLC_RESOLVE_REVIEW: '0' })).toBe(true);
    expect(reviewSkipped({ SDLC_RESOLVE_REVIEW: 'off' })).toBe(true);
    expect(reviewSkipped({ SDLC_RESOLVE_REVIEW: '1' })).toBe(false);
  });
});

describe('reviewers must not share a model', () => {
  test('reviewers on the same agent and model are named; different ones are fine', () => {
    expect(sharedReviewers(['claude:opus', 'claude:sonnet', 'claude:haiku'])).toEqual([]);
    expect(sharedReviewers(['claude:opus', 'claude:sonnet', 'claude:opus'])).toEqual([{ model: 'claude:opus', reviewers: [1, 3] }]);
    expect(sharedReviewers(['codex:gpt-6.1-sol', 'claude:opus', 'codex:gpt-6.1-sol', 'claude:opus'])).toHaveLength(2);
    expect(sharedReviewersText(['claude:opus', 'claude:sonnet', 'claude:opus'])).toBe('reviewers 1 and 3 use the same model (claude:opus)');
    expect(sharedReviewersText(['claude:opus', 'agy:gemini-3.8-flash-medium'])).toBe('');
  });
});

describe('fixing the merged result', () => {
  /** A conflict the resolver settles whose check then fails: the attempt is kept and the branch is back where it was. */
  async function failedCheck() {
    const w = world({ 'src/app.ts': APP.replace('b = 2', 'b = 20 // the task') });
    w.mergeIntoMain({ 'src/app.ts': APP.replace('b = 2', 'b = 200 // merged work') });
    const before = g(w.run, 'rev-parse', 'HEAD');
    const r = await resolveConflicts(w.opts({
      resolveCode: async c => { fs.writeFileSync(path.join(w.run, c.files[0]), APP); return { safe: true, files: [] }; },
      verify: async () => false,
    }));
    expect(r).toMatchObject({ kind: 'stopped', checkFailed: true });
    return { w, record: path.join(w.root, 'record.json'), before, attempt: g(w.run, 'rev-parse', `refs/sdlc-attempt/${BRANCH}`) };
  }

  test('the kept attempt becomes the branch; the stage then checks it and pushes it with the lease, without rebasing again', async () => {
    const { w, record, before, attempt } = await failedCheck();
    const remoteBefore = w.remoteSha();
    expect(g(w.run, 'rev-parse', 'HEAD')).toBe(before);

    const a = adoptAttempt(w.git, BRANCH, record);
    expect(a).toMatchObject({ ok: true, attempt, before, remoteSha: remoteBefore });
    expect(g(w.run, 'rev-parse', 'HEAD')).toBe(attempt);
    expect(w.remoteSha()).toBe(remoteBefore);

    // what Implement adds on top of the merged result
    commit(w.run, { 'src/fix.ts': 'export const fixed = true;\n' }, 'fix(task): repair the merged result');
    w.git.calls.length = 0;
    const verify = vi.fn(async () => true);
    const r = await resolveConflicts(w.opts({ adopted: { remoteSha: remoteBefore }, verify }));
    expect(r).toMatchObject({ kind: 'pushed', pushes: 1 });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ resolved: [] });
    expect(spawnSync('git', ['merge-base', '--is-ancestor', attempt, 'HEAD'], { cwd: w.run, env: ENV }).status).toBe(0);
    expect(w.remoteSha()).toBe(g(w.run, 'rev-parse', 'HEAD'));
    expect(g(w.remote, 'show', `${BRANCH}:src/fix.ts`)).toContain('fixed');
    expect(leasePushes(w.git)[0]).toContain(`--force-with-lease=${BRANCH}:${remoteBefore}`);
    noBareForce(w.git);
  });

  test('a remote that moved since, or no adoption mark, still stops: a branch that diverged is never rewritten', async () => {
    const { w, record } = await failedCheck();
    const remoteBefore = w.remoteSha();
    adoptAttempt(w.git, BRANCH, record);
    const plain = await resolveConflicts(w.opts({ verify: async () => true }));
    expect(plain).toMatchObject({ kind: 'stopped', offer: false });
    const stale = await resolveConflicts(w.opts({ adopted: { remoteSha: 'deadbeef' }, verify: async () => true }));
    expect(stale).toMatchObject({ kind: 'stopped' });
    expect(leasePushes(w.git)).toEqual([]);
    expect(w.remoteSha()).toBe(remoteBefore);
  });

  test('the adoption is refused when the branch moved, there is no attempt or the record is missing; nothing changes', async () => {
    const { w, record } = await failedCheck();
    expect(adoptAttempt(w.git, BRANCH, path.join(w.root, 'nothing.json'))).toMatchObject({ ok: false, reason: expect.stringContaining('record') });
    commit(w.run, { 'src/more.ts': 'x\n' }, 'feat(task): more');
    const head = g(w.run, 'rev-parse', 'HEAD');
    expect(adoptAttempt(w.git, BRANCH, record)).toMatchObject({ ok: false, reason: expect.stringContaining('has moved since the attempt') });
    expect(g(w.run, 'rev-parse', 'HEAD')).toBe(head);
    const clean = world();
    expect(adoptAttempt(clean.git, BRANCH, path.join(clean.root, 'record.json'))).toMatchObject({ ok: false, reason: expect.stringContaining('no kept attempt') });
  });

  test('the failure Implement is given names the tests, the end of the log and what was merged; the files of failing tests are found', () => {
    const check = { log: 'logs/tests.log', passed: 10, failed: 1, names: ['test/a.test.ts :: it counts stages'], baseline: 'passes' as const };
    const text = mergeFailureText({ slug: 'task', base: 'main', check, logTail: 'AssertionError: expected 8 to be 12', merged: [{ sha: 'abc1234def', subject: 'feat(other): other work (#7)' }] });
    expect(text).toContain('(10 passed, 1 failed)');
    expect(text).toContain('the merge caused the failure');
    expect(text).toContain('- test/a.test.ts :: it counts stages');
    expect(text).toContain('AssertionError: expected 8 to be 12');
    expect(text).toContain('- abc1234 feat(other): other work (#7)');
    expect(failingTestFiles(['test/a.test.ts :: x', 'test/a.test.ts :: y', 'gone.test.ts :: z'], f => f === 'test/a.test.ts')).toEqual(['test/a.test.ts']);
  });

  test('the report offers Fix with Implement only when the attempt is kept, and says when the base fails the same tests', () => {
    const stopped = { kind: 'stopped' as const, reason: 'the check failed on the rebased branch', offer: false, resolved: [], checkFailed: true, attempt: 'refs/sdlc-attempt/b' };
    const names = ['t :: x'];
    const fixable = plainStop(stopped, { log: 'logs/tests.log', passed: 5, failed: 1, names, baseline: 'passes' }).join('\n');
    expect(fixable).toContain('pass on the base branch alone');
    expect(fixable).toContain('Fix with Implement');
    const onBase = plainStop(stopped, { log: 'logs/tests.log', passed: 5, failed: 1, names, baseline: 'fails' }).join('\n');
    expect(onBase).toContain('also fail on the base branch');
    expect(onBase).not.toContain('Fix with Implement');
    expect(plainStop({ ...stopped, attempt: undefined }, { log: 'l', names: [] }).join('\n')).not.toContain('Fix with Implement');
  });
});
