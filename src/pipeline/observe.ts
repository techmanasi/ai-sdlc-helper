// What each agent round did, recorded as it happens: <log>/attempts.jsonl, one line per agent round and one per gate result.
// A round that ends without work (an empty answer, a refused tool, debug code left in the source) is named in the run's
// output and in the run page instead of showing up as an ordinary failed attempt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Git } from './git.js';
import { keepError } from './errors.js';

export type Snapshot = Map<string, string>;

export interface AgentRound {
  kind: 'agent';
  at: string;
  stage: string;
  agent: string;
  durationSec: number | null;
  exitCode: number;
  /** Characters of the agent's final answer. */
  responseChars: number;
  turns: number | null;
  tokens: number | null;
  /** Actions the agent was refused: the tool, and the target when the harness names it. */
  denied: Array<{ tool: string; detail: string }>;
  /** Files whose content differs from before the round. */
  filesChanged: string[];
  warnings: string[];
}

/** Written when a round starts, so the run page shows it at once; the finished round replaces it. */
export interface RoundStart {
  kind: 'start';
  at: string;
  stage: string;
  agent: string;
}

/** Written when a pipeline run starts: the page shows the rounds since the last one. */
export interface RunMark {
  kind: 'run';
  at: string;
  from: string;
  /** Which start of the item this is (1 for the first). */
  n?: number;
  /** The last stage the start before this one reached, and how it ended. */
  previous?: { stage?: string; agent?: string; state?: string; at?: string };
  /** What started the run: the web UI or the command line. */
  trigger?: 'ui' | 'cli';
}

export interface GateResult {
  kind: 'gate';
  at: string;
  agent: string;
  failing: string[];
  warnings: string[];
}

export type Round = AgentRound & { gate?: GateResult; /** The round has started and not finished. */ running?: boolean };

