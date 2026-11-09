import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import { BacklogEditError, editBacklogItem, readBacklogEdit, type ItemEdit } from '../src/backlog/index.js';
import { runContext } from '../src/runs/index.js';
import { tmp, write } from './helpers.js';

const tick = setImmediate;
beforeEach(() => new Promise(r => tick(r)));

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const INDEX = [
  '# Backlog',
  '',
  '- [ ] `one` - Feature: First thing',
  '- [!] `blk` - Bug: Blocked thing (blocked: waits on api)',
  '- [~] `prk` - Parked no label (parked: later)',
  '- [x] `done` - Feature: Finished',
  '- [ ] `nobrief` - Feature: No brief yet',
  '',
  '## Archive',
  '',
  '- [ ] `old` - Feature: Archived',
  '',
].join('\n');

const ONE_BRIEF = '# one\n\nType: feature\nPriority: P2 (normal)\n';
const INDEX_REL = 'Docs/backlog/index.md';

function fixture(index = INDEX) {
  const base = fs.realpathSync(tmp('backlog-edit-'));
  const root = path.join(base, 'repo');
  write(root, 'sdlc.config.json', { suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: 'npm test', testGlobs: ['test/**/*.test.js'] }], agent: { codeSearch: 'none' } });
  write(root, INDEX_REL, index);
  write(root, 'Docs/backlog/one/brief.md', ONE_BRIEF);
  write(root, 'Docs/backlog/blk/brief.md', '# blk\n\nBody\n');
  write(root, 'Docs/backlog/prk/brief.md', '# prk\n\nBody\n');
  write(root, 'Docs/backlog/done/brief.md', '# done\n');
  write(root, 'Docs/backlog/old/brief.md', '# old\n');
  write(root, 'Docs/backlog/stray/brief.md', '# stray\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const ctx = runContext(root, { ...GIT_ENV, SDLC_WT_BASE: path.join(base, 'wts') });
  const file = (rel: string) => path.join(root, rel);
  const text = (rel: string) => fs.readFileSync(file(rel), 'utf8');
  const snapshot = () => ({ index: text(INDEX_REL), one: text('Docs/backlog/one/brief.md') });
  return { base, root, ctx, file, text, snapshot };
}

const caught = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return undefined; };

const okEdit = (over: Partial<ItemEdit> & { hash: string }): ItemEdit => ({ title: 'New title', type: 'feature', brief: '# x\n', ...over });

function expectRefused(fn: () => unknown, status: number, message?: RegExp | string) {
  const e = caught(fn);
  expect(e).toBeInstanceOf(BacklogEditError);
  expect((e as BacklogEditError).status).toBe(status);
  if (message) expect((e as BacklogEditError).message).toMatch(message);
  return e as BacklogEditError;
}

