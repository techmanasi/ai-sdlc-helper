// Writes the task's cost log (<docs>/cost/cost.md and cost.json) just before a stage commits, so each commit the pipeline
// makes on the run's branch carries the figures up to that point and the PR keeps them. The log is never committed on its
// own: a commit or push of its own would start CI again for nothing.

import fs from 'node:fs';
import { loadOpencodePrices, pricesNow } from '../models/prices.js';
import { costLog, costMarkdown } from '../runs/cost-log.js';
import { at, stamp, type Ctx } from './context.js';
import { keepError } from './errors.js';

/** The cost log's folder, from the checkout's top. */
export const costDir = (ctx: Pick<Ctx, 'docs'>): string => `${ctx.docs.replace(/\/+$/, '')}/cost`;
/** True for a path (from the checkout's top) inside the cost log's folder. */
export const isCostFile = (ctx: Pick<Ctx, 'docs'>, file: string): boolean => file.trim().startsWith(`${costDir(ctx)}/`);

let pricesTried = false;

/**
 * Writes the cost log from <log>/attempts.jsonl and returns its two paths (from the checkout's top) for the caller to
 * commit; empty when it could not be written, which is said in a WARNING line and kept in errors.log. Never throws.
 */
export async function writeCostLog(ctx: Ctx): Promise<string[]> {
  if (!pricesTried) {
    pricesTried = true;
    try { await loadOpencodePrices(ctx.env); } catch (e) {
      keepError(ctx, 'cost log: model prices', (e as Error).message);
      ctx.err(`WARNING: could not read model prices from OpenCode; the cost log shows tokens only for agents that report no cost (see ${ctx.log}/errors.log)`);
    }
  }
  try {
    let text = '';
    try { text = fs.readFileSync(at(ctx, `${ctx.log}/attempts.jsonl`), 'utf8'); } catch { return []; }
    const rows: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* a broken line is reported where the file is read for the run page */ }
    }
    const log = costLog(rows, { slug: ctx.slug, prices: pricesNow(), now: stamp() });
    const dir = costDir(ctx);
    fs.mkdirSync(at(ctx, dir), { recursive: true });
    fs.writeFileSync(at(ctx, `${dir}/cost.md`), costMarkdown(log));
    fs.writeFileSync(at(ctx, `${dir}/cost.json`), `${JSON.stringify(log, null, 2)}\n`);
    return [`${dir}/cost.md`, `${dir}/cost.json`];
  } catch (e) {
    keepError(ctx, 'cost log', (e as Error).message);
    ctx.err(`WARNING: could not write the cost log in ${costDir(ctx)} (see ${ctx.log}/errors.log)`);
    return [];
  }
}

/**
 * Commits the cost log on its own (`chore(<slug>): cost log`) for a push that is made anyway: Resolve conflicts, whose
 * agent runs after Finalise's commit. A failure is said in a WARNING line and kept in errors.log; never throws.
 */
export async function commitCostLog(ctx: Ctx): Promise<boolean> {
  const files = await writeCostLog(ctx);
  if (!files.length) return false;
  try {
    ctx.git.run('add', '--', ...files);
    if (!ctx.git.lines('diff', '--cached', '--name-only', '--', ...files).some(f => f.trim())) return false;
    ctx.git.run('commit', '-q', '-m', `chore(${ctx.slug}): cost log`, '--', ...files);
    return true;
  } catch (e) {
    keepError(ctx, 'cost log: commit', (e as Error).message);
    ctx.err(`WARNING: could not commit the cost log in ${costDir(ctx)} (see ${ctx.log}/errors.log)`);
    return false;
  }
}

/** Forget that prices were loaded (tests). */
export function resetCostLogPrices(): void { pricesTried = false; }
