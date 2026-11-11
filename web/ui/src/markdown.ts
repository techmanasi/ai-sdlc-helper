// A small Markdown parser: text in, plain data out. The UI maps the data to elements, so nothing from a file ever runs as HTML.

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] };

export type Block =
  | { t: 'heading'; level: number; inline: Inline[] }
  | { t: 'para'; inline: Inline[] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; inline: Inline[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'hr' };

/** Only web and mail links become links; anything else (javascript:, data:) stays plain text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:\/\/|mailto:|#|\/|\.\.?\/)/i.test(h) ? h : null;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push({ t: 'text', text: rest }); break; }
    if (m.index > 0) out.push({ t: 'text', text: rest.slice(0, m.index) });
    if (m[1] !== undefined) out.push({ t: 'code', text: m[1] });
    else if (m[2] !== undefined || m[3] !== undefined) out.push({ t: 'strong', children: parseInline(m[2] ?? m[3]) });
    else if (m[4] !== undefined) out.push({ t: 'em', children: parseInline(m[4]) });
    else {
      const href = safeHref(m[6]);
      if (href) out.push({ t: 'link', href, children: parseInline(m[5]) });
      else out.push({ t: 'text', text: m[0] });
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const splitRow = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { blocks.push({ t: 'para', inline: parseInline(para.join(' ')) }); para = []; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      blocks.push({ t: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flush(); blocks.push({ t: 'heading', level: h[1].length, inline: parseInline(h[2]) }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ t: 'hr' }); continue; }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(splitRow(lines[i]).map(parseInline));
      i--;
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    const li = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (li) {
      flush();
      const ordered = li[2] !== undefined;
      const last = blocks[blocks.length - 1];
      if (last && last.t === 'list' && last.ordered === ordered) last.items.push(parseInline(li[3]));
      else blocks.push({ t: 'list', ordered, items: [parseInline(li[3])] });
      continue;
    }
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last && last.t === 'quote') last.inline.push({ t: 'text', text: ' ' }, ...parseInline(q[1]));
      else blocks.push({ t: 'quote', inline: parseInline(q[1]) });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

export const isMarkdownPath = (p: string): boolean => /\.(md|markdown)$/i.test(p);
