import { describe, expect, test } from 'vitest';
import { buildDocTree } from '../web/ui/src/tree.js';

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
