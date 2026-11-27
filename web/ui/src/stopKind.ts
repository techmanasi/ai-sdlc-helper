// Why a run stopped, in one word: the kind of stop, its glyph, its colour, the cause the record gives and the ways on
// that the run page already offers. Pure, so the decisions are tested without a browser; Run.tsx shows them.
//
// Every kind comes from a record the server already returns. Nothing here is guessed: a run whose records name no kind
// is a Process, and a run that has not stopped shows no kind at all.
import type { RunView } from './api.js';

/** The nine kinds of stop a run can have. */
export type StopKind =
  | 'questions'
  | 'permission'
  | 'account'
  | 'waiting'
  | 'stopped'
  | 'repository'
  | 'stage-check'
  | 'loop'
  | 'process';

export type StopKindName =
  | 'Questions'
  | 'Permission'
  | 'Account'
  | 'Waiting'
  | 'Stopped by you'
  | 'Repository'
  | 'Stage check'
  | 'Loop'
  | 'Process';

/** A way on from the stop: the label the run page shows and the verb its button runs. */
export interface StopKindAction {
  label: string;
  /** The action the run page already has: answer, allow, deny, resume, retry or open-log. */
  verb: 'answer' | 'allow' | 'deny' | 'resume' | 'retry' | 'open-log';
}

export interface StopKindView {
  kind: StopKind;
  /** The name of the kind, as the design names it. */
  label: StopKindName;
  /** The mark of the kind (?, P, $, ◷, ■, R, ✗, ↻). */
  glyph: string;
  /** The colour token of web/ui/src/styles.css (s-paused, s-failed, s-running, s-not-started). */
  tone: string;
  /** One line from the record: the diagnosis, the note or the round's outcome. Never written here. */
  cause: string;
  /** The ways on, in the order they help most. */
  actions: StopKindAction[];
}

/** The glyph and the colour of each kind; the label is the kind's name. */
const KINDS: Record<StopKind, { label: StopKindName; glyph: string; tone: string }> = {
  questions: { label: 'Questions', glyph: '?', tone: 's-paused' },
  permission: { label: 'Permission', glyph: 'P', tone: 's-paused' },
  account: { label: 'Account', glyph: '$', tone: 's-paused' },
  waiting: { label: 'Waiting', glyph: '◷', tone: 's-running' },
  stopped: { label: 'Stopped by you', glyph: '■', tone: 's-not-started' },
  repository: { label: 'Repository', glyph: 'R', tone: 's-paused' },
  'stage-check': { label: 'Stage check', glyph: '✗', tone: 's-failed' },
  loop: { label: 'Loop', glyph: '↻', tone: 's-running' },
  process: { label: 'Process', glyph: '!', tone: 's-failed' },
};

/** The states a run can be in when it has stopped and needs a way on. */
const STOPPED = ['paused', 'failed', 'refused', 'stopped', 'interrupted'] as const;

/** The stage names the run page shows, by their key (the same list as Run.tsx). */
const STAGE_NAMES: Record<string, string> = {
  spec: 'Spec', plan: 'Plan', 'red-tests': 'Red tests', implement: 'Implement',
  'test-repair': 'Test repair', review: 'Review', finalise: 'Finalise', 'resolve-conflicts': 'Resolve conflicts',
};

/** The git-specific words a diagnosis carries when the stop was about the repository, not the code. */
const GIT_WORDS = /merge conflict|conflict(?:s|ing)? with|rebase|branch|push(?:ed)?|pull request|\bgit\b|stash|origin|GitHub|locked test files?|commits from GitHub|worktree/i;

/** The gate words a diagnosis carries when the stop was the stage's own check, not a crash. */
const GATE_WORDS = /RED GATE FAILED|green gate|red gate|GATE FAILED|GUARD FAILED|attempts exhausted|failing (?:check|test)/i;

/** The recorded outcome of a Review round whose fix loop ran out (src/pipeline/review-gate.ts). */
const LOOP_EXHAUSTED = /stopped:.*fix loop\(s\) used/i;

/** The note the status keeps while a run waits for a usage limit (src/pipeline/agent.ts). */
const WAIT_NOTE = /usage limit|rate limit|quota|reset/i;

/** The questions of a run that are still unanswered. */
function unansweredOf(v: RunView): number {
  return (v.questions || []).filter(q => !(q.answer || '').trim()).length;
}

/** The stage the run resumes at, named the way the run page names it. */
function resumeStageOf(v: RunView): string {
  const key = v.resumeFrom || '';
  if (!key) return '';
  return STAGE_NAMES[key] || key;
}

