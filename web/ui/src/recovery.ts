// The recovery options a stopped run can act on. Every word and link here comes from a field the server already
// returns: the stop kind (web/ui/src/stopKind.ts), the recorded stage, diagnosis, note and attempt error, and the
// stages resume.ts says are allowed. Nothing here claims a retry happened or a top-up was checked.
import { cliLine, type RunView } from './api.js';
import type { StopKind } from './stopKind.js';
import { RESUME_STAGES, resumeOptions, type ResumeOption } from './resume.js';

export type RecoveryAction = 'resume' | 'resume-at' | 'switch-model' | 'top-up';

export interface RecoveryOption {
  id: string;
  label: string;
  detail?: string;
  /** One of the calls the run page already makes; no new backend action is invented here. */
  action: RecoveryAction;
  /** Stage key the option acts on ('' when no stage is recorded). */
  stage: string;
  /** Stage name for the in-page confirmation. */
  stageName?: string;
  /** The billing URL from the recorded failure text; a top-up option is offered only with one. */
  billingUrl?: string;
  /** Ask in-page before acting (Resume at a later stage). */
  confirm?: boolean;
}

/** Only the recorded fields the recovery options read; a RunView fits this shape. */
export interface RecoveryView {
  state?: string;
  stage?: string;
  resumeFrom?: string;
  redCommit?: string;
  testIssues?: string | null;
  note?: string;
  recovery?: RunView['recovery'];
  attempts?: RunView['attempts'];
  tail?: string[];
}

/** The stages of a stop that need a way on. Questions and permissions have their own controls on the run page. */
const RECOVERY_KINDS: readonly StopKind[] = ['account', 'waiting', 'stopped', 'repository', 'stage-check', 'loop', 'process'];

/** The stopped stage, named the way resume.ts names it (the record's name, never a guess from the state). */
function stoppedStageOf(view: RecoveryView): { key: string; name: string } {
  const named = (view.recovery?.stage || view.stage || '').trim();
  const hit = RESUME_STAGES.find(s => s.name.toLowerCase() === named.toLowerCase() || s.key === named.toLowerCase());
  if (hit) return { key: hit.key, name: hit.name };
  return { key: view.resumeFrom || '', name: named };
}

/** The first allowed stage after the one being retried; Review is the bailout the design names. */
function laterStageOf(allowed: ResumeOption[], fromKey: string): ResumeOption | undefined {
  const from = RESUME_STAGES.findIndex(s => s.key === fromKey);
  if (from < 0) return undefined;
  const later = allowed.filter((o, i) => i > from && o.enabled);
  return later.find(o => o.key === 'review') || later[0];
}

/** The first billing URL a record actually contains; no provider URL is invented when the error has none. */
export function billingUrlOf(view: RecoveryView): string {
  const recorded = [
    view.recovery?.diagnosis || '', view.note || '',
    ...(view.attempts || []).map(a => a.error || ''),
    ...(view.tail || []),
  ];
  for (const text of recorded) {
    for (const found of text.match(/https?:\/\/[^\s"'<>`]+/g) || []) {
      const url = found.replace(/[.,;:)\]]+$/, '');
      if (/billing|credits|top-?up/i.test(url)) return url;
    }
  }
  return '';
}

/** The recorded error text to disclose, with the log file when the record names one. */
export function errorDetailsOf(view: RecoveryView): { text: string; source: string } | null {
  const failed = [...(view.attempts || [])].reverse().find(a => (a.error || '').trim());
  if (failed) return { text: (failed.error || '').trim(), source: failed.log ? `logs/${failed.log}` : '' };
  const diagnosis = (view.recovery?.diagnosis || view.note || '').trim();
  return diagnosis ? { text: diagnosis, source: '' } : null;
}

/** The CLI line of a resume, in the same form the run page copies elsewhere. */
export const recoveryCliLine = (slug: string, stage: string): string =>
  cliLine(['start', slug, ...(stage ? ['--from', stage] : [])]);