/** Added lines that look like debugging left behind: console output tagged DEBUG, or a log written under /tmp. */
const DEBUG_LINE: RegExp[] = [
  /console\.\w+\(\s*['"`]\s*DEBUG\b/i,
  /(?:writeFileSync|appendFileSync|writeFile|appendFile)\(\s*['"`]\/(?:private\/)?tmp\//,
  /['"`]\/(?:private\/)?tmp\/[\w.-]*(?:debug|trace)[\w.-]*['"`]/i,
];

/** Each changed or untracked file of the checkout with a hash of its content. */
export function snapshot(git: Git): Snapshot {
  const out: Snapshot = new Map();
  const listed = git.tryRun('status', '--porcelain', '-z', '--untracked-files=all');
  if (!listed) return out;
  for (const entry of listed.split('\0').filter(Boolean)) {
    const file = entry.slice(3);
    if (!file || /(^|\/)(node_modules|\.git)\//.test(file) || file.startsWith('docs/backlog/') && file.includes('/logs/')) continue;
    try {
      const abs = path.join(git.root, file);
      out.set(file, crypto.createHash('sha1').update(fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs) : 'deleted').digest('hex'));
    } catch { /* unreadable: leave it out */ }
  }
  return out;
}

/** Files that are new, removed or different in <after> compared with <before>. */
export function changedBetween(before: Snapshot, after: Snapshot): string[] {
  const files = new Set([...before.keys(), ...after.keys()]);
  return [...files].filter(f => before.get(f) !== after.get(f)).sort();
}

/** `file:line: text` of the added lines of <files> that look like left-over debugging. */
export function debugLeftovers(git: Git, files: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|php|sh)$/.test(file)) continue;
    const abs = path.join(git.root, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile() || fs.statSync(abs).size > 1e6) continue;
    const text = fs.readFileSync(abs, 'utf8').split('\n');
    const tracked = git.tryRun('ls-files', '--error-unmatch', '--', file) !== null;
    const added = new Set<number>();
    if (tracked) {
      let line = 0;
      for (const l of (git.tryRun('diff', 'HEAD', '-U0', '--', file) || '').split('\n')) {
        const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l);
        if (hunk) { line = Number(hunk[1]); for (let i = 0; i < (hunk[2] === undefined ? 1 : Number(hunk[2])); i++) added.add(line + i); }
      }
    } else {
      text.forEach((_, i) => added.add(i + 1));
    }
    for (const n of added) {
      const l = text[n - 1] || '';
      if (DEBUG_LINE.some(re => re.test(l))) found.push(`${file}:${n}: ${l.trim().slice(0, 120)}`);
    }
  }
  return found;
}

export type AgentFacts = { durationSec: number | null; turns: number | null; tokens: number | null; responseChars: number; denied: Array<{ tool: string; detail: string }> };

/** What an agent's result file says, whichever shape its harness prints: one JSON object, or one event per line (codex). */
interface ParsedAgentResult {
  /** The agent's messages, oldest first. */
  messages: string[];
  /** The streamed text, when the harness sends deltas instead of whole messages. */
  streamed: string;
  durationSec: number | null;
  turns: number | null;
  tokens: number | null;
  denied: Array<{ tool: string; detail: string }>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const totalTokens = (usage: any): number | null =>
  num(usage?.total_tokens) ?? ((num(usage?.input_tokens) ?? 0) + (num(usage?.output_tokens) ?? 0) || null);

/** The text of an agent message item, whichever field the harness puts it in. */
function itemText(item: any): string {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.map((c: any) => (typeof c === 'string' ? c : String(c?.text || ''))).join('');
  return '';
}

/** One JSON object, as claude and agy print with `--output-format json` (the harnesses name the fields alike). */
function objectResult(data: any): ParsedAgentResult {
  const text = typeof data.response === 'string' ? data.response : typeof data.result === 'string' ? data.result : '';
  const denied = [
    ...(Array.isArray(data.denied_actions) ? data.denied_actions : []).map((a: any) => ({ tool: String(a.tool || a.tool_name || a.action || 'command'), detail: String(a.detail || a.command || '') })),
    ...(Array.isArray(data.permission_denials) ? data.permission_denials : []).map((a: any) => ({ tool: String(a.tool_name || ''), detail: '' })),
  ];
  return {
    messages: text.trim() ? [text] : [],
    streamed: '',
    durationSec: num(data.duration_seconds) ?? (num(data.duration_ms) !== null ? Math.round((data.duration_ms as number) / 100) / 10 : null),
    turns: num(data.num_turns),
    tokens: totalTokens(data.usage),
    denied,
  };
}

/** One JSON event per line, as codex prints with `--json`. */
function jsonlResult(text: string): ParsedAgentResult | null {
  const events: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object') events.push(event);
    } catch { /* not an event */ }
  }
  if (!events.length) return null;
  const messages: string[] = [];
  const deltaParts: string[] = [];
  const denied: Array<{ tool: string; detail: string }> = [];
  let usage: any = null;
  let started = 0;
  let completed = 0;
  for (const event of events) {
    if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
      const item = event.item;
      if (item.type === 'agent_message' || item.type === 'message') {
        const message = itemText(item);
        if (message.trim()) messages.push(message);
      }
      if (item.type === 'command_execution' && (item.status === 'denied' || (item.exit_code === 126 && /denied/i.test(String(item.aggregated_output || ''))))) {
        denied.push({ tool: 'Bash', detail: String(item.command || '') });
      }
    }
    if (event.type === 'turn.started') started++;
    if (event.type === 'turn.completed') {
      completed++;
      if (event.usage && typeof event.usage === 'object') usage = event.usage;
    }
    // A refused action, as codex prints it (see codex.parseOutput and permissions.extract).
    if (
      event.type === 'tool_denial' || event.type === 'permission_denial' || event.type === 'approval.rejected' ||
      event.action === 'denied' || (event.type === 'command_execution' && (event.status === 'denied' || event.status === 'rejected'))
    ) {
      const item = event.item && typeof event.item === 'object' ? event.item : {};
      const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
      let tool = String(event.tool || event.tool_name || (item.type === 'command_execution' ? 'Bash' : item.type) || 'command');
      if (tool === 'command') tool = 'Bash';
      denied.push({ tool, detail: String(event.command || event.detail || item.command || input.command || input.file_path || '') });
    }
    if (event.type === 'item.delta' || event.type === 'content_block_delta' || event.type === 'message_delta') {
      const item = event.item && typeof event.item === 'object' ? event.item : {};
      const delta = event.delta && typeof event.delta === 'object' ? event.delta : {};
      if (!String(event.type).includes('reasoning') && item.type !== 'reasoning' && delta.type !== 'reasoning') {
        const part = typeof event.delta === 'string' ? event.delta : typeof delta.text === 'string' ? delta.text : '';
        if (part) deltaParts.push(part);
      }
    }
  }
  return {
    messages,
    streamed: deltaParts.join(''),
    durationSec: null,
    turns: started || completed || null,
    tokens: totalTokens(usage),
    denied,
  };
}

/** The agent's result file, as one JSON object or as JSONL events; null when it holds neither. */
function readAgentResult(jsonFile: string): ParsedAgentResult | null {
  let text: string;
  try { text = fs.readFileSync(jsonFile, 'utf8'); } catch { return null; }
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return objectResult(data);
  } catch { /* not one object: try the event stream */ }
  return jsonlResult(text);
}

