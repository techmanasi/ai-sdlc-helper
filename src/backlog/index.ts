// Lists the items in <backlogDir>/index.md with a derived status, adds new ones (addBacklogItem) and edits unstarted ones.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from '../trace.js';
import { readSettings } from '../util.js';
import { readRecord } from '../runs/records.js';
import { hashOf } from '../config/edit.js';

export const BACKLOG_USAGE = 'Usage: ai-sdlc-helper backlog [status[,status...]] [--status <list>] [--json]';
export const STATUSES = ['pending', 'in-progress', 'blocked', 'parked', 'completed'] as const;
export type Status = typeof STATUSES[number];
const ALIASES: Record<string, Status> = { open: 'pending', done: 'completed' };

export interface IndexEntry { marker: string; slug: string; rest: string }
export interface BacklogItem {
  status: Status;
  slug: string;
  type: string | null;
  priority: string | null;
  title: string;
  note: string;
  hasBrief: boolean;
  archived?: boolean;
  pr?: string | null;
}
/** Where the backlog lives: the project root, the backlog folder in it, and the branch prefix of pipeline runs. */
export interface BacklogPlace { root: string; backlogDir: string; branchPrefix: string }

class UsageError extends Error { code = 2; }

/** The backlog folder and branch prefix from the project's settings (`backlogDir`, `git.branchPrefix`). */
export function backlogPlace(root: string): BacklogPlace {
  const s = readSettings(root);
  return {
    root,
    backlogDir: String(s.backlogDir || 'Docs/backlog').replace(/\/+$/, ''),
    branchPrefix: (s.git && typeof s.git.branchPrefix === 'string' && s.git.branchPrefix) || 'sdlc/',
  };
}

