// The cost log of a task: what every run of it cost, by stage, with tokens and time, built from the rows of
// <log>/attempts.jsonl. The pipeline writes it to <docs>/cost/ (cost.md to read, cost.json for tools) and commits it with
// the stage's own commits, so the figures stay in git with the task after its worktree and logs are gone. Pure: the caller
// reads the file and passes the price table.

import type { PriceTable } from '../models/prices.js';
import { addRound, emptyUsage, stageOfAgent, sumUsage, type UsageTotals } from './timeline.js';

/** One stage's figures in a run, or (in `CostLog.stages`) over every run. */
export interface CostStage {
  stage: string;
  /** How many times the stage began (a Review that sends work back runs Red tests again). */
  passes: number;
  /** Wall time from each start of the stage to the next stage or the run's end, added up. */
  wallSec: number;
  /** The models its agent rounds ran with, in the order first seen. */
  models: string[];
  usage: UsageTotals;
}

export interface CostRun {
  /** 1 for the first start; 0 for rows written before the file had run rows. */
  n: number;
  started: string;
  /** The stage the run was started from ('' for the top). */
  from: string;
  ended: string | null;
  /** How it ended (done, failed, paused, ...); null while it runs. */
  state: string | null;
  wallSec: number;
  stages: CostStage[];
  usage: UsageTotals;
}

export interface CostLog {
  version: 1;
  slug: string;
  generatedAt: string;
  /** False when no price table was given: rounds that reported tokens but no cost are counted as unpriced. */
  priced: boolean;
  runs: CostRun[];
  /** Each stage over every run. */
  stages: CostStage[];
  usage: UsageTotals;
  wallSec: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const ms = (t: string): number => { const x = Date.parse(t); return Number.isFinite(x) ? x : NaN; };
const between = (a: string, b: string): number => {
  const d = (ms(b) - ms(a)) / 1000;
  return Number.isFinite(d) && d > 0 ? d : 0;
};

/**
 * The cost log of <slug> from its attempts.jsonl rows (every start of it, in order). A stage still open at the last row
 * counts its time up to <now>.
 */
export function costLog(rows: unknown[], opts: { slug: string; prices?: PriceTable; now?: string }): CostLog {
  const prices = opts.prices ?? new Map();
  // Row times are local and carry no zone (context.ts stamp()); without <now> an open stage ends at the last row.
  const lastRow = [...rows].reverse().find(r => r && typeof r === 'object' && str((r as Record<string, unknown>).at)) as Record<string, unknown> | undefined;
  const now = opts.now ?? str(lastRow?.at);
  const runs: CostRun[] = [];
  let run: CostRun | null = null;
  let stages = new Map<string, CostStage>();
  let open: { stage: CostStage; at: string } | null = null;

  const stageIn = (name: string): CostStage => {
    let s = stages.get(name);
    if (!s) { s = { stage: name, passes: 0, wallSec: 0, models: [], usage: emptyUsage() }; stages.set(name, s); }
    return s;
  };
  const close = (at: string) => {
    if (open) open.stage.wallSec += between(open.at, at);
    open = null;
  };
  const finish = (at: string | null) => {
    if (!run) return;
    close(at ?? now);
    run.stages = [...stages.values()];
    run.usage = sumUsage(run.stages.map(s => s.usage));
    run.wallSec = between(run.started, run.ended ?? at ?? now);
  };
  const begin = (r: Record<string, unknown>, n: number) => {
    run = { n, started: str(r.at), from: str(r.from), ended: null, state: null, wallSec: 0, stages: [], usage: emptyUsage() };
    runs.push(run);
    stages = new Map();
    open = null;
  };

  let last = '';
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const at = str(r.at);
    if (r.kind === 'run') {
      if (run) {
        // Started again with no end row: the process was killed (only the last run can still be running).
        const prev = run as CostRun;
        if (!prev.state) prev.state = 'stopped';
        finish(last || null);
      }
      begin(r, typeof r.n === 'number' ? r.n : runs.length + 1);
      if (at) last = at;
      continue;
    }
    // Rows from before the file had run rows: one run, numbered 0.
    if (!run) begin({ at }, 0);
    const cur = run as unknown as CostRun;
    switch (r.kind) {
      case 'stage': {
        const name = str(r.stage);
        if (!name || !at) break;
        close(at);
        const s = stageIn(name);
        s.passes++;
        open = { stage: s, at };
        break;
      }
      case 'end':
        if (at) { cur.ended = at; cur.state = str(r.state) || null; }
        close(at || now);
        break;
      case 'agent': {
        const name = stageOfAgent(str(r.stage)) ?? (open as { stage: CostStage } | null)?.stage.stage ?? null;
        if (!name) break;
        const s = stageIn(name);
        addRound(s.usage, r, prices);
        const model = str(r.model);
        if (model && !s.models.includes(model)) s.models.push(model);
        break;
      }
      default: break;
    }
    if (at) last = at;
  }
  // The last run with no end row is still going: its open stage runs up to <now>.
  if (run) finish((run as CostRun).ended ? last : null);

