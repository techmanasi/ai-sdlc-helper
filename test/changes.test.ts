import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';
import { main } from '../src/cli/main.js';
import { tmp } from './helpers.js';

// These tests run git synchronously: yield between them so the test runner's messages get through.
afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));

const sh = (dir, cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
const write = (dir, f, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), text);
};

/** Runs the command line in-process from <cwd>. */
async function cli(cwd: string, ...args: string[]) {
  let stdout = '';
  let stderr = '';
  const status = await main(args, { out: t => { stdout += `${t}\n`; }, err: t => { stderr += `${t}\n`; }, cwd });
  await new Promise(resolve => setImmediate(resolve)); // let the test runner's messages through between git-heavy calls
  return { status, stdout, stderr };
}

function repo() {
  const dir = tmp('sdlc-changes-');
  sh(dir, 'git', ['init', '-q']);
  sh(dir, 'git', ['config', 'user.email', 't@t']);
  sh(dir, 'git', ['config', 'user.name', 't']);
  write(dir, '.gitignore', 'node_modules/\n.env\nignored.txt\n');
  write(dir, 'tracked.txt', 'one\n');
  write(dir, 'gone.txt', 'bye\n');
  write(dir, 'old.txt', 'rename me\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'init']);
  return dir;
}
const base = dir => `${dir}-base.json`;
const snapshot = dir => cli(dir, 'changes', 'snapshot', base(dir));
const changed = async dir => JSON.parse((await cli(dir, 'changes', 'changed', base(dir))).stdout);

describe('changes snapshot', () => {
  test('records modified, untracked, deleted and staged paths with hashes', async () => {
    const dir = repo();
    write(dir, 'tracked.txt', 'changed\n');
    write(dir, 'new.txt');
    fs.unlinkSync(path.join(dir, 'gone.txt'));
    write(dir, 'staged.txt');
    sh(dir, 'git', ['add', 'staged.txt']);
    expect((await snapshot(dir)).status).toBe(0);
    const files = JSON.parse(fs.readFileSync(base(dir), 'utf8')).files;
    expect(Object.keys(files).sort()).toEqual(['gone.txt', 'new.txt', 'staged.txt', 'tracked.txt']);
    expect(files['gone.txt']).toBeNull();
    expect(files['new.txt']).toMatch(/^[0-9a-f]{40}$/);
    expect(files['new.txt']).not.toBe(files['tracked.txt']);
    expect(files['new.txt']).toBe(sh(dir, 'git', ['hash-object', 'new.txt']).stdout.trim());
  });

  test('works from a sub-folder of the repository; a wrong sub-command exits 1 with the usage', async () => {
    const dir = repo();
    write(dir, 'sub/a.txt');
    expect((await cli(path.join(dir, 'sub'), 'changes', 'snapshot', '../snap.json')).status).toBe(0);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'snap.json'), 'utf8')).files)).toEqual(['sub/a.txt']);

    const r = await cli(dir, 'changes', 'bogus', 'x.json');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('usage: ai-sdlc-helper changes');
    expect((await cli(dir, 'changes', 'changed')).status).toBe(1);
  });
});

describe('changes changed', () => {
  test('new, edited, deleted and renamed files are included; a .gitignored file is never listed', async () => {
    let dir = repo();
    await snapshot(dir);
    write(dir, 'new.txt');
    write(dir, 'tracked.txt', 'edited\n');
    fs.unlinkSync(path.join(dir, 'gone.txt'));
    write(dir, 'ignored.txt');
    const r = await changed(dir);
    expect(r.include.sort()).toEqual(['gone.txt', 'new.txt', 'tracked.txt']);
    expect(r.skipped).toEqual([]);

    // a rename is one delete and one add
    dir = repo();
    await snapshot(dir);
    sh(dir, 'git', ['mv', 'old.txt', 'renamed.txt']);
    expect((await changed(dir)).include.sort()).toEqual(['old.txt', 'renamed.txt']);
  });

  test('a file dirty before the run is in neither list while unchanged, and skipped as pre-existing once edited again', async () => {
    const dir = repo();
    write(dir, 'tracked.txt', 'mine\n');
    await snapshot(dir);
    expect(await changed(dir)).toMatchObject({ include: [], skipped: [] });

    write(dir, 'tracked.txt', 'mine and cycle\n');
    expect(await changed(dir)).toMatchObject({ include: [], skipped: [{ path: 'tracked.txt', reason: 'pre-existing local changes' }] });
  });

  test('sensitive, config, generated and over 1 MiB files are skipped; .env.example is included', async () => {
    const dir = repo();
    await snapshot(dir);
    for (const f of ['.env.local', 'server/.env.production', 'key.pem', 'id_rsa_x']) write(dir, f);
    for (const f of ['.vscode/x.json', '.claude/settings.json']) write(dir, f);
    write(dir, 'node_modules/x/index.js');
    write(dir, '.DS_Store');
    write(dir, '.env.example');
    write(dir, 'big.bin', 'a'.repeat(1024 * 1024 + 1));
    const r = await changed(dir);
    const reason = p => (r.skipped.find(s => s.path === p) || {}).reason;
    expect(reason('.env.local')).toBe('sensitive file');
    expect(reason('server/.env.production')).toBe('sensitive file');
    expect(reason('key.pem')).toBe('sensitive file');
    expect(reason('id_rsa_x')).toBe('sensitive file');
    expect(reason('.vscode/x.json')).toBe('local or agent configuration');
    expect(reason('.claude/settings.json')).toBe('local or agent configuration');
    expect(reason('.DS_Store')).toBe('generated');
    expect(reason('big.bin')).toBe('too large');
    expect(r.include).toEqual(['.env.example']);
  });

  test('the size limit comes from finalise.maxFileBytes in the settings', async () => {
    const dir = repo();
    write(dir, 'sdlc.config.json', JSON.stringify({ finalise: { maxFileBytes: 10 } }));
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'settings']);
    await snapshot(dir);
    write(dir, 'small.txt', 'tiny\n');
    write(dir, 'medium.txt', 'more than ten bytes\n');
    const r = await changed(dir);
    expect(r.include).toEqual(['small.txt']);
    expect(r.skipped).toEqual([{ path: 'medium.txt', reason: 'too large' }]);
  });

  test('keys added to a git-ignored .env are mirrored into .env.example with placeholders', async () => {
    const dir = repo();
    write(dir, '.env', 'A=1\n');
    write(dir, '.env.example', 'A=change-me\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'ex']);
    await snapshot(dir);
    write(dir, '.env', 'A=1\nSECRET_KEY=hunter2\n');
    const m = await cli(dir, 'changes', 'mirror', base(dir));
    expect(m.status).toBe(0);
    expect(m.stderr).toContain('mirrored SECRET_KEY');
    const example = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    expect(example).toBe('A=change-me\nSECRET_KEY=change-me\n');
    expect(example).not.toContain('hunter2');
    expect((await changed(dir)).include).toEqual(['.env.example']);
  });

  test('an .env.example with local changes before the run is not touched', async () => {
    const dir = repo();
    write(dir, '.env', 'A=1\n');
    write(dir, '.env.example', 'A=change-me\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', 'ex']);
    write(dir, '.env.example', 'A=change-me\nMINE=1\n');
    await snapshot(dir);
    write(dir, '.env', 'A=1\nNEW=2\n');
    const m = await cli(dir, 'changes', 'mirror', base(dir));
    expect(m.status).toBe(0);
    expect(m.stderr).toContain('WARNING: .env.example had local changes before the run; not updated with new keys NEW');
    expect(fs.readFileSync(path.join(dir, '.env.example'), 'utf8')).toBe('A=change-me\nMINE=1\n');
  });
});

