import { describe, expect, test } from 'vitest';
import { buildDocTree, defaultDirOpen, isStageDirOpen, recordStageDir, type DocTreeNode, type StageDirState } from '../web/ui/src/tree.js';

const single = (): DocTreeNode => buildDocTree(['a/x.ts'])[0];
const multi = (): DocTreeNode => buildDocTree(['a/x.ts', 'a/y.ts'])[0];

describe('buildDocTree', () => {
  test('parses empty array into empty tree', () => {
    expect(buildDocTree([])).toEqual([]);
  });

  test('parses flat file list at root', () => {
    const tree = buildDocTree(['b.md', 'a.md']);
    expect(tree).toEqual([
      { name: 'a.md', path: 'a.md', isDir: false, children: [] },
      { name: 'b.md', path: 'b.md', isDir: false, children: [] },
    ]);
  });

  test('parses nested directory structures and sorts dirs before files', () => {
    const paths = [
      'docs/backlog/slug/brief.md',
      'docs/backlog/slug/decisions.md',
      'docs/backlog/slug/questions.md',
      'logs/run.json',
      'logs/run.out',
      'root-note.txt',
    ];
    const tree = buildDocTree(paths);

    // Dirs first (alphabetical: docs, logs), then files (root-note.txt)
    expect(tree.map(n => n.name)).toEqual(['docs', 'logs', 'root-note.txt']);
    expect(tree[0].isDir).toBe(true);
    expect(tree[1].isDir).toBe(true);
    expect(tree[2].isDir).toBe(false);

    // Check docs structure
    const docs = tree[0];
    expect(docs.children.length).toBe(1);
    expect(docs.children[0].name).toBe('backlog');
    expect(docs.children[0].children.length).toBe(1);
    expect(docs.children[0].children[0].name).toBe('slug');

    const slug = docs.children[0].children[0];
    expect(slug.isDir).toBe(true);
    expect(slug.children.length).toBe(3);
    expect(slug.children.map(c => c.name)).toEqual(['brief.md', 'decisions.md', 'questions.md']);
    expect(slug.children[0].path).toBe('docs/backlog/slug/brief.md');

    // Check logs structure
    const logs = tree[1];
    expect(logs.isDir).toBe(true);
    expect(logs.children.length).toBe(2);
    expect(logs.children.map(c => c.name)).toEqual(['run.json', 'run.out']);
    expect(logs.children[0].path).toBe('logs/run.json');
    expect(logs.children[1].path).toBe('logs/run.out');
  });

  test('handles Windows backslashes and redundant slashes gracefully', () => {
    const paths = [
      'docs\\backlog/slug\\brief.md',
      '/logs//run.out/',
    ];
    const tree = buildDocTree(paths);
    expect(tree.map(n => n.name)).toEqual(['docs', 'logs']);
    expect(tree[0].children[0].children[0].children[0].name).toBe('brief.md');
    expect(tree[1].children[0].name).toBe('run.out');
  });
});

describe('defaultDirOpen', () => {
  test('0 children is open', () => {
    expect(defaultDirOpen({ name: 'a', path: 'a', isDir: true, children: [] })).toBe(true);
  });

  test('1 child is open', () => {
    expect(defaultDirOpen(single())).toBe(true);
  });

  test('2 or more children is closed', () => {
    expect(defaultDirOpen(multi())).toBe(false);
    expect(defaultDirOpen(buildDocTree(['a/x', 'a/y', 'a/z'])[0])).toBe(false);
  });

  test('counts direct children, not descendants', () => {
    expect(defaultDirOpen(buildDocTree(['a/b/x.ts', 'a/b/y.ts'])[0])).toBe(true);
  });
});

