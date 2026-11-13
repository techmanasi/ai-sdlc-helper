import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { answerQuestions, boardIgnores, boardInputs, boardView, clearGitFacts, parseQuestions, resumeStage, runView, syncRunPr } from '../src/runs/view.js';
import { clearPrCache } from '../src/pipeline/finalise.js';
import { liveBranch, liveBriefPr, runContext } from '../src/runs/index.js';
import { moveReasonText } from '../src/pipeline/status.js';
import { getPrFromBrief } from '../src/pipeline/finalise.js';
import { addBacklogItem, backlogItems } from '../src/backlog/index.js';
import { TRACE_DEFAULTS, startTrace, stopTrace } from '../src/trace.js';
import { worktreeInputs } from '../src/gitdir.js';
import { tmp, write } from './helpers.js';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const QUESTIONS = `# Questions

### Q1: Token storage
Store the raw token
or only a hash?
**Suggested:** Only a SHA-256 hash.
**Answer:**

### Q2: Expiry
How long do tokens live?
**Suggested:** 30 days,
set by TOKEN_TTL_DAYS.
**Answer:** accept
`;

/** A repository with a backlog, and a run of <slug> whose worktree holds the given files (relative to the item folder). */
function repoWithRun(slug: string, record: Record<string, unknown> | null, files: Record<string, unknown> = {}) {
  const base = fs.realpathSync(tmp('view-'));
  const root = path.join(base, 'repo');
  write(root, 'sdlc.config.json', { suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } });
  write(root, 'Docs/backlog/index.md', `# Backlog\n\n- [ ] \`${slug}\` - Feature: Add tokens\n- [ ] \`other\` - Bug: Fix rounding\n`);
  write(root, `Docs/backlog/${slug}/brief.md`, `# ${slug}\n\nType: feature\nPriority: P1 (high)\n`);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const wt = path.join(base, 'wts', slug);
  git(root, 'worktree', 'add', '-q', wt, '-b', `sdlc/${slug}`);
  for (const [f, v] of Object.entries(files)) write(wt, `Docs/backlog/${slug}/${f}`, v);
  if (record) write(path.join(root, '.git/sdlc-runs'), `${slug}.json`, { slug, worktree: wt, pid: 0, started: '2026-10-19T10:00:00', interrupted: false, finished: '', message: '', branch: `sdlc/${slug}`, base: 'main', ...record });
  return { root, wt, ctx: runContext(root, GIT_ENV) };
}

describe('questions', () => {
  test('parseQuestions reads each question with its body, suggestion and answer, joining wrapped lines', () => {
    expect(parseQuestions(QUESTIONS)).toEqual([
      { n: 1, title: 'Token storage', body: 'Store the raw token or only a hash?', suggested: 'Only a SHA-256 hash.', answer: '' },
      { n: 2, title: 'Expiry', body: 'How long do tokens live?', suggested: '30 days, set by TOKEN_TTL_DAYS.', answer: 'accept' },
    ]);
  });

  test('answerQuestions fills the Answer lines, one line each, and keeps the rest of the file', () => {
    const file = path.join(tmp(), 'questions.md');
    fs.writeFileSync(file, QUESTIONS);
    expect(answerQuestions(file, { 1: 'Hash it.\nIndex token_hash.' })).toEqual({ total: 2, answered: 2 });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('**Answer:** Hash it. Index token_hash.');
    expect(text).toContain('**Answer:** accept');
    expect(text).toContain('or only a hash?');
    expect(parseQuestions(text).map(q => q.answer)).toEqual(['Hash it. Index token_hash.', 'accept']);
  });

  test('answerQuestions refuses a question number that is not in the file and a missing file', () => {
    const file = path.join(tmp(), 'questions.md');
    fs.writeFileSync(file, QUESTIONS);
    expect(() => answerQuestions(file, { 3: 'x' })).toThrow('there is no question 3');
    expect(fs.readFileSync(file, 'utf8')).toBe(QUESTIONS);
    expect(() => answerQuestions(path.join(tmp(), 'none.md'), { 1: 'x' })).toThrow('missing');
  });
});