export function parseIndex(text: string): IndexEntry[] {
  const items: IndexEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^- \[( |x|X|!|~)\] `([^`]+)`(?: - (.*))?$/);
    if (m) items.push({ marker: m[1], slug: m[2], rest: m[3] || '' });
  }
  return items;
}

export function parseTitle(rest: string): { type: string | null; title: string; blockedReason: string; parkedReason: string } {
  let title = rest;
  let type: string | null = null;
  const prefix = title.match(/^(bug|feature):\s*/i);
  if (prefix) {
    type = prefix[1].toLowerCase();
    title = title.slice(prefix[0].length);
  }
  let blockedReason = '';
  let parkedReason = '';
  const note = title.match(/\s*\((blocked|parked):\s*(.*)\)\s*$/);
  if (note) {
    if (note[1] === 'blocked') blockedReason = note[2].trim();
    else parkedReason = note[2].trim();
    title = title.slice(0, note.index);
  }
  return { type, title: title.trim(), blockedReason, parkedReason };
}

// A slug is used as a folder name and in a git ref pattern: reject separators, "..", and glob characters.
const safeSlug = (slug: string): boolean => !/[\\/*?[\]]/.test(slug) && slug !== '..' && slug !== '.';

export { archiveTask, unarchiveTask, archiveCompleted, type ArchiveOptions } from './archive.js';

export function parseBrief(place: Pick<BacklogPlace, 'root' | 'backlogDir'>, slug: string): { hasBrief: boolean; type: string | null; priority: string | null; pr: string | null } {
  if (!safeSlug(slug)) return { hasBrief: false, type: null, priority: null, pr: null };
  const file = path.join(place.root, place.backlogDir, slug, 'brief.md');
  if (!fs.existsSync(file)) return { hasBrief: false, type: null, priority: null, pr: null };
  const text = fs.readFileSync(file, 'utf8');
  const typeLine = text.match(/^\s*Type:[ \t]*(\S+)/im);
  const priLine = text.match(/^\s*Priority:[ \t]*(.*)$/im);
  const pri = priLine && priLine[1].match(/\bP[0-3]\b/);
  const fmM = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  let pr: string | null = null;
  if (fmM) {
    const prLine = fmM[1].match(/^pr:\s*(\S+)/im);
    if (prLine) pr = prLine[1].trim();
  }
  if (!pr) {
    const prBody = text.match(/^(?:PR|pr):\s*(https?:\/\/\S+)/im);
    if (prBody) pr = prBody[1].trim();
  }
  return { hasBrief: true, type: typeLine ? typeLine[1].toLowerCase() : null, priority: pri ? pri[0] : null, pr };
}

/** Whether a local or origin branch <branchPrefix><slug> exists. <refs> holds the repository's refs, read once on first use. */
function branchExists(place: BacklogPlace, slug: string, refs: { names?: Set<string> }): boolean {
  if (!safeSlug(slug)) return false;
  if (!refs.names) {
    try {
      const out = execFileSync('git', ['-C', place.root, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      refs.names = new Set(out.split('\n').filter(Boolean));
    } catch {
      refs.names = new Set();
    }
  }
  const branch = `${place.branchPrefix}${slug}`;
  return refs.names.has(`refs/heads/${branch}`) || refs.names.has(`refs/remotes/origin/${branch}`);
}

function deriveItem(entry: IndexEntry, place: BacklogPlace, refs: { names?: Set<string> }): BacklogItem {
  const { type, title, blockedReason, parkedReason } = parseTitle(entry.rest);
  const brief = parseBrief(place, entry.slug);
  let status: Status;
  if (entry.marker === 'x' || entry.marker === 'X') status = 'completed';
  else if (entry.marker === '!') status = 'blocked';
  else if (entry.marker === '~') status = 'parked';
  else status = branchExists(place, entry.slug, refs) ? 'in-progress' : 'pending';
  return {
    status,
    slug: entry.slug,
    type: type || brief.type,
    priority: brief.priority,
    title,
    note: [blockedReason || parkedReason, brief.hasBrief ? null : 'no brief'].filter(Boolean).join('; '),
    hasBrief: brief.hasBrief,
    pr: brief.pr,
  };
}

function notInIndex(place: BacklogPlace, entries: IndexEntry[]): string[] {
  const indexed = new Set(entries.map(e => e.slug));
  const dir = path.join(place.root, place.backlogDir);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !indexed.has(d.name) && fs.existsSync(path.join(dir, d.name, 'brief.md')))
    .map(d => d.name)
    .sort();
}

/** The statuses a filter such as "pending,in-progress", "open" or "all" selects (any case). */
export function normalizeStatuses(raw: string): Set<Status> {
  const out = new Set<Status>();
  for (const part of raw.split(',')) {
    const v = part.toLowerCase();
    if (v === 'all') STATUSES.forEach(s => out.add(s));
    else if ((STATUSES as readonly string[]).includes(v)) out.add(v as Status);
    else if (ALIASES[v]) out.add(ALIASES[v]);
    else throw new UsageError(`Unknown status "${part}". Valid: ${STATUSES.join(', ')}, all`);
  }
  return out;
}

export function parseArgs(argv: string[]): { statuses: Set<Status>; raw: string | null; json: boolean } {
  let positional: string | null = null;
  let status: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--status') {
      const v = argv[i + 1];
      if (status !== null || v === undefined || v.startsWith('-')) throw new UsageError(BACKLOG_USAGE);
      status = v;
      i++;
    } else if (a.startsWith('-')) throw new UsageError(BACKLOG_USAGE);
    else if (positional !== null) throw new UsageError(BACKLOG_USAGE);
    else positional = a;
  }
  if (positional !== null && status !== null) throw new UsageError(BACKLOG_USAGE);
  const raw = positional !== null ? positional : status;
  return { statuses: normalizeStatuses(raw === null ? 'all' : raw), raw, json };
}

export function formatTable(items: BacklogItem[], all: BacklogItem[], extras: string[], rawFilter: string): string {
  const count = (s: Status) => all.filter(i => i.status === s).length;
  const footer = `pending ${count('pending')} · in-progress ${count('in-progress')} · blocked ${count('blocked')} · parked ${count('parked')} · completed ${count('completed')} · total ${all.length}`;
  const lines: string[] = [];
  if (!items.length) {
    lines.push(`No items with status: ${rawFilter}`);
  } else {
    const rows = [['STATUS', 'SLUG', 'TYPE', 'PRI', 'TITLE', 'NOTE']].concat(
      items.map(i => [i.status, i.slug, i.type || '-', i.priority || '-', i.title, i.note]),
    );
    const widths = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)));
    for (const r of rows) lines.push(r.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd());
  }
  lines.push('', footer);
  if (extras.length) lines.push(`Not in index: ${extras.join(', ')}`);
  return lines.join('\n') + '\n';
}

export const formatJson = (items: BacklogItem[]): string => JSON.stringify(items.map(i => ({
  status: i.status,
  slug: i.slug,
  type: i.type || null,
  priority: i.priority || null,
  title: i.title,
  note: i.note || '',
  hasBrief: i.hasBrief,
}))) + '\n';

/** Every item of the backlog at <place>, with its derived status; null when the index is missing. */
export function backlogItems(place: BacklogPlace): { items: BacklogItem[]; entries: IndexEntry[] } | null {
  const indexFile = path.join(place.root, place.backlogDir, 'index.md');
  if (!fs.existsSync(indexFile)) return null;
  const text = fs.readFileSync(indexFile, 'utf8');
  const entries = parseIndex(text);
  const archiveIndex = text.search(/^##\s+Archive/im);
  const refs = {};
  return {
    items: entries.map(e => {
      const item = deriveItem(e, place, refs);
      if (archiveIndex !== -1) {
        const itemPos = text.indexOf(`\`${e.slug}\``);
        if (itemPos > archiveIndex) item.archived = true;
      }
      return item;
    }),
    entries,
  };
}

