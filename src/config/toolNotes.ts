// Tool notes: short, stage-specific prompt text about a tool (today a test runner), loaded only when the project uses
// it. A note is assets/prompts/notes/<name>.md: `match:` lines, then `## <stage>` sections (see docs/plans/tool-notes.md).
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR } from '../util.js';
import { AGENT_STAGES, SetupError, type AgentStage } from '../pipeline/context.js';
import type { Config, Suite } from './settings.js';

export const NOTES_DIR = path.join(ASSETS_DIR, 'prompts', 'notes');
export const SECTION_WORDS = 120;
export const STAGE_WORDS = 200;
export const NOTES_HEADING = 'Tool notes (for the tools this project uses):';

const KEYS = ['runner', 'language', 'packageManager', 'tools', 'harness', 'codeIndexer'] as const;
const SUITE_KEYS = ['runner', 'language', 'packageManager', 'tools'];

/** One `key=values` pair: `all` when the values were joined with `+`. */
export interface Clause { key: typeof KEYS[number]; values: string[]; all: boolean }
export interface Section { when: string | null; text: string }
export interface Note {
  name: string;
  /** Each `match:` line as its clauses (AND); lines are OR. `never` is an empty list of lines. */
  match: Clause[][];
  sections: Partial<Record<AgentStage, Section>>;
  /** Set on notes loaded from the project's folder (lenient: problems skip the note). */
  project?: boolean;
}

/** What `when:` regexes are tested against: the stage's text, or 'skill' (no run in progress). */
export type Signals = { testsLog?: string; testIssues?: string } | 'skill';

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

// A SetupError (src/config may import src/pipeline/context.ts: that file has only type imports besides node:path).
function bad(file: string, problem: string): never {
  throw new SetupError(`ERROR: tool note ${file}: ${problem}`);
}

function parseLine(file: string, spec: string): Clause[] {
  const clauses: Clause[] = [];
  for (const part of spec.split(',').map(p => p.trim())) {
    const m = /^([A-Za-z]+)=(.+)$/.exec(part);
    if (!m) bad(file, `malformed match clause "${part}"`);
    const key = KEYS.find(k => k.toLowerCase() === m[1].toLowerCase());
    if (!key) bad(file, `unknown match key "${m[1]}"`);
    const raw = m[2].trim();
    if (raw.includes('|') && raw.includes('+')) bad(file, `"|" and "+" mixed in "${part}"`);
    if (raw.includes('+') && key !== 'tools') bad(file, `"+" is only for tools, not ${key}`);
    const values = raw.split(/[|+]/).map(v => v.trim().toLowerCase());
    if (values.some(v => !v)) bad(file, `empty value in "${part}"`);
    clauses.push({ key, values, all: raw.includes('+') });
  }
  return clauses;
}

/** Parses one note file. Throws SetupError when it is malformed. */
export function readNote(file: string): Note {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const note: Note = { name: path.basename(file).replace(/\.md$/, ''), match: [], sections: {} };
  let i = 0;
  let sawMatch = false;
  for (; i < lines.length && !lines[i].startsWith('## '); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = /^match:\s*(.*)$/.exec(line);
    if (!m) bad(file, `text before the first "## <stage>" heading that is not a match: line: "${line}"`);
    sawMatch = true;
    if (m[1].trim() === 'never') continue;
    if (!m[1].trim()) bad(file, 'empty match: line');
    note.match.push(parseLine(file, m[1]));
  }
  if (!sawMatch) bad(file, 'no match: line');
  if (i >= lines.length) bad(file, 'no "## <stage>" section');
  while (i < lines.length) {
    const stage = lines[i].slice(3).trim();
    if (!(AGENT_STAGES as readonly string[]).includes(stage)) bad(file, `unknown stage heading "${stage}"`);
    if (note.sections[stage as AgentStage]) bad(file, `stage "${stage}" has two sections`);
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i].startsWith('## '); i++) body.push(lines[i]);
    while (body.length && !body[0].trim()) body.shift();
    let when: string | null = null;
    const w = body.length ? /^when:\s*(.+)$/.exec(body[0].trim()) : null;
    if (w) {
      when = w[1].trim();
      try { new RegExp(when); } catch { bad(file, `bad when: regex /${when}/`); }
      body.shift();
    }
    const text = body.join('\n').trim();
    if (!text) bad(file, `section "${stage}" is empty`);
    if (words(text) > SECTION_WORDS) bad(file, `section "${stage}" has ${words(text)} words; the limit is ${SECTION_WORDS}`);
    note.sections[stage as AgentStage] = { when, text };
  }
  return note;
}

function suiteValues(suite: Suite, key: string): string[] {
  if (key === 'tools') return suite.tools.map(t => t.toLowerCase());
  return [String((suite as any)[key] ?? '').toLowerCase()];
}

const holds = (c: Clause, have: string[]): boolean => (c.all ? c.values.every(v => have.includes(v)) : c.values.some(v => have.includes(v)));