/** The ways on the run page offers for a stop of this kind, in the order they help most. */
function actionsOf(v: RunView, kind: StopKind, unanswered: number): StopKindAction[] {
  const out: StopKindAction[] = [];
  const stage = resumeStageOf(v);
  const resume: StopKindAction = { label: stage ? `Resume from ${stage}` : 'Resume', verb: 'resume' };
  switch (kind) {
    case 'questions':
      if (unanswered > 0) out.push({ label: 'Answer questions', verb: 'answer' });
      break;
    case 'permission':
      if ((v.permissions || []).length > 0) {
        out.push({ label: 'Allow permission', verb: 'allow' });
        out.push({ label: 'Deny permission', verb: 'deny' });
      } else if ((v.deniedPermissions || []).length > 0) {
        out.push({ label: 'Allow permission', verb: 'allow' });
      }
      break;
    case 'account':
      out.push({ label: 'Retry', verb: 'retry' });
      out.push(resume);
      break;
    case 'waiting':
      out.push({ label: 'Retry', verb: 'retry' });
      break;
    case 'stopped':
      out.push(resume);
      break;
    case 'repository':
      out.push(resume);
      break;
    case 'stage-check':
      out.push({ label: 'Retry', verb: 'retry' });
      out.push(resume);
      break;
    case 'loop':
      out.push(resume);
      break;
    case 'process':
      out.push({ label: 'Retry', verb: 'retry' });
      out.push({ label: 'Open log', verb: 'open-log' });
      break;
  }
  return out;
}

/**
 * The kind of stop the run is in, or null when the run has not stopped (it runs, it is done, it never started).
 * Where more than one kind fits, the first of them in this order wins: Questions, Permission, Account, Waiting,
 * Stopped by you, Repository, Stage check, Loop, Process.
 */
export function stopKind(v: RunView): StopKindView | null {
  if (!v || !STOPPED.includes(v.state as (typeof STOPPED)[number])) return null;

  const unanswered = unansweredOf(v);
  const pendingPerms = (v.permissions || []).length;
  const deniedPerms = (v.deniedPermissions || []).length;
  const recovery = v.recovery || null;
  const diagnosis = recovery?.diagnosis || '';
  const note = v.note || '';
  // The recorded outcome of the Review round whose fix loop ran out: a structured record, not a guess from the text.
  const loopOutcome = (v.reviewRounds || []).map(r => r.outcome || '').find(o => LOOP_EXHAUSTED.test(o));

  // The cause: what the record says. The recovery diagnosis first, then the status note, then the round's outcome.
  const causeOf = (): string => {
    if (diagnosis) return diagnosis;
    if (note) return note;
    if (loopOutcome) return loopOutcome;
    return '';
  };

  const build = (kind: StopKind, cause?: string): StopKindView => {
    const k = KINDS[kind];
    return {
      kind,
      label: k.label,
      glyph: k.glyph,
      tone: k.tone,
      cause: cause !== undefined ? cause : causeOf(),
      actions: actionsOf(v, kind, unanswered),
    };
  };

  // 1. Questions: the run waits for an answer it asked for.
  if (v.state === 'paused' && unanswered > 0) {
    // The cause is the questions file itself, not the stage's generic recovery text.
    const first = (v.questions || []).find(q => !(q.answer || '').trim());
    return build('questions', `${unanswered} question${unanswered > 1 ? 's' : ''} wait${unanswered > 1 ? '' : 's'} for an answer${first?.title ? `: ${first.title}` : ''}`);
  }

  // 2. Permission: the agent was refused an action and waits for the answer to it.
  if (pendingPerms > 0) return build('permission');
  if (deniedPerms > 0 && v.state === 'paused') return build('permission');

  // 3. Account: the failure text says the account, not the code, is the problem.
  if (recovery?.kind === 'account') return build('account');

  // 4. Waiting: the status note says the run waits for a limit to reset.
  if (note && WAIT_NOTE.test(note)) return build('waiting', note);

  // 5. Stopped by you: the user stopped it (the record says interrupted, or the run is gone without finishing).
  if (v.state === 'interrupted' || v.state === 'stopped') return build('stopped', `The run was stopped${v.stage ? ` during ${v.stage}` : ''}`);

  // 6. Repository: the stop was about the branch, the merge or the conflict, not the code. The structured marks come
  // first; the text is only read when the record names no kind, and then only for clearly git-specific words.
  if (recovery?.stage === 'Resolve conflicts') return build('repository');
  if (v.prConflicts === 'conflicting') return build('repository');
  if (recovery?.kind !== 'process' && diagnosis && GIT_WORDS.test(diagnosis)) return build('repository');

  // 7. Stage check: the stage's own gate failed (failed tests, the red gate, a guard). A run whose Review fix loop ran
  // out is a Loop, unless a check of its own failed too: then the check is what stopped it.
  const failingGate = (v.attempts || []).some(a => (a.gate?.failing || []).length > 0);
  const failedTests = !!v.tests && v.tests.failed > 0;
  if (failingGate || failedTests) return build('stage-check');
  if (!loopOutcome && diagnosis && GATE_WORDS.test(diagnosis)) return build('stage-check');

  // 8. Loop: Review sent its findings back and ran out of fix loops.
  if (loopOutcome) return build('loop', loopOutcome);

  // 9. Process: the agent crashed, was killed or exited non-zero, or nothing else fits.
  return build('process');
}