describe('runView', () => {
  test('a run paused at Spec shows its questions, refused actions, tests, stage files, output and files', () => {
    const out = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const { ctx, wt } = repoWithRun('add-tokens', { state: 'exited', exit_code: '2' }, {
      'questions.md': QUESTIONS,
      'specs-1.md': '# spec',
      'logs/status.json': { slug: 'add-tokens', state: 'paused', stage: 'Spec', agent: 'spec-1', model: 'opus', effort: 'medium', models: { spec: { model: 'opus', effort: 'medium' } }, attempt: '1/5', note: '', updated: '2026-10-19T10:06:00', pid: 0 },
      'logs/permissions.json': { pending: [{ stage: 'spec', tool: 'Bash', detail: 'psql -c 1', rule: 'Bash(psql:*)', protected: false }], allow: [], bypass: [], denied: [{ tool: 'Bash', detail: 'rm -rf /' }] },
      'logs/tests.json': { tests: [{ status: 'passed' }, { status: 'passed' }, { status: 'failed' }, { status: 'skipped' }], suiteErrors: [{ file: null, message: 'x' }] },
      'logs/stage-files.json': { marker: null, stages: { Spec: ['Docs/backlog/add-tokens/specs-1.md'] } },
      'logs/run.out': `${out}\n`,
    });
    const v = runView(ctx, 'add-tokens', { changes: false });
    expect(v.state).toBe('paused');
    expect(v.stage).toBe('Spec');
    expect(v.model).toBe('opus');
    expect(v.attempt).toBe('1/5');
    expect(v.worktree).toBe(wt);
    expect(v.branch).toBe('sdlc/add-tokens');
    expect(v.questions.map(q => q.n)).toEqual([1, 2]);
    expect(v.permissions).toEqual([expect.objectContaining({ tool: 'Bash', rule: 'Bash(psql:*)' })]);
    expect(v.deniedPermissions).toEqual([expect.objectContaining({ tool: 'Bash', detail: 'rm -rf /' })]);
    expect(v.tests).toEqual({ passed: 2, failed: 2, skipped: 1, total: 4 });
    expect(v.stageFiles).toEqual({ Spec: ['Docs/backlog/add-tokens/specs-1.md'] });
    expect(v.tail).toHaveLength(40);
    expect(v.tail[39]).toBe('line 50');
    expect(v.docs).toEqual(expect.arrayContaining(['brief.md', 'questions.md', 'specs-1.md', 'logs/run.out', 'logs/status.json']));
    expect(v.resumeFrom).toBe('');
    expect(v.changes).toBeNull();
  });

  test('reports the red-tests commit on the run branch, and none before it exists', () => {
    const { ctx, wt } = repoWithRun('add-tokens', { state: 'exited', exit_code: '1' }, { 'logs/status.json': { state: 'failed', stage: 'Implement' } });
    expect(runView(ctx, 'add-tokens', { changes: false }).redCommit).toBe('');
    git(wt, 'commit', '-q', '--allow-empty', '-m', 'test(add-tokens): add failing tests');
    expect(runView(ctx, 'add-tokens', { changes: false }).redCommit).toMatch(/^[0-9a-f]{7,}$/);
  });

  test('a run that moved shows its new branch and where it came from; one that did not shows the default', () => {
    const moved = { branch: 'sdlc/add-tokens_2', moved_from: { branch: 'sdlc/add-tokens', reason: 'earlier-run', reason_text: 'the words', pr: 'https://github.com/o/r/pull/5', at: '2026-11-13T10:00:00' } };
    const { ctx } = repoWithRun('add-tokens', { state: 'exited', exit_code: '1' }, { 'logs/status.json': { state: 'failed', stage: 'Implement', ...moved } });
    const v = runView(ctx, 'add-tokens', { changes: false });
    expect(v.branch).toBe('sdlc/add-tokens_2');
    const { reason_text: words, ...rest } = moved.moved_from;
    expect(v.movedFrom).toEqual({ ...rest, reasonText: words });
    // An older status file without the words: they come from the code.
    const old = repoWithRun('add-tokens', { state: 'exited', exit_code: '1' }, { 'logs/status.json': { state: 'failed', stage: 'Implement', moved_from: { branch: 'sdlc/add-tokens', reason: 'pr-merged', at: '' } } });
    expect(runView(old.ctx, 'add-tokens', { changes: false }).movedFrom?.reasonText).toBe(moveReasonText('pr-merged'));
    const plain = repoWithRun('add-tokens', { state: 'exited', exit_code: '1' }, { 'logs/status.json': { state: 'failed', stage: 'Implement' } });
    const p = runView(plain.ctx, 'add-tokens', { changes: false });
    expect(p.branch).toBe('sdlc/add-tokens');
    expect(p.movedFrom).toBeUndefined();
  });

  test('liveBranch: status.json first, then the worktree\'s run branch, then the record; the worktree\'s brief link first', () => {
    const { ctx, wt, root } = repoWithRun('add-tokens', { state: 'running', exit_code: '' }, { 'logs/status.json': { state: 'running', stage: 'Red tests', branch: 'sdlc/add-tokens_3' } });
    expect(liveBranch(ctx, 'add-tokens')).toBe('sdlc/add-tokens_3');
    fs.rmSync(path.join(wt, 'Docs/backlog/add-tokens/logs/status.json'));
    git(wt, 'checkout', '-q', '-b', 'sdlc/add-tokens_2');
    expect(liveBranch(ctx, 'add-tokens')).toBe('sdlc/add-tokens_2');
    // Another item's branch (add-tokens-2) is not this run's: the record's branch is used.
    git(wt, 'checkout', '-q', '-b', 'sdlc/add-tokens-2');
    expect(liveBranch(ctx, 'add-tokens')).toBe('sdlc/add-tokens');
    write(root, 'Docs/backlog/add-tokens/brief.md', '---\npr: https://github.com/o/r/pull/5\n---\n');
    expect(liveBriefPr(ctx, 'add-tokens', getPrFromBrief)).toBe('https://github.com/o/r/pull/5');
    write(wt, 'Docs/backlog/add-tokens/brief.md', '---\npr: https://github.com/o/r/pull/9\n---\n');
    expect(liveBriefPr(ctx, 'add-tokens', getPrFromBrief)).toBe('https://github.com/o/r/pull/9');
  });

  test('counts the files the run changed in its worktree', () => {
    const { ctx } = repoWithRun('add-tokens', { state: 'exited', exit_code: '1' }, { 'logs/status.json': { state: 'failed', stage: 'Implement' } });
    const v = runView(ctx, 'add-tokens');
    expect(v.state).toBe('failed');
    expect(v.resumeFrom).toBe('implement');
    expect(v.changes).toEqual(expect.objectContaining({ uncommitted: expect.any(Number), changed: expect.any(Number) }));
    expect(v.changes!.files.some(f => f.includes('status.json'))).toBe(true);
  });

  test('a stop that named where to resume: the run resumes there, not at the stage shown; without one, the stage decides', () => {
    const { ctx } = repoWithRun('add-tokens', { state: 'exited', exit_code: '1' }, { 'logs/status.json': { state: 'failed', stage: 'Plan', resume_from: 'red-tests' } });
    expect(runView(ctx, 'add-tokens').resumeFrom).toBe('red-tests');
    const plain = repoWithRun('add-tokens', { state: 'exited', exit_code: '1' }, { 'logs/status.json': { state: 'failed', stage: 'Plan' } });
    expect(runView(plain.ctx, 'add-tokens').resumeFrom).toBe('plan');
  });

  test('the state follows the record: done, refused, interrupted, and not started without one', () => {
    expect(runView(repoWithRun('a', { state: 'exited', exit_code: '0' }).ctx, 'a', { changes: false }).state).toBe('done');
    expect(runView(repoWithRun('a', { state: 'exited', exit_code: '3', worktree: '', message: 'at most 2 pipelines' }).ctx, 'a', { changes: false }))
      .toEqual(expect.objectContaining({ state: 'refused', message: 'at most 2 pipelines' }));
    expect(runView(repoWithRun('a', { state: 'exited', exit_code: '', interrupted: true }).ctx, 'a', { changes: false }).state).toBe('interrupted');
    expect(runView(repoWithRun('a', null).ctx, 'a', { changes: false }).state).toBe('not started');
  });

  test('resumeStage: Plan and Red tests resume at their stage, Review at review, Finalise at finalise, others at Implement', () => {
    expect(['Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Finalise', ''].map(s => resumeStage(s)))
      .toEqual(['', 'plan', 'red-tests', 'implement', 'implement', 'review', 'finalise', '']);
  });

  test('resumeStage: resumes at test-repair when test-issues exist', () => {
    expect(resumeStage('Test repair', true)).toBe('test-repair');
    expect(resumeStage('Test repair', false)).toBe('implement');
  });
});