describe('changes mark (files per stage)', () => {
  const mark = (dir, stage?) => cli(dir, 'changes', 'mark', `${dir}-stages.json`, ...(stage ? [stage] : []));
  const stages = dir => JSON.parse(fs.readFileSync(`${dir}-stages.json`, 'utf8')).stages;
  const commit = (dir, msg) => {
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-q', '-m', msg]);
  };

  test('credits each stage with the files that changed while it ran, committed or not, but not the commit that collects earlier work', async () => {
    let dir = repo();
    await mark(dir);
    write(dir, 'Docs/backlog/s/specs-1.md');
    await mark(dir, 'Spec');
    write(dir, 'Docs/backlog/s/plan-1.md');
    write(dir, 'tracked.txt', 'edited\n');
    await mark(dir, 'Plan');
    expect(stages(dir)).toEqual({ Spec: ['Docs/backlog/s/specs-1.md'], Plan: ['Docs/backlog/s/plan-1.md', 'tracked.txt'] });

    // a file created and committed inside one stage still counts for that stage
    dir = repo();
    await mark(dir);
    write(dir, 'server/__tests__/new.test.js');
    commit(dir, 'test: add failing tests');
    await mark(dir, 'Red tests');
    expect(stages(dir)).toEqual({ 'Red tests': ['server/__tests__/new.test.js'] });

    // a test file an earlier stage wrote, changed and committed by a later stage (Test repair), counts for both
    dir = repo();
    await mark(dir);
    write(dir, 'server/__tests__/a.test.js', 'red\n');
    commit(dir, 'test: add failing tests');
    await mark(dir, 'Red tests');
    write(dir, 'src.js');
    await mark(dir, 'Implement');
    write(dir, 'Docs/backlog/s/test-repair-1.md');
    write(dir, 'server/__tests__/a.test.js', 'repaired\n');
    sh(dir, 'git', ['add', 'server/__tests__/a.test.js', 'Docs/backlog/s/test-repair-1.md']);
    sh(dir, 'git', ['commit', '-q', '-m', 'test: repair invalid tests']);
    await mark(dir, 'Test repair');
    expect(stages(dir)).toEqual({
      'Red tests': ['server/__tests__/a.test.js'], Implement: ['src.js'],
      'Test repair': ['Docs/backlog/s/test-repair-1.md', 'server/__tests__/a.test.js'],
    });

    // the commit that collects earlier work is not credited with it
    dir = repo();
    await mark(dir);
    write(dir, 'a.js');
    await mark(dir, 'Implement');
    commit(dir, 'feat: ship');
    await mark(dir, 'Commit');
    expect(stages(dir)).toEqual({ Implement: ['a.js'] });
  });

  test('an already dirty, unchanged file and sensitive or generated files are never credited; a second pass adds to a stage; a mark without a stage only resets', async () => {
    let dir = repo();
    write(dir, 'dirty-before.txt');
    await mark(dir);
    write(dir, 'one.js');
    await mark(dir, 'Implement');
    write(dir, 'two.js');
    await mark(dir, 'Implement');
    expect(stages(dir)).toEqual({ Implement: ['one.js', 'two.js'] });

    dir = repo();
    await mark(dir);
    write(dir, '.env.local', 'SECRET=1\n');
    write(dir, 'node_modules/x/index.js');
    write(dir, 'real.js');
    await mark(dir);
    await mark(dir, 'Spec');
    expect(stages(dir)).toEqual({});
    write(dir, 'later.js');
    await mark(dir, 'Plan');
    expect(stages(dir)).toEqual({ Plan: ['later.js'] });
  });
});