/** Duration, turns, tokens and denied actions from an agent's result (harnesses name them alike; codex writes JSONL). */
export function agentFacts(jsonFile: string): AgentFacts {
  const parsed = readAgentResult(jsonFile);
  if (!parsed) return { durationSec: null, turns: null, tokens: null, responseChars: 0, denied: [] };
  const text = parsed.messages.join('\n\n') || parsed.streamed;
  return {
    durationSec: parsed.durationSec,
    turns: parsed.turns,
    tokens: parsed.tokens,
    responseChars: text.trim().length,
    denied: parsed.denied,
  };
}

/** The last thing the agent said, for a stop that has no artifact to point at; '' when it said nothing. */
export function agentLastMessage(jsonFile: string): string {
  const parsed = readAgentResult(jsonFile);
  if (!parsed) return '';
  const last = parsed.messages.length ? parsed.messages[parsed.messages.length - 1] : parsed.streamed;
  return last.trim();
}

/** The warnings of one agent round; stages that edit code are expected to change files. */
export function roundWarnings(r: Pick<AgentRound, 'exitCode' | 'responseChars' | 'denied' | 'filesChanged'>, opts: { editsCode: boolean; debug: string[] }): string[] {
  const w: string[] = [];
  for (const d of r.denied) w.push(`refused ${d.tool}${d.detail ? ` ${d.detail}` : ''}`);
  if (r.exitCode === 0 && r.responseChars === 0) w.push('empty answer: the agent said nothing');
  if (opts.editsCode && r.exitCode === 0 && !r.filesChanged.length) w.push('no files changed in this round');
  for (const d of opts.debug) w.push(`debug code left in the source: ${d}`);
  return [...new Set(w)];
}

/** Failures this round that were also failing in the previous gate result: the agent is not getting anywhere. */
export function repeatedFailures(previous: string[] | null, now: string[]): boolean {
  if (!previous || !now.length || previous.length !== now.length) return false;
  const was = new Set(previous);
  return now.every(f => was.has(f));
}

/** Written when a run moves to a new branch (readRounds ignores it). */
export interface MoveMark { kind: 'move'; at: string; from: string; to: string; reason: string }

/** Written by the push check (push-check.ts): what it found and what it did (readRounds ignores it). */
export interface PushCheckMark { kind: 'push-check'; at: string; branch: string; finding: string; action: string; detail?: string }

export function appendRound(logDir: string, row: AgentRound | GateResult | RoundStart | RunMark | MoveMark | PushCheckMark): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'attempts.jsonl'), `${JSON.stringify(row)}\n`);
  } catch (e) {
    // Observability never stops a run; the row that could not be written is kept beside it, in errors.log.
    keepError({ root: logDir, log: '' }, 'write attempts.jsonl', `${(e as Error).message}\n${JSON.stringify(row)}`);
  }
}

/** How many starts the item had before this one, and the last stage the latest of them reached (from its rows after its run line). */
export function priorStarts(logDir: string): { count: number; stage?: string; agent?: string; at?: string } {
  let text = '';
  try { text = fs.readFileSync(path.join(logDir, 'attempts.jsonl'), 'utf8'); } catch { return { count: 0 }; }
  let count = 0;
  let last: { stage?: string; agent?: string; at?: string } = {};
  for (const line of text.split('\n').filter(Boolean)) {
    let row: { kind?: string; stage?: unknown; agent?: unknown; at?: unknown };
    try { row = JSON.parse(line); } catch { continue; }
    if (row.kind === 'run') { count++; last = {}; }
    else if (typeof row.stage === 'string' && row.stage) {
      last = { stage: row.stage, ...(typeof row.agent === 'string' && row.agent ? { agent: row.agent } : {}), ...(typeof row.at === 'string' ? { at: row.at } : {}) };
    }
  }
  return { count, ...last };
}

/** The rounds since the pipeline was last started, in order, each agent round with the gate result that followed it. */
export function readRounds(logDir: string): Round[] {
  let text = '';
  try { text = fs.readFileSync(path.join(logDir, 'attempts.jsonl'), 'utf8'); } catch { return []; }
  const rounds: Round[] = [];
  for (const line of text.split('\n').filter(Boolean)) {
    let row: AgentRound | GateResult | RoundStart | RunMark;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.kind === 'run') {
      rounds.length = 0;
    } else if (row.kind === 'start') {
      rounds.push({ kind: 'agent', at: row.at, stage: row.stage, agent: row.agent, durationSec: null, exitCode: 0, responseChars: 0, turns: null, tokens: null, denied: [], filesChanged: [], warnings: [], running: true });
    } else if (row.kind === 'agent') {
      const open = rounds.findIndex(r => r.running && r.agent === row.agent);
      if (open >= 0) rounds[open] = row; else rounds.push(row);
    } else if (row.kind === 'gate') {
      const mine = [...rounds].reverse().find(r => r.agent === row.agent);
      if (mine) mine.gate = row;
    }
  }
  return rounds;
}