export interface NewItem { slug: string; type: 'feature' | 'bug'; title: string; brief: string }

/**
 * Adds an item: <backlogDir>/<slug>/brief.md and the line "- [ ] `<slug>` - Feature: <title>" at the end of the index
 * (made when missing). Throws, writing nothing, on a bad slug, type or title, or a slug the index or a brief already has.
 */
export function addBacklogItem(place: Pick<BacklogPlace, 'root' | 'backlogDir'>, item: NewItem): { index: string; brief: string } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(item.slug || '')) throw new Error(`slug must be lowercase letters, digits and dashes, not '${item.slug}'`);
  if (item.type !== 'feature' && item.type !== 'bug') throw new Error(`type must be feature or bug, not '${item.type}'`);
  const title = (item.title || '').trim();
  if (!title || /[\r\n]/.test(title)) throw new Error('title must be one non-empty line');
  if (!(item.brief || '').trim()) throw new Error('brief must not be empty');
  const dir = path.join(place.root, place.backlogDir);
  const index = path.join(dir, 'index.md');
  const brief = path.join(dir, item.slug, 'brief.md');
  const text = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : '';
  if (parseIndex(text).some(e => e.slug === item.slug)) throw new Error(`${item.slug} is already in ${place.backlogDir}/index.md`);
  if (fs.existsSync(brief)) throw new Error(`${place.backlogDir}/${item.slug}/brief.md already exists`);
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, item.brief.endsWith('\n') ? item.brief : `${item.brief}\n`);
  const label = item.type === 'bug' ? 'Bug' : 'Feature';
  const head = text ? (text.endsWith('\n') ? text : `${text}\n`) : '# Backlog\n\n';
  fs.writeFileSync(index, `${head}- [ ] \`${item.slug}\` - ${label}: ${title}\n`);
  return { index, brief };
}

/** What the edit checks need besides the backlog place: the run registry and the worktree base. A RunContext fits. */
export interface EditPlace extends BacklogPlace { reg: string; wtBase: string }

export interface BacklogEditView {
  slug: string;
  title: string;
  type: 'feature' | 'bug';
  priority: string | null;
  brief: string | null;
  marker: string;
  status: Status;
  archived: boolean;
  editable: boolean;
  reason: string;
  hash: string;
}

export interface ItemEdit { title: string; type: string; priority?: string; brief: string; hash: string }
export interface ItemEditResult { ok: true; index: string; brief: string; hash: string; notSaved: ('type' | 'priority')[] }

/** A refused edit: <status> is the HTTP status the web server answers with; <hash> is the current version (stale edits). */
export class BacklogEditError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string, readonly hash?: string) { super(message); }
}

const PRIORITY_OPTIONS = ['P0 (security or data loss)', 'P1 (high)', 'P2 (normal)', 'P3 (low)'];

interface Located { indexFile: string; lines: string[]; at: number; entry: IndexEntry; line: string; crlf: boolean; archived: boolean }

