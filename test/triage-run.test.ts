import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import * as engine from '../src/index.js';
import { runContext } from '../src/runs/index.js';
import { parseQuestions } from '../src/runs/view.js';
import {
  answerTriageQuestions, buildTriageDraft, createTriageWorktree, newRunId, parseStreamLine, parseTriageItems,
  pendingTriageQuestions, removeTriageWorktree, triageAnsweredMessage, triageContinueMessage, triageItemPrompt,
  triagePrompt, triageRunDir, triageSplitPrompt,
} from '../src/triage.js';
import { tmp, write } from './helpers.js';

const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).stdout.trim();
const label = 'Docs/backlog/.triage/run-1/items.json';

function repo(commit = true): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.realpathSync(tmp('ai-sdlc-triage-run-'));
  write(dir, 'package.json', { scripts: { test: 'node --test' } });
  write(dir, 'Docs/backlog/index.md', '# Backlog\n\n- [x] `old-item` - Feature: done before\n');
  write(dir, 'Docs/backlog/old-item/brief.md', '# old-item\n');
  write(dir, '.gitignore', '');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'maintenance.auto', 'false');
  if (commit) { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init'); }
  const env = { ...process.env, ...GIT_ENV, SDLC_WT_BASE: path.join(dir, '..', `${path.basename(dir)}-wts`), AI_SDLC_HELPER_CONFIG_DIR: tmp('ai-sdlc-cfg-') };
  return { dir, env };
}

const goodItem = { slug: 'login-fails', type: 'bug', priority: 'P1 (high)', title: 'Login fails', summary: 'It breaks' };
const itemsFile = (value: unknown) => {
  const dir = tmp('ai-sdlc-items-');
  write(dir, 'items.json', typeof value === 'string' ? value : JSON.stringify(value));
  return path.join(dir, 'items.json');
};

describe('newRunId and triageRunDir', () => {
  it('ids are folder- and branch-safe and differ between calls', () => {
    const a = newRunId();
    expect(a).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(newRunId(new Date(2026, 9, 30, 14, 25, 1))).toMatch(/^20261030-142501-[0-9a-f]{4}$/);
    expect(new Set(Array.from({ length: 30 }, () => newRunId())).size).toBeGreaterThan(1);
  });
  it('the run folder sits under the backlog dir', () => {
    expect(triageRunDir('Docs/backlog', 'r1')).toBe('Docs/backlog/.triage/r1');
  });
  it('the package entry exports the dashboard-run helpers', () => {
    for (const k of ['newRunId', 'createTriageWorktree', 'removeTriageWorktree', 'parseTriageItems', 'buildTriageDraft', 'pendingTriageQuestions', 'answerTriageQuestions', 'parseStreamLine', 'triageSplitPrompt', 'triageItemPrompt', 'alive', 'killTree'] as const) {
      expect(typeof (engine as Record<string, unknown>)[k]).toBe('function');
    }
  });
});

describe('parseTriageItems', () => {
  it('a valid file gives its items in file order', () => {
    const second = { ...goodItem, slug: 'add-csv', type: 'feature' };
    expect(parseTriageItems(itemsFile([goodItem, second]), label)).toEqual([goodItem, second]);
  });
  it('an empty list is valid', () => {
    expect(parseTriageItems(itemsFile([]), label)).toEqual([]);
  });
  it('a missing file is rejected, naming the file', () => {
    expect(() => parseTriageItems(path.join(tmp(), 'items.json'), label)).toThrow(new RegExp(`${label}.*missing`));
  });
  it('invalid JSON is rejected, naming the file', () => {
    expect(() => parseTriageItems(itemsFile('{nope'), label)).toThrow(/items\.json is not valid JSON/);
  });
  it('a wrong shape is rejected', () => {
    expect(() => parseTriageItems(itemsFile({ slug: 'x' }), label)).toThrow(/must be a list of \{ slug, type, priority, title, summary \}/);
    expect(() => parseTriageItems(itemsFile([goodItem, { slug: 'b', type: 'bug' }]), label)).toThrow(/entry 1/);
    expect(() => parseTriageItems(itemsFile([{ ...goodItem, title: 5 }]), label)).toThrow(/entry 0/);
  });
  it('a bad slug is rejected', () => {
    for (const slug of ['Login Fails', 'UPPER', '-lead', 'a_b', '']) {
      expect(() => parseTriageItems(itemsFile([{ ...goodItem, slug }]), label)).toThrow(/slug/);
    }
  });
  it('a duplicate slug is rejected', () => {
    expect(() => parseTriageItems(itemsFile([goodItem, goodItem]), label)).toThrow(/'login-fails' appears twice/);
  });
});