/**
 * The ordered options for this stop. A test failure gets no top-up; a later stage is offered only when resume.ts
 * says it works; a paused run with no recorded error is left to its questions and permission controls.
 */
export function recoveryOptions(kind: StopKind | null, view: RecoveryView): RecoveryOption[] {
  if (!kind || !RECOVERY_KINDS.includes(kind)) return [];
  if (view.state === 'paused' && !(view.recovery?.kind || view.note || (view.attempts || []).some(a => (a.error || '').trim()))) return [];

  const allowed = resumeOptions({
    redCommit: view.redCommit || '',
    hasTestIssues: view.testIssues != null,
    resumeFrom: view.resumeFrom || '',
  });
  const stopped = stoppedStageOf(view);
  const atStop = allowed.find(o => o.key === stopped.key);
  const primary = (atStop?.enabled ? atStop : undefined)
    || allowed.find(o => o.suggested && o.enabled)
    || allowed.find(o => o.enabled);
  if (!primary) return [];
  // A bailout is a stage *after the stop*, so it is anchored to the recorded stopped stage, not to the resume pick.
  const later = laterStageOf(allowed, stopped.key || primary.key);
  const out: RecoveryOption[] = [];

  // Only a recorded billing link gets a button: without one there is nothing to open.
  const billingUrl = billingUrlOf(view);
  if ((kind === 'account' || kind === 'waiting') && billingUrl) {
    out.push({
      id: 'top-up',
      label: 'Open billing',
      detail: `Top up, then retry ${primary.name} — retry is a separate press; the run cannot check your balance.`,
      action: 'top-up',
      stage: primary.key,
      billingUrl,
    });
  }

  const resumeWord = kind === 'repository' || kind === 'stopped' || kind === 'loop' || primary.key !== stopped.key;
  const retryLabel = `${resumeWord ? 'Resume from' : 'Retry'} ${primary.name}`;
  out.push({
    id: 'resume',
    label: retryLabel,
    detail: `Start ${primary.name} again on the existing branch.`,
    action: 'resume',
    stage: primary.key,
  });

  if (kind === 'account' || kind === 'waiting' || kind === 'process') {
    out.push({
      id: 'switch-model',
      label: 'Switch model',
      detail: `Pick another model for ${stopped.name || primary.name}, then retry.`,
      action: 'switch-model',
      stage: stopped.key || primary.key,
    });
  }

  if (later) {
    out.push({
      id: 'resume-at',
      label: `Resume at ${later.name}`,
      detail: `Start ${later.name} on the branch as it is now; the earlier stages do not run again.`,
      action: 'resume-at',
      stage: later.key,
      stageName: later.name,
      confirm: true,
    });
  }
  return out;
}

/** The one way on a stopped run offers, shown under its failed round. */
export type WayOn =
  | { from: 'option'; label: string; option: RecoveryOption }
  | { from: 'auto'; label: string };

/**
 * One button, not a menu: a top-up when a limit was recorded with a billing link (a retry cannot help before it), else
 * the fix the server recommends, else a retry. Skipping ahead stays in "Resume at…", so it is never this button.
 */
export function wayOn(options: readonly RecoveryOption[], recovery: RecoveryView['recovery'], state: string): WayOn | null {
  const topUp = options.find(o => o.action === 'top-up');
  if (topUp) return { from: 'option', label: topUp.label, option: topUp };
  if (recovery?.autoAction && ['paused', 'failed', 'refused'].includes(state)) return { from: 'auto', label: recovery.autoAction.label };
  const retry = options.find(o => o.action === 'resume');
  return retry ? { from: 'option', label: retry.label, option: retry } : null;
}

/** The stage the way on belongs under: the one the record names, matched by name or key. */
export function wayOnStage(view: RecoveryView): string {
  return stoppedStageOf(view).key;
}