function locateItem(place: BacklogPlace, slug: string): Located | null {
  if (!safeSlug(slug)) return null;
  const indexFile = path.join(place.root, place.backlogDir, 'index.md');
  if (!fs.existsSync(indexFile)) return null;
  const lines = fs.readFileSync(indexFile, 'utf8').split('\n');
  let archiveAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const crlf = lines[i].endsWith('\r');
    const line = crlf ? lines[i].slice(0, -1) : lines[i];
    if (archiveAt === -1 && /^##\s+Archive/i.test(line)) archiveAt = i;
    const entry = parseIndex(line)[0];
    if (entry && entry.slug === slug) return { indexFile, lines, at: i, entry, line, crlf, archived: archiveAt !== -1 && archiveAt < i };
  }
  return null;
}

const briefFile = (place: BacklogPlace, slug: string): string => path.join(place.root, place.backlogDir, slug, 'brief.md');
const readBriefText = (place: BacklogPlace, slug: string): string | null => {
  try { return fs.readFileSync(briefFile(place, slug), 'utf8'); } catch { return null; }
};
const versionOf = (brief: string | null, line: string): string => hashOf(`${brief ?? ''}\u0000${line}`);

function briefType(text: string): 'feature' | 'bug' | null {
  const m = text.match(/^[ \t]*Type:[ \t]*(\S+)/im);
  const v = m ? m[1].toLowerCase() : '';
  return v === 'feature' || v === 'bug' ? v : null;
}
function briefPriority(text: string): string | null {
  const m = text.match(/^[ \t]*Priority:[ \t]*(.*)$/im);
  return m ? m[1].trim() : null;
}
function replaceFirst(text: string, key: 'Type' | 'Priority', value: string): { text: string; done: boolean } {
  const re = new RegExp(`^([ \\t]*${key}:[ \\t]*)(.*)$`, 'im');
  if (!re.test(text)) return { text, done: false };
  return { text: text.replace(re, (_m, prefix: string) => `${prefix}${value}`), done: true };
}

function startedReason(place: EditPlace, slug: string): string | null {
  const isDir = (p: string): boolean => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  const rec = readRecord(place.reg, slug);
  const recWt = rec?.worktree;
  const started = rec !== null
    || (typeof recWt === 'string' && recWt !== '' && isDir(recWt))
    || isDir(path.join(place.wtBase, slug))
    || branchExists(place, slug, {})
    || fs.existsSync(path.join(place.root, place.backlogDir, slug, 'logs', 'status.json'));
  return started ? `The pipeline for \`${slug}\` has started. To change the brief, stop the run and discard it, then edit.` : null;
}

function finishedReason(loc: Located, slug: string): string | null {
  return loc.entry.marker === 'x' || loc.entry.marker === 'X' || loc.archived ? `\`${slug}\` is completed or archived and cannot be edited` : null;
}

function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, text);
    fs.renameSync(tmpFile, file);
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch { /* already gone */ }
    throw e;
  }
}

function locateOrThrow(place: BacklogPlace, slug: string): Located {
  const loc = locateItem(place, slug);
  if (!loc) throw new BacklogEditError(404, `${slug} is not in ${place.backlogDir}/index.md`);
  return loc;
}

function loadedTypeOf(loc: Located, brief: string | null): 'feature' | 'bug' {
  const label = parseTitle(loc.entry.rest).type;
  return (label === 'bug' || label === 'feature' ? label : null) ?? briefType(brief ?? '') ?? 'feature';
}

/** The item <slug> as the edit form needs it: its fields, whether it can be edited (and why not), and its version. */
export function readBacklogEdit(place: EditPlace, slug: string): BacklogEditView {
  const loc = locateOrThrow(place, slug);
  const { title } = parseTitle(loc.entry.rest);
  const brief = readBriefText(place, slug);
  const reason = finishedReason(loc, slug) ?? startedReason(place, slug) ?? '';
  const marker = loc.entry.marker;
  let status: Status;
  if (marker === 'x' || marker === 'X') status = 'completed';
  else if (marker === '!') status = 'blocked';
  else if (marker === '~') status = 'parked';
  else status = branchExists(place, slug, {}) ? 'in-progress' : 'pending';
  return {
    slug, title, type: loadedTypeOf(loc, brief), priority: brief ? briefPriority(brief) : null, brief,
    marker, status, archived: loc.archived, editable: !reason, reason, hash: versionOf(brief, loc.line),
  };
}