  const byStage = new Map<string, CostStage>();
  for (const rn of runs) {
    for (const s of rn.stages) {
      const t = byStage.get(s.stage) ?? { stage: s.stage, passes: 0, wallSec: 0, models: [], usage: emptyUsage() };
      t.passes += s.passes;
      t.wallSec += s.wallSec;
      for (const m of s.models) if (!t.models.includes(m)) t.models.push(m);
      t.usage = sumUsage([t.usage, s.usage]);
      byStage.set(s.stage, t);
    }
  }
  const all = [...byStage.values()];
  return {
    version: 1, slug: opts.slug, generatedAt: now, priced: prices.size > 0, runs, stages: all,
    usage: sumUsage(all.map(s => s.usage)), wallSec: runs.reduce((a, rn) => a + rn.wallSec, 0),
  };
}

/** Dollars as the log shows them: `$0.42`, `≈$0.42` when part of it is estimated, `free` at 0, `—` with no cost. */
export function costText(u: UsageTotals): string {
  if (u.costUsd === null) return u.tokens || u.input || u.output ? 'no price' : '—';
  if (u.costUsd === 0) return 'free';
  const d = u.costUsd < 0.01 ? '<$0.01' : `$${u.costUsd.toFixed(2)}`;
  return u.estimatedUsd > 0 ? `≈${d}` : d;
}

/** 950, 6.0k, 12.30M. */
export function tokenText(t: number): string {
  if (t >= 1e6) return `${(t / 1e6).toFixed(2)}M`;
  if (t >= 1e3) return `${(t / 1e3).toFixed(1)}k`;
  return String(Math.round(t));
}

/** 12s, 4m 05s, 1h 02m. */
export function timeText(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const tokensOf = (u: UsageTotals): number => u.tokens || u.input + u.output;
const cell = (v: string): string => v.replace(/\|/g, '\\|');
const row = (cells: string[]): string => `| ${cells.map(cell).join(' | ')} |`;
const when = (t: string): string => (t ? t.replace('T', ' ').slice(0, 16) : '—');

/** cost.md: the task total, a table by stage over every run, a table by run, and each run's stages. */
export function costMarkdown(log: CostLog): string {
  const u = log.usage;
  const lines: string[] = [
    `# Cost of ${log.slug}`,
    '',
    `Written by the pipeline at ${when(log.generatedAt)} from \`logs/attempts.jsonl\`; updated with each stage's commit.`,
    '`≈` marks dollars estimated from the model\'s list price (the agent reported tokens only); `free` is a model that cost',
    'nothing; `no price` is a round with tokens whose model has no known price.',
    '',
    `**Total: ${costText(u)} · ${tokenText(tokensOf(u))} tokens · ${timeText(log.wallSec)} run time · ${timeText(u.durationSec)} agent time · ${log.runs.length} run${log.runs.length === 1 ? '' : 's'}**`,
  ];
  if (u.estimatedUsd > 0 && u.costUsd !== null) lines.push('', `Estimated part: $${u.estimatedUsd.toFixed(2)} of ${costText(u).replace('≈', '')}.`);
  if (u.unpriced > 0) lines.push('', `${u.unpriced} round${u.unpriced === 1 ? '' : 's'} with tokens and no price ${u.unpriced === 1 ? 'is' : 'are'} not in the dollar figures.`);

  lines.push('', '## By stage, all runs', '',
    row(['Stage', 'Passes', 'Time', 'Agent time', 'Rounds', 'Models', 'Input', 'Output', 'Cache read', 'Cache write', 'Tokens', 'Cost']),
    row(['---', '--:', '--:', '--:', '--:', '---', '--:', '--:', '--:', '--:', '--:', '--:']));
  for (const s of log.stages) {
    const x = s.usage;
    lines.push(row([s.stage, String(s.passes), timeText(s.wallSec), timeText(x.durationSec), String(x.rounds), s.models.join(', ') || '—',
      tokenText(x.input), tokenText(x.output), tokenText(x.cacheRead), tokenText(x.cacheWrite), tokenText(tokensOf(x)), costText(x)]));
  }
  lines.push(row(['**Total**', '', `**${timeText(log.wallSec)}**`, `**${timeText(u.durationSec)}**`, `**${u.rounds}**`, '',
    tokenText(u.input), tokenText(u.output), tokenText(u.cacheRead), tokenText(u.cacheWrite), `**${tokenText(tokensOf(u))}**`, `**${costText(u)}**`]));

  lines.push('', '## By run', '', row(['Run', 'Started', 'From', 'Result', 'Time', 'Rounds', 'Tokens', 'Cost']),
    row(['--:', '---', '---', '---', '--:', '--:', '--:', '--:']));
  for (const rn of log.runs) {
    lines.push(row([String(rn.n), when(rn.started), rn.from || 'start', rn.state ?? 'running', timeText(rn.wallSec), String(rn.usage.rounds),
      tokenText(tokensOf(rn.usage)), costText(rn.usage)]));
  }

  for (const rn of log.runs) {
    if (!rn.stages.length) continue;
    lines.push('', `### Run ${rn.n}: ${when(rn.started)}, from ${rn.from || 'start'}, ${rn.state ?? 'running'}`, '',
      row(['Stage', 'Time', 'Agent time', 'Rounds', 'Models', 'Tokens', 'Cost']), row(['---', '--:', '--:', '--:', '---', '--:', '--:']));
    for (const s of rn.stages) {
      lines.push(row([s.stage, timeText(s.wallSec), timeText(s.usage.durationSec), String(s.usage.rounds), s.models.join(', ') || '—',
        tokenText(tokensOf(s.usage)), costText(s.usage)]));
    }
  }
  return `${lines.join('\n')}\n`;
}