describe('buildTriageDraft', () => {
  function worktree(brief: string | null, index = '# Backlog\n- [ ] `x` - Bug: Login fails\n') {
    const wt = tmp('ai-sdlc-draft-');
    if (brief !== null) write(wt, 'Docs/backlog/x/brief.md', brief);
    write(wt, 'Docs/backlog/index.md', index);
    return wt;
  }
  const brief = '# x\n\nType: bug\nPriority: P1 (blocks use)\n\nBody\n';

  it('takes the brief text, type, priority and the title after the Bug: tag', () => {
    expect(buildTriageDraft(worktree(brief), 'Docs/backlog', 'x')).toEqual({ slug: 'x', type: 'bug', priority: 'P1 (blocks use)', title: 'Login fails', brief });
  });
  it('strips Feature: case-insensitively and lowercases the type', () => {
    const wt = worktree('Type: Feature\nPriority: P3\n', '- [ ] `x` - feature:   Dark mode\n');
    expect(buildTriageDraft(wt, 'Docs/backlog', 'x')).toMatchObject({ type: 'feature', title: 'Dark mode', priority: 'P3' });
  });
  it('a missing Priority line gives an empty priority', () => {
    expect(buildTriageDraft(worktree('Type: bug\n'), 'Docs/backlog', 'x').priority).toBe('');
  });
  it('a bad Type is rejected, naming the slug and file', () => {
    expect(() => buildTriageDraft(worktree('Type: chore\n'), 'Docs/backlog', 'x')).toThrow(/x.*Docs\/backlog\/x\/brief\.md.*chore/);
  });
  it('a missing brief is rejected, naming the slug and file', () => {
    expect(() => buildTriageDraft(worktree(null), 'Docs/backlog', 'x')).toThrow(/x.*brief\.md.*missing/);
  });
  it('a brief with no index line is rejected, naming the index', () => {
    expect(() => buildTriageDraft(worktree('Type: bug\n', '# Backlog\n'), 'Docs/backlog', 'x')).toThrow(/index\.md has no line for x/);
  });
});

describe('triage questions', () => {
  const text = '### Q1: One\nFirst?\n**Suggested:** yes\n**Answer:**\n\n### Q2: Two\nSecond?\n**Suggested:** no\n**Answer:**\n';
  const file = () => { const d = tmp('ai-sdlc-q-'); write(d, 'x-questions.md', text); return path.join(d, 'x-questions.md'); };

  it('a missing file has no questions', () => {
    expect(pendingTriageQuestions(path.join(tmp(), 'none.md'))).toEqual([]);
  });
  it('finds the unanswered questions with id, text and suggested value', () => {
    const q = pendingTriageQuestions(file());
    expect(q.map(x => x.id)).toEqual(['Q1', 'Q2']);
    expect(q[0]).toMatchObject({ suggested: 'yes' });
    expect(q[0].text).toContain('One');
    expect(q[0].text).toContain('First?');
  });
  it('a missing answer throws and leaves the file unchanged', () => {
    const f = file();
    expect(() => answerTriageQuestions(f, { Q1: 'accept' })).toThrow(/Q2/);
    expect(fs.readFileSync(f, 'utf8')).toBe(text);
  });
  it('a blank answer, a bad id or an unknown question throws and writes nothing', () => {
    const f = file();
    expect(() => answerTriageQuestions(f, { Q1: 'a', Q2: '   ' })).toThrow(/Q2/);
    expect(() => answerTriageQuestions(f, { Q1: 'a', Q2: 'b', nope: 'c' })).toThrow(/not a question id/);
    expect(() => answerTriageQuestions(f, { Q1: 'a', Q2: 'b', Q9: 'c' })).toThrow();
    expect(fs.readFileSync(f, 'utf8')).toBe(text);
  });
  it('after answering, none remain; "accept" is kept as written', () => {
    const f = file();
    answerTriageQuestions(f, { Q1: 'accept', Q2: 'Use X' });
    expect(pendingTriageQuestions(f)).toEqual([]);
    expect(parseQuestions(fs.readFileSync(f, 'utf8')).map(q => q.answer)).toEqual(['accept', 'Use X']);
  });
});