/** Saves an edit of <slug>: its brief.md and its own index line, nothing else. Every check runs before the first write. */
export function editBacklogItem(place: EditPlace, slug: string, edit: ItemEdit): ItemEditResult {
  const loc = locateOrThrow(place, slug);
  if (edit.type !== 'feature' && edit.type !== 'bug') throw new BacklogEditError(400, `type must be feature or bug, not '${edit.type}'`);
  const title = typeof edit.title === 'string' ? edit.title.trim() : '';
  if (!title || /[\r\n]/.test(title)) throw new BacklogEditError(400, 'title must be one non-empty line');
  if (typeof edit.brief !== 'string' || !edit.brief.trim()) throw new BacklogEditError(400, 'brief must not be empty');
  if (edit.priority !== undefined && !PRIORITY_OPTIONS.includes(edit.priority)) {
    throw new BacklogEditError(400, `priority must be one of ${PRIORITY_OPTIONS.join(', ')}, not '${edit.priority}'`);
  }
  if (typeof edit.hash !== 'string' || !edit.hash) throw new BacklogEditError(400, 'hash is required');
  const finished = finishedReason(loc, slug);
  if (finished) throw new BacklogEditError(400, finished);
  const started = startedReason(place, slug);
  if (started) throw new BacklogEditError(409, started);
  const current = readBriefText(place, slug);
  const now = versionOf(current, loc.line);
  if (now !== edit.hash) throw new BacklogEditError(409, `${slug} changed since you opened it; reload and apply the change again`, now);

  let next = edit.brief.endsWith('\n') ? edit.brief : `${edit.brief}\n`;
  const notSaved: ('type' | 'priority')[] = [];
  if (edit.type !== loadedTypeOf(loc, current)) {
    const r = replaceFirst(next, 'Type', edit.type);
    next = r.text;
    if (!r.done) notSaved.push('type');
  }
  if (edit.priority !== undefined) {
    const r = replaceFirst(next, 'Priority', edit.priority);
    next = r.text;
    if (!r.done) notSaved.push('priority');
  }

  const noteMatch = loc.entry.rest.match(/\s*\((blocked|parked):\s*(.*)\)\s*$/);
  const note = noteMatch ? ` ${noteMatch[0].trim()}` : '';
  const label = edit.type === 'bug' ? 'Bug' : 'Feature';
  const newLine = `- [${loc.entry.marker}] \`${slug}\` - ${label}: ${title}${note}`;
  const lines = loc.lines.slice();
  lines[loc.at] = loc.crlf ? `${newLine}\r` : newLine;

  const brief = briefFile(place, slug);
  const briefDirExisted = fs.existsSync(path.dirname(brief));
  atomicWrite(brief, next);
  try {
    atomicWrite(loc.indexFile, lines.join('\n'));
  } catch (e) {
    // A refused save writes nothing: put brief.md (and its folder) back as they were.
    try {
      if (current !== null) atomicWrite(brief, current);
      else {
        fs.rmSync(brief, { force: true });
        if (!briefDirExisted) fs.rmSync(path.dirname(brief), { recursive: true, force: true });
      }
    } catch { /* report the original error */ }
    throw e;
  }
  return { ok: true, index: loc.indexFile, brief, hash: versionOf(next, newLine), notSaved };
}

/**
 * `ai-sdlc-helper backlog [status[,status...]] [--status <list>] [--json]` for the project at <place>. <out> and <err>
 * get text with its own line ends. Returns 0 ok, 1 when the index is missing, 2 on bad arguments.
 */
export function backlogMain(argv: string[], place: BacklogPlace, io: { out(text: string): void; err(text: string): void }): number {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n`);
    return (e as UsageError).code || 2;
  }
  const found = backlogItems(place);
  if (!found) {
    io.err(`${place.backlogDir}/index.md not found\n`);
    return 1;
  }
  const shown = found.items.filter(i => args.statuses.has(i.status));
  io.out(args.json ? formatJson(shown) : formatTable(shown, found.items, notInIndex(place, found.entries), args.raw === null ? 'all' : args.raw));
  return 0;
}