describe('readBacklogEdit', () => {
  it('describes a pending item with its title, type, priority, brief and version', () => {
    const { ctx } = fixture();
    const v = readBacklogEdit(ctx, 'one');
    expect(v).toEqual(expect.objectContaining({
      slug: 'one', title: 'First thing', type: 'feature', priority: 'P2 (normal)', brief: ONE_BRIEF,
      marker: ' ', status: 'pending', archived: false, editable: true, reason: '',
    }));
    expect(v.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(readBacklogEdit(ctx, 'one').hash).toBe(v.hash);
  });

  it('strips the type label and the blocked/parked note from the title; takes the label as type', () => {
    const { ctx } = fixture();
    const blk = readBacklogEdit(ctx, 'blk');
    expect(blk).toEqual(expect.objectContaining({ title: 'Blocked thing', type: 'bug', marker: '!', status: 'blocked', editable: true, priority: null }));
    const prk = readBacklogEdit(ctx, 'prk');
    expect(prk).toEqual(expect.objectContaining({ title: 'Parked no label', type: 'feature', marker: '~', status: 'parked', editable: true }));
  });

  it("takes the type from the brief's Type: line when the index line has no label", () => {
    const { ctx, file } = fixture();
    fs.writeFileSync(file('Docs/backlog/prk/brief.md'), '# prk\n\nType: Bug\n');
    expect(readBacklogEdit(ctx, 'prk').type).toBe('bug');
  });

  it('the version covers the brief and the item\'s own line, not other lines', () => {
    const { ctx, file } = fixture();
    const before = readBacklogEdit(ctx, 'one').hash;
    fs.writeFileSync(file(INDEX_REL), INDEX.replace('Blocked thing', 'Blocked other'));
    expect(readBacklogEdit(ctx, 'one').hash).toBe(before);
    fs.writeFileSync(file('Docs/backlog/one/brief.md'), `${ONE_BRIEF}more\n`);
    const afterBrief = readBacklogEdit(ctx, 'one').hash;
    expect(afterBrief).not.toBe(before);
    fs.writeFileSync(file(INDEX_REL), INDEX.replace('First thing', 'First thing!'));
    expect(readBacklogEdit(ctx, 'one').hash).not.toBe(afterBrief);
  });

  it('an indexed item without brief.md reads brief null, and its version equals that of an empty brief', () => {
    const a = fixture();
    const v = readBacklogEdit(a.ctx, 'nobrief');
    expect(v).toEqual(expect.objectContaining({ brief: null, type: 'feature', editable: true }));
    const b = fixture();
    write(b.root, 'Docs/backlog/nobrief/brief.md', '');
    expect(readBacklogEdit(b.ctx, 'nobrief').hash).toBe(v.hash);
  });

  it('a completed item and an archived item are not editable', () => {
    const { ctx } = fixture();
    const done = readBacklogEdit(ctx, 'done');
    expect(done).toEqual(expect.objectContaining({ editable: false, status: 'completed', archived: false }));
    expect(done.reason).not.toBe('');
    const old = readBacklogEdit(ctx, 'old');
    expect(old).toEqual(expect.objectContaining({ editable: false, archived: true }));
    expect(old.reason).toMatch(/completed or archived/);
  });

  it('an unknown slug is a 404, even when it has a brief.md; so is an unsafe slug', () => {
    const { ctx } = fixture();
    expectRefused(() => readBacklogEdit(ctx, 'stray'), 404, 'stray is not in Docs/backlog/index.md');
    expectRefused(() => readBacklogEdit(ctx, 'nope'), 404, 'nope is not in Docs/backlog/index.md');
    expectRefused(() => readBacklogEdit(ctx, '../one'), 404);
  });

  it('a missing index.md makes every slug unknown (404)', () => {
    const { ctx, file } = fixture();
    fs.rmSync(file(INDEX_REL));
    expectRefused(() => readBacklogEdit(ctx, 'one'), 404);
  });
});

describe('editBacklogItem', () => {
  it('changes brief.md and the item\'s index line, and nothing else (criteria 1-3)', () => {
    const { root, ctx, text } = fixture();
    const commits = git(root, 'rev-list', '--count', 'HEAD');
    const v = readBacklogEdit(ctx, 'one');
    const r = editBacklogItem(ctx, 'one', {
      title: '  Brand new title  ', type: 'bug', priority: 'P1 (high)', hash: v.hash,
      brief: '# one\n\nType: feature\nPriority: P2 (normal)\nBody',
    });
    expect(r.ok).toBe(true);
    expect(r.notSaved).toEqual([]);
    expect(r.index).toBe(path.join(root, INDEX_REL));
    expect(r.brief).toBe(path.join(root, 'Docs/backlog/one/brief.md'));
    expect(text('Docs/backlog/one/brief.md')).toBe('# one\n\nType: bug\nPriority: P1 (high)\nBody\n');
    expect(text(INDEX_REL)).toBe(INDEX.replace('- [ ] `one` - Feature: First thing', '- [ ] `one` - Bug: Brand new title'));
    expect(git(root, 'status', '--porcelain').split('\n').map(l => l.trim()).sort())
      .toEqual(['M Docs/backlog/index.md', 'M Docs/backlog/one/brief.md']);
    expect(git(root, 'rev-list', '--count', 'HEAD')).toBe(commits);
    expect(fs.readdirSync(path.join(root, 'Docs/backlog')).sort()).toEqual(['blk', 'done', 'index.md', 'old', 'one', 'prk', 'stray']);
    expect(fs.readdirSync(path.join(root, 'Docs/backlog/one'))).toEqual(['brief.md']);
    expect(r.hash).toBe(readBacklogEdit(ctx, 'one').hash);
  });

  it('leaves no temporary file behind and ignores a slug field in the payload (criterion 3)', () => {
    const { root, ctx, text } = fixture();
    const v = readBacklogEdit(ctx, 'one');
    editBacklogItem(ctx, 'one', { ...okEdit({ hash: v.hash }), slug: 'renamed' } as ItemEdit);
    expect(text(INDEX_REL).match(/^- \[.\] `/gm)).toHaveLength(6);
    expect(text(INDEX_REL)).toContain('`one` - Feature: New title');
    expect(text(INDEX_REL)).not.toContain('renamed');
    expect(fs.existsSync(path.join(root, 'Docs/backlog/renamed'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'Docs/backlog')).filter(n => n.includes('.tmp'))).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'Docs/backlog/one'))).toEqual(['brief.md']);
  });

  it('keeps the checkbox marker and the blocked/parked note; adds the label when the line had none (criterion 2)', () => {
    const { ctx, text } = fixture();
    const blk = readBacklogEdit(ctx, 'blk');
    const r1 = editBacklogItem(ctx, 'blk', { title: 'Blocked retitled', type: 'feature', priority: 'P1 (high)', brief: '# blk\n\nBody', hash: blk.hash });
    expect(r1.notSaved).toEqual(['type', 'priority']);
    expect(text('Docs/backlog/blk/brief.md')).toBe('# blk\n\nBody\n');
    const prk = readBacklogEdit(ctx, 'prk');
    const r2 = editBacklogItem(ctx, 'prk', { title: 'Park title', type: 'feature', brief: '# prk\n\nBody\n', hash: prk.hash });
    expect(r2.notSaved).toEqual([]);
    const lines = text(INDEX_REL).split('\n');
    expect(lines).toContain('- [!] `blk` - Feature: Blocked retitled (blocked: waits on api)');
    expect(lines).toContain('- [~] `prk` - Feature: Park title (parked: later)');
    expect(readBacklogEdit(ctx, 'blk')).toEqual(expect.objectContaining({ status: 'blocked', title: 'Blocked retitled', editable: true }));
    expect(readBacklogEdit(ctx, 'prk')).toEqual(expect.objectContaining({ status: 'parked', title: 'Park title' }));
  });

  it('leaves the brief\'s Type:/Priority: lines as typed when the selects are unchanged (criterion 11)', () => {
    const { ctx, text } = fixture();
    const v = readBacklogEdit(ctx, 'one');
    const brief = '# one\n\nType: bug\nPriority: P0 (security or data loss)\n';
    const r = editBacklogItem(ctx, 'one', { title: 'First thing', type: 'feature', brief, hash: v.hash });
    expect(r.notSaved).toEqual([]);
    expect(text('Docs/backlog/one/brief.md')).toBe(brief);
  });

  it('changing only the type rewrites the first Type: value; changing only the priority rewrites the first Priority: value', () => {
    const a = fixture();
    const va = readBacklogEdit(a.ctx, 'one');
    editBacklogItem(a.ctx, 'one', { title: 'First thing', type: 'bug', brief: 'Type: feature\nType: feature\nPriority: P2 (normal)\n', hash: va.hash });
    expect(a.text('Docs/backlog/one/brief.md')).toBe('Type: bug\nType: feature\nPriority: P2 (normal)\n');
    expect(a.text(INDEX_REL)).toContain('`one` - Bug: First thing');

    const b = fixture();
    const vb = readBacklogEdit(b.ctx, 'one');
    editBacklogItem(b.ctx, 'one', { title: 'First thing', type: 'feature', priority: 'P3 (low)', brief: ONE_BRIEF, hash: vb.hash });
    expect(b.text('Docs/backlog/one/brief.md')).toBe('# one\n\nType: feature\nPriority: P3 (low)\n');
    expect(b.text(INDEX_REL)).toBe(INDEX);
  });

  it('does not add a Type:/Priority: line the brief lacks, and says which were not saved', () => {
    const { ctx, text } = fixture();
    const v = readBacklogEdit(ctx, 'one');
    const r = editBacklogItem(ctx, 'one', { title: 'T', type: 'bug', priority: 'P0 (security or data loss)', brief: '# one\n\njust text\n', hash: v.hash });
    expect(r.notSaved).toEqual(['type', 'priority']);
    expect(text('Docs/backlog/one/brief.md')).toBe('# one\n\njust text\n');
  });

  it('keeps CRLF line endings and the trailing newline of index.md (and the other lines byte for byte)', () => {
    const crlf = INDEX.replace(/\n/g, '\r\n');
    const { ctx, text } = fixture(crlf);
    const v = readBacklogEdit(ctx, 'one');
    expect(v.title).toBe('First thing');
    editBacklogItem(ctx, 'one', okEdit({ hash: v.hash, title: 'Windows' }));
    expect(text(INDEX_REL)).toBe(crlf.replace('Feature: First thing', 'Feature: Windows'));
    const blk = readBacklogEdit(ctx, 'blk');
    editBacklogItem(ctx, 'blk', okEdit({ hash: blk.hash, title: 'Still blocked' }));
    expect(text(INDEX_REL)).toContain('- [!] `blk` - Feature: Still blocked (blocked: waits on api)\r\n');
  });

  it('keeps an index.md without a trailing newline as it was', () => {
    const idx = INDEX.replace(/\n$/, '');
    const { ctx, text } = fixture(idx);
    const v = readBacklogEdit(ctx, 'one');
    editBacklogItem(ctx, 'one', okEdit({ hash: v.hash }));
    expect(text(INDEX_REL)).toBe(idx.replace('Feature: First thing', 'Feature: New title'));
  });

  describe('stale versions', () => {
    it('refuses when brief.md changed after reading, with the current hash, and writes nothing (criterion 4)', () => {
      const { ctx, file, snapshot } = fixture();
      const v = readBacklogEdit(ctx, 'one');
      fs.writeFileSync(file('Docs/backlog/one/brief.md'), `${ONE_BRIEF}changed elsewhere\n`);
      const before = snapshot();
      const e = expectRefused(() => editBacklogItem(ctx, 'one', okEdit({ hash: v.hash })), 409, /changed since you opened it; reload/);
      expect(e.hash).toBe(readBacklogEdit(ctx, 'one').hash);
      expect(snapshot()).toEqual(before);
    });

    it('refuses when the item\'s own index line changed after reading', () => {
      const { ctx, file, snapshot } = fixture();
      const v = readBacklogEdit(ctx, 'one');
      fs.writeFileSync(file(INDEX_REL), INDEX.replace('First thing', 'Someone else retitled'));
      const before = snapshot();
      const e = expectRefused(() => editBacklogItem(ctx, 'one', okEdit({ hash: v.hash })), 409, /changed since you opened it; reload/);
      expect(e.hash).toBe(readBacklogEdit(ctx, 'one').hash);
      expect(snapshot()).toEqual(before);
    });

    it('a changed line of a different item is not stale, and that change is kept (criterion 5)', () => {
      const { ctx, file, text } = fixture();
      const v = readBacklogEdit(ctx, 'one');
      fs.writeFileSync(file(INDEX_REL), INDEX.replace('Blocked thing', 'Blocked, reworded'));
      editBacklogItem(ctx, 'one', okEdit({ hash: v.hash }));
      expect(text(INDEX_REL)).toContain('`blk` - Bug: Blocked, reworded (blocked: waits on api)');
      expect(text(INDEX_REL)).toContain('`one` - Feature: New title');
    });

    it('a second save with the version of the first read is stale', () => {
      const { ctx } = fixture();
      const v = readBacklogEdit(ctx, 'one');
      editBacklogItem(ctx, 'one', okEdit({ hash: v.hash }));
      expectRefused(() => editBacklogItem(ctx, 'one', okEdit({ hash: v.hash, title: 'Again' })), 409, /reload/);
    });

    it('the hash returned by a save is accepted by the next save', () => {
      const { ctx, text } = fixture();
      const r = editBacklogItem(ctx, 'one', okEdit({ hash: readBacklogEdit(ctx, 'one').hash }));
      editBacklogItem(ctx, 'one', okEdit({ hash: r.hash, title: 'Second' }));
      expect(text(INDEX_REL)).toContain('`one` - Feature: Second');
    });
  });

  describe('items whose pipeline has started (criterion 6)', () => {
    const REC = { slug: 'one', worktree: '', pid: 0, started: '2026-10-19T10:00:00', interrupted: false, finished: '', message: '' };
    const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
      ['a running record', f => write(f.ctx.reg, 'one.json', { ...REC, state: 'running', exit_code: '' })],
      ['a failed record', f => write(f.ctx.reg, 'one.json', { ...REC, state: 'exited', exit_code: '1' })],
      ['a done record', f => write(f.ctx.reg, 'one.json', { ...REC, state: 'exited', exit_code: '0' })],
      ['an interrupted record', f => write(f.ctx.reg, 'one.json', { ...REC, state: 'exited', exit_code: '1', interrupted: true })],
      ['a refused start record', f => write(f.ctx.reg, 'one.json', { ...REC, state: 'exited', exit_code: '1', message: 'refused' })],
      ['a record that is not JSON', f => write(f.ctx.reg, 'one.json', 'not json')],
      ['a branch and no record', f => { git(f.root, 'branch', 'sdlc/one'); }],
      ['a worktree directory and no record', f => fs.mkdirSync(path.join(f.base, 'wts', 'one'), { recursive: true })],
      ['an in-place logs/status.json', f => write(f.root, 'Docs/backlog/one/logs/status.json', { state: 'paused' })],
    ];

    it.each(cases)('%s: write is refused with 409 and nothing is written; read says not editable', (_name, start) => {
      const f = fixture();
      const v = readBacklogEdit(f.ctx, 'one');
      start(f);
      const before = f.snapshot();
      expectRefused(() => editBacklogItem(f.ctx, 'one', okEdit({ hash: v.hash })), 409, /stop the run and discard it/);
      expect(f.snapshot()).toEqual(before);
      const after = readBacklogEdit(f.ctx, 'one');
      expect(after.editable).toBe(false);
      expect(after.reason).toMatch(/stop the run and discard it/);
      expect(after.reason).toContain('`one`');
    });

    it('a started refusal is checked before the version: a fresh hash still gets refused', () => {
      const f = fixture();
      git(f.root, 'branch', 'sdlc/one');
      const v = readBacklogEdit(f.ctx, 'one');
      expectRefused(() => editBacklogItem(f.ctx, 'one', okEdit({ hash: v.hash })), 409, /has started/);
    });

    it('a started item stays editable for its neighbours: another slug is unaffected', () => {
      const f = fixture();
      git(f.root, 'branch', 'sdlc/one');
      expect(readBacklogEdit(f.ctx, 'blk').editable).toBe(true);
    });
  });

  it('a discarded run (only a .discarded marker left) is editable again (criterion 7)', () => {
    const f = fixture();
    write(f.ctx.reg, 'one.discarded', '');
    const v = readBacklogEdit(f.ctx, 'one');
    expect(v.editable).toBe(true);
    editBacklogItem(f.ctx, 'one', okEdit({ hash: v.hash }));
    expect(f.text(INDEX_REL)).toContain('`one` - Feature: New title');
  });

  it('an unknown slug is a 404 on write, with nothing written and no new line or folder (criteria 3, 8)', () => {
    const f = fixture();
    const before = f.snapshot();
    for (const slug of ['stray', 'nope', '../one']) {
      expectRefused(() => editBacklogItem(f.ctx, slug, okEdit({ hash: 'x' })), 404, `${slug} is not in Docs/backlog/index.md`);
    }
    expect(f.snapshot()).toEqual(before);
    expect(f.text('Docs/backlog/stray/brief.md')).toBe('# stray\n');
    expect(fs.existsSync(f.file('Docs/backlog/nope'))).toBe(false);
  });

  it('a completed item and an archived item are refused with 400 and nothing is written (criterion 9)', () => {
    const f = fixture();
    const before = f.snapshot();
    for (const slug of ['done', 'old']) {
      const v = readBacklogEdit(f.ctx, slug);
      expectRefused(() => editBacklogItem(f.ctx, slug, okEdit({ hash: v.hash })), 400, /completed or archived/);
    }
    expect(f.snapshot()).toEqual(before);
    expect(f.text('Docs/backlog/done/brief.md')).toBe('# done\n');
    expect(f.text('Docs/backlog/old/brief.md')).toBe('# old\n');
  });

  it('an indexed item with no brief.md can be saved, which creates brief.md (criterion 10)', () => {
    const f = fixture();
    const v = readBacklogEdit(f.ctx, 'nobrief');
    expect(v.brief).toBeNull();
    expect(fs.existsSync(f.file('Docs/backlog/nobrief'))).toBe(false);
    const r = editBacklogItem(f.ctx, 'nobrief', { title: 'Now with brief', type: 'bug', brief: '# nobrief\n\nType: feature\n', hash: v.hash });
    expect(r.notSaved).toEqual([]);
    expect(f.text('Docs/backlog/nobrief/brief.md')).toBe('# nobrief\n\nType: bug\n');
    expect(f.text(INDEX_REL)).toContain('- [ ] `nobrief` - Bug: Now with brief');
    expect(readBacklogEdit(f.ctx, 'nobrief').brief).toBe('# nobrief\n\nType: bug\n');
  });

  describe('invalid fields (criterion 12)', () => {
    const cases: [string, Partial<ItemEdit>, RegExp][] = [
      ['a two-line title', { title: 'one\ntwo' }, /title must be one non-empty line/],
      ['a title with a carriage return', { title: 'one\rtwo' }, /title must be one non-empty line/],
      ['a blank title', { title: '   ' }, /title must be one non-empty line/],
      ['type chore', { type: 'chore' }, /type must be feature or bug, not 'chore'/],
      ['priority P9', { priority: 'P9' }, /priority must be one of .*, not 'P9'/],
      ['a blank brief', { brief: ' \n ' }, /brief must not be empty/],
      ['a missing hash', { hash: undefined as unknown as string }, /hash/],
      ['an empty hash', { hash: '' }, /hash/],
    ];

    it.each(cases)('%s: 400 and nothing is written', (_name, over, message) => {
      const f = fixture();
      const v = readBacklogEdit(f.ctx, 'one');
      const before = f.snapshot();
      expectRefused(() => editBacklogItem(f.ctx, 'one', { ...okEdit({ hash: v.hash }), ...over }), 400, message);
      expect(f.snapshot()).toEqual(before);
    });

    it('accepts each of the four priority options', () => {
      const f = fixture();
      for (const p of ['P0 (security or data loss)', 'P1 (high)', 'P2 (normal)', 'P3 (low)']) {
        const hash = readBacklogEdit(f.ctx, 'one').hash;
        editBacklogItem(f.ctx, 'one', okEdit({ hash, priority: p, brief: ONE_BRIEF }));
        expect(f.text('Docs/backlog/one/brief.md')).toBe(`# one\n\nType: feature\nPriority: ${p}\n`);
      }
    });
  });

});