describe('prompts', () => {
  const { dir, env } = repo();
  const report = 'Login fails on Safari';
  const item = goodItem;

  it('the split prompt is headless, holds the report and skill, and names items.json', () => {
    const p = triageSplitPrompt(dir, report, 'Docs/backlog/.triage/r1', { env });
    expect(p.startsWith(triagePrompt(dir, report, { headless: true, env }).trim())).toBe(true);
    expect(p).toContain('## The report\n' + report);
    expect(p).toContain('Docs/backlog/.triage/r1/items.json');
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
  it('the interactive item prompt names the slug and the questions file, and is not headless', () => {
    const p = triageItemPrompt(dir, report, item, 'Docs/backlog/.triage/r1', { headless: false, env });
    expect(p).toContain('login-fails');
    expect(p).toContain('Docs/backlog/.triage/r1/login-fails-questions.md');
    expect(p).not.toContain('This run is headless');
    expect(p.startsWith(triagePrompt(dir, report, { headless: true, env }).trim())).toBe(false);
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
  it('the quick item prompt is headless and has no questions file', () => {
    const p = triageItemPrompt(dir, report, item, 'Docs/backlog/.triage/r1', { headless: true, env });
    expect(p.startsWith(triagePrompt(dir, report, { headless: true, env }).trim())).toBe(true);
    expect(p).not.toContain('login-fails-questions.md');
    expect(p).toContain('login-fails');
  });
  it('the answered and continue messages are filled in', () => {
    expect(triageAnsweredMessage('Docs/backlog/.triage/r1/x-questions.md')).toContain('Docs/backlog/.triage/r1/x-questions.md');
    expect(triageContinueMessage().length).toBeGreaterThan(0);
    expect(triageContinueMessage()).not.toMatch(/\{\{/);
  });
});

describe('parseStreamLine', () => {
  it('reads the session id', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","session_id":"s-1"}')).toMatchObject({ sessionId: 's-1', texts: [], tools: [] });
  });
  it('reads prose and a tool call with a one-line summary', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'text', text: 'Reading the backlog' }, { type: 'text', text: '   ' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'src/triage.ts' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls\n-la ' + 'x'.repeat(300) } },
      { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
    ] } });
    const part = parseStreamLine(line);
    expect(part.texts).toEqual(['Reading the backlog']);
    expect(part.tools[0]).toEqual({ name: 'Read', summary: 'Read src/triage.ts' });
    expect(part.tools[1].summary).not.toContain('\n');
    expect(part.tools[1].summary.length).toBeLessThanOrEqual(130);
    expect(part.tools[2]).toEqual({ name: 'TodoWrite', summary: 'TodoWrite' });
  });
  it('ignores thinking, non-JSON and unrelated lines', () => {
    const thinking = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret' }] } });
    expect(parseStreamLine(thinking)).toEqual({ texts: [], tools: [] });
    expect(parseStreamLine('not json')).toEqual({ texts: [], tools: [] });
    expect(parseStreamLine('')).toEqual({ texts: [], tools: [] });
  });
});

describe('createTriageWorktree and removeTriageWorktree', () => {
  it('creates the worktree and branch from the base, copies only the uncommitted pieces, commits nothing', () => {
    const { dir, env } = repo();
    write(dir, 'sdlc.config.json', { suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } });
    write(dir, 'Docs/backlog/index.md', '# Backlog\n\n- [x] `old-item` - Feature: done before\n- [ ] `fresh` - Bug: new\n');
    write(dir, 'Docs/backlog/fresh/brief.md', '# fresh\n');
    write(dir, 'src/other.js', 'x\n');
    const ctx = runContext(dir, env);
    const before = git(dir, 'rev-list', '--all', '--count');
    const r = createTriageWorktree(ctx, 'run-1');
    expect(r.worktree).toBe(path.join(ctx.wtBase, 'triage-run-1'));
    expect(r.branch).toBe(`${ctx.branchPrefix}triage-run-1`);
    expect(git(dir, 'branch', '--list', r.branch)).toContain(r.branch);
    expect(fs.existsSync(path.join(r.worktree, 'sdlc.config.json'))).toBe(true);
    expect(fs.readFileSync(path.join(r.worktree, 'Docs/backlog/index.md'), 'utf8')).toContain('`fresh`');
    expect(fs.existsSync(path.join(r.worktree, 'Docs/backlog/fresh/brief.md'))).toBe(true);
    expect(fs.existsSync(path.join(r.worktree, 'src/other.js'))).toBe(false);
    expect(git(dir, 'rev-list', '--all', '--count')).toBe(before);

    removeTriageWorktree(ctx, r.worktree, r.branch);
    expect(fs.existsSync(r.worktree)).toBe(false);
    expect(git(dir, 'branch', '--list', r.branch)).toBe('');
  });
  it('a repository with no commit is refused with start\'s text, leaving nothing behind', () => {
    const { dir, env } = repo(false);
    const ctx = runContext(dir, env);
    expect(() => createTriageWorktree(ctx, 'run-2')).toThrow('the repository has no commit to start the branch from');
    expect(fs.existsSync(path.join(ctx.wtBase, 'triage-run-2'))).toBe(false);
    expect(git(dir, 'branch', '--list')).toBe('');
  });
  it('an existing folder or branch is refused without touching them', () => {
    const { dir, env } = repo();
    const ctx = runContext(dir, env);
    fs.mkdirSync(path.join(ctx.wtBase, 'triage-run-3'), { recursive: true });
    expect(() => createTriageWorktree(ctx, 'run-3')).toThrow(/already exists/);
    expect(fs.existsSync(path.join(ctx.wtBase, 'triage-run-3'))).toBe(true);
    git(dir, 'branch', `${ctx.branchPrefix}triage-run-4`);
    expect(() => createTriageWorktree(ctx, 'run-4')).toThrow(/branch .* already exists/);
    expect(fs.existsSync(path.join(ctx.wtBase, 'triage-run-4'))).toBe(false);
  });
});
