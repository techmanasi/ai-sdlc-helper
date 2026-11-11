import { describe, expect, it } from 'vitest';
import { isMarkdownPath, parseInline, parseMarkdown, safeHref } from '../web/ui/src/markdown.js';

describe('parseMarkdown', () => {
  it('parses headings, lists, quotes and rules', () => {
    const blocks = parseMarkdown('# Title\n\nintro line\ncontinues\n\n- a\n- b\n\n1. one\n2. two\n\n> quoted\n\n---');
    expect(blocks.map(b => b.t)).toEqual(['heading', 'para', 'list', 'list', 'quote', 'hr']);
    expect(blocks[2]).toMatchObject({ ordered: false });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect((blocks[2] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('keeps fenced code verbatim, including markdown-looking lines', () => {
    const blocks = parseMarkdown('```ts\n# not a heading\n- not a list\n```\nafter');
    expect(blocks[0]).toEqual({ t: 'code', lang: 'ts', text: '# not a heading\n- not a list' });
    expect(blocks[1].t).toBe('para');
  });

  it('parses a table with its header and rows', () => {
    const blocks = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\ntext');
    expect(blocks[0].t).toBe('table');
    const t = blocks[0] as { head: unknown[]; rows: unknown[][] };
    expect(t.head).toHaveLength(2);
    expect(t.rows).toHaveLength(2);
    expect(blocks[1].t).toBe('para');
  });

  it('treats a pipe line without a separator row as a paragraph', () => {
    expect(parseMarkdown('a | b')[0].t).toBe('para');
  });
});

describe('parseInline', () => {
  it('parses code, bold, italic and links', () => {
    const n = parseInline('use `x` and **bold** and *it* and [site](https://e.com)');
    expect(n.map(i => i.t)).toEqual(['text', 'code', 'text', 'strong', 'text', 'em', 'text', 'link']);
  });

  it('leaves unsafe link targets as plain text and never produces markup', () => {
    const n = parseInline('[x](javascript:alert(1)) <script>alert(1)</script>');
    expect(n.some(i => i.t === 'link')).toBe(false);
    expect(n.every(i => i.t === 'text')).toBe(true);
  });
});

describe('safeHref and isMarkdownPath', () => {
  it('allows web, mail and relative targets only', () => {
    expect(safeHref('https://a.b')).toBe('https://a.b');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('JavaScript:x')).toBeNull();
  });

  it('recognises markdown paths', () => {
    expect(isMarkdownPath('docs/spec.md')).toBe(true);
    expect(isMarkdownPath('README.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('logs/run.out')).toBe(false);
  });
});
