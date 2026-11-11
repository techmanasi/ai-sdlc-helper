// "Sync PR": one action that brings a task's pull request up to date here: its state, its CI, and its review comments.
// A failing CI is written to <docs>/ci-failure.md so the Implement stage can be started again with the details.
import fs from 'node:fs';
import path from 'node:path';
import { ciFailureReport, getPrFromBrief, type CiState } from '../pipeline/finalise.js';
import { readRecord } from './records.js';
import { runWorktree, type RunContext } from './index.js';
import { syncPrComments } from './completed.js';
import { syncRunPr, type PrCard } from './view.js';

export const CI_FAILURE_FILE = 'ci-failure.md';

export interface PrSync {
  ok: boolean;
  /** The PR as the board card shows it (state, CI, when it was checked). */
  pr: PrCard;
  /** Review comments saved to pr-comments.md. */
  count: number;
  /** Error lines of the failing CI, for the run page; empty unless the CI failed. */
  summary: string[];
  err?: string[];
}

/** Where a run's docs are: the main checkout's folder, and the run's worktree's. */
function docsDirs(ctx: RunContext, slug: string): string[] {
  const dirs = [path.join(ctx.root, ctx.backlogDir, slug)];
  const wt = runWorktree(ctx, slug);
  if (wt) dirs.push(path.join(wt, ctx.backlogDir, slug));
  return dirs;
}

const targetOf = (ctx: RunContext, slug: string): string => {
  const brief = path.join(ctx.root, ctx.backlogDir, slug, 'brief.md');
  const pr = getPrFromBrief(fs.existsSync(brief) ? fs.readFileSync(brief, 'utf8') : '');
  return pr || readRecord(ctx.reg, slug)?.branch || `${ctx.branchPrefix}${slug}`;
};

/** Writes (or, when the CI is not failing, removes) ci-failure.md for <slug>; answers what GitHub said. */
export function writeCiFailure(ctx: RunContext, slug: string): { ok: boolean; ci: CiState; failing: string[]; summary: string[]; err?: string[] } {
  const report = ciFailureReport(ctx.root, targetOf(ctx, slug), ctx.env);
  if (!report.ok) return { ok: false, ci: report.ci, failing: [], summary: [], err: report.err };
  for (const dir of docsDirs(ctx, slug)) {
    const file = path.join(dir, CI_FAILURE_FILE);
    if (report.ci === 'failed') {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, report.markdown);
    } else {
      fs.rmSync(file, { force: true });
    }
  }
  return { ok: true, ci: report.ci, failing: report.failing, summary: report.summary };
}

/** Sync PR: the PR's state and CI from GitHub now, its review comments, and the CI failure details when the CI failed. */
export async function syncPr(ctx: RunContext, slug: string, onStep?: (label: string) => void): Promise<PrSync> {
  onStep?.('Asking GitHub for the PR state and CI');
  const pr = await syncRunPr(ctx, slug);
  const err: string[] = [];
  onStep?.('Saving the review comments');
  const comments = syncPrComments(ctx, slug);
  if (!comments.ok && pr.url) err.push(...(comments.err || ['the review comments could not be read']));
  let summary: string[] = [];
  if (pr.ci === 'failed') {
    onStep?.('Reading the failing CI details');
    const f = writeCiFailure(ctx, slug);
    summary = f.summary;
    if (!f.ok) err.push(...(f.err || []));
  } else if (pr.ci) {
    for (const dir of docsDirs(ctx, slug)) fs.rmSync(path.join(dir, CI_FAILURE_FILE), { force: true });
  }
  return { ok: pr.state !== null || pr.url !== null, pr, count: comments.count, summary, ...(err.length ? { err } : {}) };
}