test('boardView lists the backlog and a card per recorded run', () => {
  const { ctx } = repoWithRun('add-tokens', { state: 'exited', exit_code: '2' }, { 'questions.md': QUESTIONS, 'logs/status.json': { state: 'paused', stage: 'Spec', attempt: '2/5' } });
  const b = boardView(ctx, { changes: false });
  expect(b.items!.map(i => [i.slug, i.type])).toEqual([['add-tokens', 'feature'], ['other', 'bug']]);
  expect(b.runs).toEqual([expect.objectContaining({ slug: 'add-tokens', state: 'paused', stage: 'Spec', attempt: '2/5', questions: 2, permissions: 0 })]);
  expect(b.maxParallel).toBe(2);
  expect(b.running).toBe(0);
});

test('boardView gives a finished run its pull request, read in the background and not asked for again within the hour', async () => {
  const { root } = repoWithRun('add-tokens', { state: 'exited', exit_code: '0' }, { 'logs/status.json': { state: 'done', stage: 'Finalise' } });
  const bin = path.join(root, '..', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho + >> "${bin}/calls"\necho '{"url":"https://github.com/o/r/pull/85","state":"OPEN","number":85}'\n`, { mode: 0o755 });
  const ctx = runContext(root, { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` });
  clearPrCache();
  const card = () => boardView(ctx, { changes: false }).runs[0];
  expect(card().pullRequest).toMatchObject({ state: null, checkedAt: null });
  for (let i = 0; i < 100 && !card().pullRequest?.state; i++) await new Promise(r => setTimeout(r, 30));
  expect(card().pullRequest).toMatchObject({ state: 'OPEN', number: 85, url: 'https://github.com/o/r/pull/85', failed: false });
  expect(card().pullRequest!.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  for (let i = 0; i < 5; i++) card();
  expect(fs.readFileSync(path.join(bin, 'calls'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  const synced = await syncRunPr(ctx, 'add-tokens');
  expect(synced).toMatchObject({ state: 'OPEN', number: 85 });
  expect(fs.readFileSync(path.join(bin, 'calls'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
});

test('boardView leaves the pull request of a run that is not done empty', () => {
  const { ctx } = repoWithRun('add-tokens', { state: 'exited', exit_code: '2' }, { 'logs/status.json': { state: 'paused', stage: 'Spec' } });
  expect(boardView(ctx, { changes: false }).runs[0].pullRequest).toBeNull();
});

describe('addBacklogItem', () => {
  test('writes the brief and appends the index line, making the index when missing', () => {
    const root = tmp();
    const place = { root, backlogDir: 'Docs/backlog', branchPrefix: 'sdlc/' };
    addBacklogItem(place, { slug: 'add-rate-limit', type: 'feature', title: 'Rate limit /auth', brief: '# add-rate-limit\n\nType: feature\nPriority: P1 (high)' });
    addBacklogItem(place, { slug: 'fix-rounding', type: 'bug', title: 'Totals off by a cent', brief: '# fix-rounding\n' });
    expect(fs.readFileSync(path.join(root, 'Docs/backlog/add-rate-limit/brief.md'), 'utf8')).toBe('# add-rate-limit\n\nType: feature\nPriority: P1 (high)\n');
    expect(backlogItems(place)!.items.map(i => [i.slug, i.type, i.priority, i.title])).toEqual([
      ['add-rate-limit', 'feature', 'P1', 'Rate limit /auth'],
      ['fix-rounding', 'bug', null, 'Totals off by a cent'],
    ]);
  });

  test('refuses a bad slug, type or title and a slug that exists, writing nothing', () => {
    const root = tmp();
    const place = { root, backlogDir: 'Docs/backlog' };
    write(root, 'Docs/backlog/index.md', '# Backlog\n\n- [ ] `taken` - Feature: x\n');
    const item = { slug: 'ok', type: 'feature' as const, title: 't', brief: 'b' };
    expect(() => addBacklogItem(place, { ...item, slug: 'Bad Slug' })).toThrow('slug');
    expect(() => addBacklogItem(place, { ...item, type: 'chore' as any })).toThrow('type');
    expect(() => addBacklogItem(place, { ...item, title: 'two\nlines' })).toThrow('title');
    expect(() => addBacklogItem(place, { ...item, slug: 'taken' })).toThrow('already in');
    expect(fs.readdirSync(path.join(root, 'Docs/backlog'))).toEqual(['index.md']);
  });
});

describe('the cached git facts of runView', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; clearGitFacts(); });

  /** A git that logs one line per call, then runs the real one: the independent count of git spawns. */
  function countingGit(dir: string): () => number {
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'git-calls.txt');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho x >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath}`;
    return () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  }
  const status = (stage: string) => ({ state: 'paused', stage, attempt: '1' });

  test('10 requests for an unchanged run read git once; a stage change, refresh and a different run read it again', () => {
    const { wt, ctx } = repoWithRun('tok', { exit_code: '2' }, { 'logs/status.json': status('Spec') });
    const calls = countingGit(path.dirname(wt));
    const first = runView(ctx, 'tok', { cacheGit: true });
    const afterFirst = calls();
    expect(afterFirst).toBeGreaterThan(0);
    expect(first.gitAgeMs).toBeNull();
    for (let i = 0; i < 9; i++) runView(ctx, 'tok', { cacheGit: true });
    expect(calls()).toBe(afterFirst);
    expect(runView(ctx, 'tok', { cacheGit: true }).gitAgeMs).toBeGreaterThanOrEqual(0);

    write(wt, 'Docs/backlog/tok/logs/status.json', status('Plan'));
    const changed = runView(ctx, 'tok', { cacheGit: true });
    expect(changed.gitAgeMs).toBeNull();
    const afterStage = calls();
    expect(afterStage).toBeGreaterThan(afterFirst);
    runView(ctx, 'tok', { cacheGit: true });
    expect(calls()).toBe(afterStage);

    runView(ctx, 'tok', { cacheGit: true, refresh: true });
    expect(calls()).toBeGreaterThan(afterStage);
  });

  test('the cached counts are the real counts, and an uncommitted edit shows after a refresh, not before', () => {
    const { wt, ctx } = repoWithRun('tok', { exit_code: '2' }, { 'logs/status.json': status('Spec') });
    expect(runView(ctx, 'tok', { cacheGit: true }).changes?.uncommitted).toBeGreaterThanOrEqual(0);
    const before = runView(ctx, 'tok', { cacheGit: true }).changes?.uncommitted ?? 0;
    write(wt, 'src/new-file.ts', 'export {};\n');
    expect(runView(ctx, 'tok', { cacheGit: true }).changes?.uncommitted).toBe(before);
    expect(runView(ctx, 'tok', { cacheGit: true, refresh: true }).changes?.uncommitted).toBe(before + 1);
    expect(runView(ctx, 'tok', { cacheGit: false }).changes?.uncommitted).toBe(before + 1);
  });

  test('parts=live makes no git call and leaves the git fields empty; parts=live,tail keeps the tail', () => {
    const { wt, ctx } = repoWithRun('tok', { exit_code: '2' }, { 'logs/status.json': status('Spec'), 'logs/run.out': 'one\ntwo\n' });
    const calls = countingGit(path.dirname(wt));
    const live = runView(ctx, 'tok', { cacheGit: true, parts: ['live'] });
    expect(calls()).toBe(0);
    expect(live.changes).toBeNull();
    expect(live.redCommit).toBe('');
    expect(live.tail).toEqual([]);
    expect(live.stage).toBe('Spec');
    const lt = runView(ctx, 'tok', { cacheGit: true, parts: ['live', 'tail'] });
    expect(calls()).toBe(0);
    expect(lt.tail).toEqual(['one', 'two']);
  });

  test('the Red tests commit appears at the next read after the stage changes', () => {
    const { wt, ctx } = repoWithRun('tok', { exit_code: '2' }, { 'logs/status.json': status('Spec') });
    expect(runView(ctx, 'tok', { cacheGit: true }).redCommit).toBe('');
    write(wt, 'test/tok.test.ts', 'x');
    git(wt, 'add', '-A');
    git(wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'test(tok): add failing tests');
    write(wt, 'Docs/backlog/tok/logs/status.json', status('Implement'));
    expect(runView(ctx, 'tok', { cacheGit: true }).redCommit).not.toBe('');
  });
});

describe('the board card', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; clearGitFacts(); });

  /** Stand-ins for git and ps that log their arguments and then run the real program. */
  function counting(...programs: string[]): { env: NodeJS.ProcessEnv; calls: (program: string) => string[] } {
    const bin = tmp('card-bin-');
    for (const p of programs) {
      const real = spawnSync('sh', ['-c', `command -v ${p}`], { encoding: 'utf8', env: { ...process.env, PATH: savedPath } }).stdout.trim();
      fs.writeFileSync(path.join(bin, p), `#!/bin/sh\necho "$@" >> "${path.join(bin, `${p}-calls.txt`)}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    }
    process.env.PATH = `${bin}:${savedPath}`;
    return {
      env: { ...GIT_ENV, PATH: process.env.PATH },
      calls: p => { try { return fs.readFileSync(path.join(bin, `${p}-calls.txt`), 'utf8').split('\n').filter(Boolean); } catch { return []; } },
    };
  }
  const perRun = (calls: string[]) => calls.filter(l => !l.includes('for-each-ref') && !l.includes('worktree list') && !l.includes('rev-parse'));

  test('a second read of a board that did not move runs no git command for its runs, and the cards are the same', () => {
    const { root, wt } = repoWithRun('add-tokens', { state: 'exited', exit_code: '2' }, { 'questions.md': QUESTIONS, 'logs/status.json': { state: 'paused', stage: 'Spec', attempt: '2/5' } });
    write(wt, 'src/new.js', 'export const a = 1;\n');
    const c = counting('git');
    const ctx = runContext(root, c.env);
    const first = boardView(ctx);
    const afterFirst = c.calls('git').length;
    expect(perRun(c.calls('git')).length).toBeGreaterThan(0);
    expect(c.calls('git').some(l => l.includes('--grep'))).toBe(true);
    expect(first.runs[0]).toEqual(expect.objectContaining({ slug: 'add-tokens', state: 'paused', stage: 'Spec', questions: 2, permissions: 0, deniedPermissions: 0 }));
    expect(first.runs[0].changes!.uncommitted).toBeGreaterThan(0);
    const second = boardView(ctx);
    expect(perRun(c.calls('git').slice(afterFirst))).toEqual([]);
    // Nothing the board is made from changed, so the second read asked git for nothing at all.
    expect(c.calls('git').slice(afterFirst)).toEqual([]);
    expect(second.runs).toEqual(first.runs);
  });

  test('a stage change makes the counts fresh on the next read', () => {
    const { root, wt } = repoWithRun('add-tokens', { state: 'exited', exit_code: '2' }, { 'logs/status.json': { state: 'paused', stage: 'Spec', attempt: '1' } });
    const c = counting('git');
    const ctx = runContext(root, c.env);
    const before = boardView(ctx).runs[0].changes!.uncommitted;
    write(wt, 'src/new.js', 'export const a = 1;\n');
    expect(boardView(ctx).runs[0].changes!.uncommitted).toBe(before);
    write(wt, 'Docs/backlog/add-tokens/logs/status.json', { state: 'paused', stage: 'Plan', attempt: '1' });
    expect(boardView(ctx).runs[0].changes!.uncommitted).toBeGreaterThan(before);
  });

  describe('a finished run on the board', () => {
    afterEach(() => { vi.useRealTimers(); });
    const finished = () => repoWithRun('add-tokens', { state: 'exited', exit_code: '0', finished: '2026-10-19T10:30:00' }, { 'logs/status.json': { state: 'done', stage: 'Finalise' } });
    const countsRead = (calls: string[]) => calls.filter(l => /(^| )(merge-base|diff|status|log) /.test(l));
    /** Builds the board twice, so that git's own refresh of the index (its first status) is behind the run's key. */
    function settled(ctx: ReturnType<typeof runContext>) { boardView(ctx); boardView(ctx); }
    const later = (ms: number) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + ms); };

    test('a finished run\'s file counts are not read again while its git files do not change', () => {
      const { root } = finished();
      const c = counting('git');
      const ctx = runContext(root, c.env);
      settled(ctx);
      expect(countsRead(c.calls('git')).length).toBeGreaterThan(0);
      const n = c.calls('git').length;
      later(2 * 60_000);
      boardView(ctx);
      expect(countsRead(c.calls('git').slice(n))).toEqual([]);
    });

    test('a commit in a finished run\'s working tree is seen at the next board build', () => {
      const { root, wt } = finished();
      const c = counting('git');
      const ctx = runContext(root, c.env);
      settled(ctx);
      const before = boardView(ctx).runs[0].changes!.changed;
      const n = c.calls('git').length;
      write(wt, 'src/added.js', 'export const a = 1;\n');
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '-m', 'more');
      const after = boardView(ctx).runs[0].changes!;
      expect(countsRead(c.calls('git').slice(n)).length).toBeGreaterThan(0);
      expect(after.changed).toBe(before + 1);
    });

    test('an edit that is not staged is seen after ten minutes at most', () => {
      const { root, wt } = finished();
      const c = counting('git');
      const ctx = runContext(root, c.env);
      settled(ctx);
      const before = boardView(ctx).runs[0].changes!.uncommitted;
      fs.appendFileSync(path.join(wt, 'Docs/backlog/index.md'), '- [ ] `x` - Bug: edit\n');
      const n = c.calls('git').length;
      later(2 * 60_000);
      expect(boardView(ctx).runs[0].changes!.uncommitted).toBe(before);
      expect(countsRead(c.calls('git').slice(n))).toEqual([]);
      later(10 * 60_000);
      expect(boardView(ctx).runs[0].changes!.uncommitted).toBe(before + 1);
      expect(countsRead(c.calls('git').slice(n)).length).toBeGreaterThan(0);
    });
  });

  test('a running run\'s counts are still read again after 30 seconds', () => {
    const { root } = repoWithRun('add-tokens', { state: 'running', pid: process.pid, exit_code: '' }, { 'logs/status.json': { state: 'running', stage: 'Implement', attempt: '1' } });
    const c = counting('git');
    const ctx = runContext(root, c.env);
    try {
      boardView(ctx);
      const n = c.calls('git').length;
      boardView(ctx);
      expect(c.calls('git').slice(n).filter(l => / status /.test(l))).toEqual([]);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 31_000);
      boardView(ctx);
      expect(c.calls('git').slice(n).some(l => / status /.test(l))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  test('a running run asks ps once per board read', () => {
    const { root } = repoWithRun('add-tokens', { state: 'running', pid: process.pid, exit_code: '' }, { 'logs/status.json': { state: 'running', stage: 'Implement', attempt: '1' } });
    const c = counting('git', 'ps');
    const ctx = runContext(root, c.env);
    const b = boardView(ctx, { changes: false });
    expect(b.runs[0].state).toBe('running');
    expect(c.calls('ps')).toHaveLength(1);
  });
});

test('a run that only has a status file is stopped when its pid now belongs to a process that started at another time', () => {
  const base = fs.realpathSync(tmp('view-inplace-'));
  const root = path.join(base, 'repo');
  write(root, 'Docs/backlog/index.md', '# Backlog\n\n- [ ] `tok` - Feature: Tokens\n');
  write(root, 'Docs/backlog/tok/brief.md', '# tok\n');
  git(root, 'init', '-q', '-b', 'main');
  const ctx = runContext(root, GIT_ENV);
  const status = (extra: object) => write(root, 'Docs/backlog/tok/logs/status.json', { state: 'running', stage: 'Spec', pid: process.pid, ...extra });
  status({});
  expect(runView(ctx, 'tok', { parts: ['live'] }).state).toBe('running');
  status({ pid_start: 'Thu Jan 1 00:00:00 1970' });
  expect(runView(ctx, 'tok', { parts: ['live'] }).state).toBe(process.platform === 'win32' ? 'running' : 'stopped');
});

describe('what the board is made from', () => {
  test('the folders to watch and the files of its fingerprint cover a run, the register and the backlog, with no git call', () => {
    const { root, wt, ctx } = repoWithRun('add-tokens', { state: 'exited', exit_code: '2' }, { 'questions.md': QUESTIONS, 'logs/status.json': { state: 'paused', stage: 'Spec' } });
    boardView(ctx); // fills what the board keeps (the main working tree)
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const bin = tmp('inputs-bin-');
    const log = path.join(bin, 'git-calls.txt');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${bin}:${saved}`;
    let got: ReturnType<typeof boardInputs>;
    try { got = boardInputs(ctx); } finally { process.env.PATH = saved; }
    expect(fs.existsSync(log)).toBe(false);
    const reg = path.join(root, '.git/sdlc-runs');
    const docs = path.join(wt, 'Docs/backlog/add-tokens');
    expect(got.folders).toEqual(expect.arrayContaining([reg, path.join(root, 'Docs/backlog'), path.join(root, 'Docs/backlog/add-tokens'), docs, path.join(docs, 'logs')]));
    expect(got.folders).toContain(root);
    // A folder that is not there yet is named too, so that the watcher can wait for it.
    const later = path.join(root, 'Docs/backlog/add-tokens/logs');
    expect(fs.existsSync(later)).toBe(false);
    expect(got.folders).toContain(later);
    expect(got.files).toEqual(expect.arrayContaining([
      path.join(reg, 'add-tokens.json'), path.join(root, 'Docs/backlog/index.md'), path.join(root, 'sdlc.config.json'),
      path.join(docs, 'questions.md'), path.join(docs, 'logs', 'status.json'), path.join(docs, 'logs', 'permissions.json'), path.join(docs, 'logs', 'tests.json'),
    ]));
    expect(got.files.some(f => f.endsWith('run.out'))).toBe(false);
    expect(got.files).toContain(path.join(reg, 'pr-status.cache'));
  });

  test('the pull request status file is not taken for a run', () => {
    const { root, ctx } = repoWithRun('add-tokens', { state: 'exited', exit_code: '2' });
    const before = boardView(ctx).runs.map(r => r.slug);
    fs.writeFileSync(path.join(root, '.git/sdlc-runs/pr-status.cache'), JSON.stringify({ version: 1, entries: {} }));
    const after = boardView(ctx).runs.map(r => r.slug);
    expect(after).not.toContain('pr-status');
    expect(after).toHaveLength(before.length);
  });

  test('a run\'s output, an agent\'s log, a temporary file and a heartbeat cannot change the board; a status and a record can', () => {
    expect(boardIgnores('/wt/Docs/backlog/tok/logs', 'run.out')).toBe(true);
    expect(boardIgnores('/wt/Docs/backlog/tok/logs', 'spec-1.json')).toBe(true);
    expect(boardIgnores('/wt/Docs/backlog/tok/logs', 'status.json')).toBe(false);
    expect(boardIgnores('/wt/Docs/backlog/tok/logs', 'status.json.tmp')).toBe(true);
    expect(boardIgnores('/repo/.git/sdlc-runs', 'tok.json')).toBe(false);
    expect(boardIgnores('/repo/.git/sdlc-runs', 'tok.json.123.0.tmp')).toBe(true);
    expect(boardIgnores('/repo/.git/sdlc-runs', 'tok.live.json')).toBe(true);
    expect(boardIgnores('/wt/Docs/backlog/tok', 'questions.md')).toBe(false);
    expect(boardIgnores('/repo', 'README.md', '/repo')).toBe(true);
    expect(boardIgnores('/repo', 'sdlc.config.json', '/repo')).toBe(false);
    expect(boardIgnores('/repo/.git/sdlc-runs', 'tok.json', '/repo')).toBe(false);
  });
});

describe('the trace of a board read', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { stopTrace(); process.env.PATH = savedPath; });

  test('every git call of a board read is in the trace, a run in Resolve conflicts included', () => {
    const { root, wt } = repoWithRun('add-tokens', { state: 'exited', exit_code: '1', finished: '2026-10-19T10:05:00' }, {
      'logs/status.json': { stage: 'Resolve conflicts', state: 'failed' },
      'logs/resolve-conflicts.json': { before: 'not-the-head' },
    });
    expect(fs.existsSync(wt)).toBe(true);
    // A git that logs one line per call and then runs the real one: the independent count of spawns.
    const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const bin = tmp('view-bin-');
    const log = path.join(bin, 'git-calls.txt');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho "$@" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${savedPath}`;
    const ctx = runContext(root, { ...GIT_ENV, PATH: process.env.PATH });
    const file = path.join(tmp('view-trace-'), 'ui-trace.jsonl');
    fs.rmSync(log, { force: true });
    stopTrace(); // drops the events kept from before a trace starts (the fixture's own git calls)
    startTrace({ file, settings: TRACE_DEFAULTS });
    const board = boardView(ctx);
    stopTrace();
    expect(board.runs.map(r => [r.slug, r.stage, r.state])).toEqual([['add-tokens', 'Resolve conflicts', 'failed']]);
    const seen = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const traced = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.action === 'spawn:git');
    expect(seen.some(l => l.includes('for-each-ref'))).toBe(true);
    expect(seen.some(l => l.includes('refs/sdlc-attempt/'))).toBe(true);
    expect(seen.some(l => l.includes('--grep'))).toBe(true);
    expect(traced).toHaveLength(seen.length);
  });
});

describe('worktreeInputs', () => {
  test('for a linked worktree and for a plain repository it names the HEAD and index files under the real git folder', () => {
    const { root, wt } = repoWithRun('tok', { exit_code: '0' });
    const linked = worktreeInputs(wt, path.join(root, '.git'), 'sdlc/tok');
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
    expect(linked.slice(0, 2).every(f => fs.existsSync(f))).toBe(true);
    expect(linked[0]).toMatch(/worktrees[\\/]tok[\\/]HEAD$/);
    expect(linked[1]).toMatch(/worktrees[\\/]tok[\\/]index$/);
    expect(linked).toContain(path.join(root, '.git', 'packed-refs'));
    expect(linked).toContain(path.join(root, '.git', 'refs', 'heads', 'sdlc', 'tok'));
    const plain = worktreeInputs(root, path.join(root, '.git'), 'main');
    expect(plain.slice(0, 2)).toEqual([path.join(root, '.git', 'HEAD'), path.join(root, '.git', 'index')]);
    expect(plain.slice(0, 2).every(f => fs.existsSync(f))).toBe(true);
    expect(worktreeInputs(root, null, '')).toHaveLength(2);
  });
});
