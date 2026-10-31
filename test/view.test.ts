import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { answerQuestions, boardView, parseQuestions, resumeStage, runView } from '../src/runs/view.js';
import { runContext } from '../src/runs/index.js';
import { addBacklogItem, backlogItems } from '../src/backlog/index.js';
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

  test('counts the files the run changed in its worktree', () => {
    const { ctx } = repoWithRun('add-tokens', { state: 'exited', exit_code: '1' }, { 'logs/status.json': { state: 'failed', stage: 'Implement' } });
    const v = runView(ctx, 'add-tokens');
    expect(v.state).toBe('failed');
    expect(v.resumeFrom).toBe('implement');
    expect(v.changes).toEqual(expect.objectContaining({ uncommitted: expect.any(Number), changed: expect.any(Number) }));
    expect(v.changes!.files.some(f => f.includes('status.json'))).toBe(true);
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