/** Whether a note matches, and the suites that satisfied a line with per-suite keys. */
function matches(note: Note, config: Config, stage: string): { ok: boolean; suites: Suite[] } {
  const matched = new Set<Suite>();
  let ok = false;
  const project: Record<string, string[]> = {
    harness: [(config.agent.stages?.[stage]?.harness ?? config.agent.harness ?? '').toLowerCase()],
    codeIndexer: [(config.agent.codeIndexer?.name ?? '').toLowerCase()],
  };
  for (const line of note.match) {
    if (!line.filter(c => !SUITE_KEYS.includes(c.key)).every(c => holds(c, project[c.key]))) continue;
    const perSuite = line.filter(c => SUITE_KEYS.includes(c.key));
    if (!perSuite.length) { ok = true; continue; }
    for (const s of config.suites) {
      if (perSuite.every(c => holds(c, suiteValues(s, c.key)))) { ok = true; matched.add(s); }
    }
  }
  return { ok, suites: config.suites.filter(s => matched.has(s)) };
}

/** The signal text a `when:` regex is tested against at <stage>; null when the stage has none (the section never loads). */
function signalText(stage: string, signals: { testsLog?: string; testIssues?: string }): string | null {
  if (stage === 'implement') return signals.testsLog ?? '';
  if (stage === 'test-repair' || stage === 'test-audit') return signals.testIssues ?? '';
  return null;
}

/** Where a config's project notes live: <root>/<agent.notesDir>; none for a config without them. */
const projectDirsOf = (config: Config): string[] => (config.root && config.agent.notesDir ? [path.join(config.root, config.agent.notesDir)] : []);

/**
 * The notes found in <dirs> (strict: a malformed note throws) and then in <projectDirs> (lenient: a malformed note is
 * skipped and its problem pushed to <problems>), in order of directory, then file name; a later note of the same name replaces an earlier one.
 */
export function loadNotes(dirs: string[], projectDirs: string[] = [], problems: string[] = []): Note[] {
  const byName = new Map<string, Note>();
  const add = (note: Note) => { byName.delete(note.name); byName.set(note.name, note); };
  const files = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.md')).sort().map(f => path.join(dir, f)) : []);
  for (const dir of dirs) for (const f of files(dir)) add(readNote(f));
  for (const dir of projectDirs) {
    for (const f of files(dir)) {
      try { add({ ...readNote(f), project: true }); } catch (e) {
        if (!(e instanceof SetupError)) throw e;
        problems.push(`${e.message.replace(/^ERROR: /, '')}; the note is skipped`);
      }
    }
  }
  return [...byName.values()];
}

interface Opts { dirs?: string[]; projectDirs?: string[]; problems?: string[] }

/**
 * The text of each section that applies to <stage> (without the heading). Throws SetupError past the stage's word cap
 * for shipped notes; a project note that would pass it is skipped (and pushed to <problems>).
 */
export function toolNoteSections(stage: AgentStage, config: Config, signals: Signals, { dirs = [NOTES_DIR], projectDirs = projectDirsOf(config), problems = [] }: Opts = {}): string[] {
  const out: string[] = [];
  let total = 0;
  const byName = (a: Note, b: Note) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const all = loadNotes(dirs, projectDirs, problems);
  const sorted = [...all.filter(n => !n.project).sort(byName), ...all.filter(n => n.project).sort(byName)];
  for (const note of sorted) {
    const section = note.sections[stage];
    if (!section) continue;
    const m = matches(note, config, stage);
    if (!m.ok) continue;
    let text = section.text;
    if (section.when !== null) {
      if (signals === 'skill') text = `If the test output shows /${section.when}/:\n${text}`;
      else {
        const signal = signalText(stage, signals);
        if (signal === null || !new RegExp(section.when).test(signal)) continue;
      }
    }
    const next = total + words(section.text);
    if (next > STAGE_WORDS) {
      const msg = `tool notes for ${stage} have ${next} words; the limit is ${STAGE_WORDS}`;
      if (!note.project) throw new SetupError(`ERROR: ${msg}`);
      problems.push(`project note ${note.name}: ${msg}; the note is skipped for ${stage}`);
      continue;
    }
    total = next;
    if (config.suites.length > 1 && m.suites.length) text = `Applies to ${m.suites.map(s => `${s.dir}/`).join(', ')}:\n${text}`;
    out.push(text);
  }
  return out;
}

/** Each project note that is skipped (malformed, or past a stage's word cap), as a warning line. */
export function projectNoteProblems(config: Config, opts: { dirs?: string[] } = {}): string[] {
  const problems: string[] = [];
  for (const stage of AGENT_STAGES) toolNoteSections(stage, config, 'skill', { ...opts, problems });
  return [...new Set(problems)];
}

/** The notes to append to <stage>'s prompt or skill: '' when none apply. */
export function toolNotes(stage: AgentStage, config: Config, signals: Signals, opts: Opts = {}): string {
  return withHeading(toolNoteSections(stage, config, signals, opts));
}

export const withHeading = (sections: string[]): string => (sections.length ? `${NOTES_HEADING}\n\n${sections.join('\n\n')}` : '');