describe('isStageDirOpen', () => {
  test('empty state returns the default', () => {
    expect(isStageDirOpen({}, 'S', single())).toBe(true);
    expect(isStageDirOpen({}, 'S', multi())).toBe(false);
  });

  test('stage present but directory absent returns the default', () => {
    const state: StageDirState = { S: {} };
    expect(isStageDirOpen(state, 'S', single())).toBe(true);
    expect(isStageDirOpen(state, 'S', multi())).toBe(false);
  });

  test('recorded true opens a multi-child directory', () => {
    expect(isStageDirOpen({ S: { a: true } }, 'S', multi())).toBe(true);
  });

  test('recorded false closes a single-child directory', () => {
    expect(isStageDirOpen({ S: { a: false } }, 'S', single())).toBe(false);
  });

  test('directory named constructor does not read inherited values', () => {
    const node = buildDocTree(['constructor/x.ts', 'constructor/y.ts'])[0];
    expect(isStageDirOpen({}, 'S', node)).toBe(false);
    expect(isStageDirOpen({}, 'constructor', node)).toBe(false);
    const next = recordStageDir({}, 'S', node.path, true);
    expect(isStageDirOpen(next, 'S', node)).toBe(true);
  });
});

describe('recordStageDir', () => {
  test('recording in one stage leaves another stage at its default', () => {
    const next = recordStageDir({}, 'A', 'a', true);
    expect(isStageDirOpen(next, 'A', multi())).toBe(true);
    expect(isStageDirOpen(next, 'B', multi())).toBe(false);
    const closed = recordStageDir({}, 'A', 'a', false);
    expect(isStageDirOpen(closed, 'B', single())).toBe(true);
  });

  test('stage A + b/c and stage A/b + c stay separate', () => {
    const bc = buildDocTree(['b/c/x.ts', 'b/c/y.ts'])[0].children[0];
    const c = buildDocTree(['c/x.ts', 'c/y.ts'])[0];
    expect(bc.path).toBe('b/c');
    expect(c.path).toBe('c');

    const first = recordStageDir({}, 'A', bc.path, true);
    expect(isStageDirOpen(first, 'A', bc)).toBe(true);
    expect(isStageDirOpen(first, 'A/b', c)).toBe(false);

    const second = recordStageDir({}, 'A/b', c.path, true);
    expect(isStageDirOpen(second, 'A/b', c)).toBe(true);
    expect(isStageDirOpen(second, 'A', bc)).toBe(false);
  });

  test('does not mutate the input and returns a new object', () => {
    const state: StageDirState = { A: { x: true } };
    const before = structuredClone(state);
    const next = recordStageDir(state, 'A', 'y', false);
    expect(state).toEqual(before);
    expect(next).not.toBe(state);
    expect(next).toEqual({ A: { x: true, y: false } });
  });

  test('recording a held value returns the same object', () => {
    const state: StageDirState = { A: { x: true, y: false } };
    expect(recordStageDir(state, 'A', 'x', true)).toBe(state);
    expect(recordStageDir(state, 'A', 'y', false)).toBe(state);
  });

  test('recording the opposite of a held value updates it', () => {
    const state: StageDirState = { A: { x: true } };
    const next = recordStageDir(state, 'A', 'x', false);
    expect(next).not.toBe(state);
    expect(next.A.x).toBe(false);
    expect(state.A.x).toBe(true);
  });

  test('keeps other stages and other directories in the same stage', () => {
    const state: StageDirState = { A: { x: true }, B: { z: false } };
    const next = recordStageDir(state, 'A', 'y', true);
    expect(next).toEqual({ A: { x: true, y: true }, B: { z: false } });
  });

  test('leaves other stages inner objects identical', () => {
    const state: StageDirState = { A: { x: true }, B: { z: false } };
    const next = recordStageDir(state, 'A', 'y', true);
    expect(next.B).toBe(state.B);
  });

  test('recording the first value on an empty state does not hit inherited keys', () => {
    const next = recordStageDir({}, 'constructor', 'toString', false);
    expect(next).toEqual({ constructor: { toString: false } });
    expect(Object.keys(next)).toEqual(['constructor']);
  });
});
