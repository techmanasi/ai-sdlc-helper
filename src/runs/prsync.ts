// "Sync PR": one action that brings a task's pull request up to date here: its state, its CI, and its review comments.
// A failing CI is written to <docs>/ci-failure.md so the Implement stage can be started again with the details. Both files
// are saved on the run's branch (see run-docs.ts), never in the main checkout.
import { ciFailureReport, getPrFromBrief, markPrReady, type CiState } from '../pipeline/finalise.js';
import { liveBranch, liveBriefPr, type RunContext } from './index.js';
import { syncPrComments } from './completed.js';
import { saveRunDoc, type SavedRunDoc } from './run-docs.js';
import { syncRunPr, type PrCard } from './view.js';

export const CI_FAILURE_FILE = 'ci-failure.md';

export interface PrSync {
  ok: boolean;
  /** The PR as the board card shows it (state, CI, when it was checked). */
  pr: PrCard;
  /** Review comments saved to pr-comments.md (committed on the run's branch). */
  count: number;
  /** Error lines of the failing CI, for the run page; empty unless the CI failed. */
  summary: string[];
  /** Why a file was not committed (the run is running, the PR is merged, ...). */
  notes?: string[];
  err?: string[];
}

/** The pull request to ask about: the brief's link (the worktree's first: a moved run's new one is there), else the run's branch now. */
const targetOf = (ctx: RunContext, slug: string): string => liveBriefPr(ctx, slug, getPrFromBrief) || liveBranch(ctx, slug);

/** Saves (<markdown>) or removes (null) ci-failure.md on the run's branch (see saveRunDoc); never in the main checkout. */
function saveCiFailure(ctx: RunContext, slug: string, markdown: string | null, prState?: string | null): SavedRunDoc {
  return saveRunDoc(ctx, slug, { file: CI_FAILURE_FILE, text: markdown, message: `chore(${slug}): CI failure report`, what: 'the CI failure report', prState });
}

/** Writes (or, when the CI is not failing, removes) ci-failure.md for <slug> on the run's branch; answers what GitHub said. */
export function writeCiFailure(ctx: RunContext, slug: string, prState?: string | null): { ok: boolean; ci: CiState; failing: string[]; summary: string[]; note?: string; err?: string[] } {
  const report = ciFailureReport(ctx.root, targetOf(ctx, slug), ctx.env);
  if (!report.ok) return { ok: false, ci: report.ci, failing: [], summary: [], err: report.err };
  const saved = saveCiFailure(ctx, slug, report.ci === 'failed' ? report.markdown : null, prState);
  return { ok: true, ci: report.ci, failing: report.failing, summary: report.summary, ...(saved.note ? { note: saved.note } : {}), ...(saved.err.length ? { err: saved.err } : {}) };
}

/** Marks the run's pull request ready for review, then brings its status and comments up to date like Sync PR. */
export async function markPrReadyForRun(ctx: RunContext, slug: string, onStep?: (label: string) => void): Promise<PrSync> {
  onStep?.('Marking the PR ready for review');
  const target = targetOf(ctx, slug);
  const err: string[] = [];
  if (!target) err.push(`${slug} has no pull request to mark ready`);
  else if (!markPrReady(ctx.root, target, ctx.env, text => err.push(text))) {
    if (!err.length) err.push(`could not mark ${target} ready for review`);
  }
  if (err.length) {
    const pr = await syncRunPr(ctx, slug);
    return { ok: false, pr, count: 0, summary: [], err };
  }
  return syncPr(ctx, slug, onStep);
}

/** Sync PR: the PR's state and CI from GitHub now, its review comments, and the CI failure details when the CI failed. */
export async function syncPr(ctx: RunContext, slug: string, onStep?: (label: string) => void): Promise<PrSync> {
  onStep?.('Asking GitHub for the PR state and CI');
  const pr = await syncRunPr(ctx, slug);
  const err: string[] = [];
  const notes = new Set<string>();
  onStep?.('Saving the review comments');
  const comments = syncPrComments(ctx, slug);
  if (!comments.ok) { if (pr.url) err.push(...(comments.err || ['the review comments could not be read'])); } else err.push(...(comments.err || []));
  if (comments.note) notes.add(comments.note);
  let summary: string[] = [];
  if (pr.ci === 'failed') {
    onStep?.('Reading the failing CI details');
    const f = writeCiFailure(ctx, slug, pr.state);
    summary = f.summary;
    err.push(...(f.err || []));
    if (f.note) notes.add(f.note);
  } else if (pr.ci) {
    const saved = saveCiFailure(ctx, slug, null, pr.state);
    err.push(...saved.err);
  }
  return {
    ok: pr.state !== null || pr.url !== null, pr, count: comments.count, summary,
    ...(notes.size ? { notes: [...notes] } : {}), ...(err.length ? { err } : {}),
  };
}
