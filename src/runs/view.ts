// What a monitor (the web app, later the plugin's pane) shows of the board and of one run, read from the run's files:
// its record, status.json, run.out, questions.md, logs/permissions.json, tests.json and stage-files.json. Nothing here
// writes, except answerQuestions.
import fs from 'node:fs';
import path from 'node:path';
import { exists } from '../util.js';
import { backlogItems, type BacklogItem } from '../backlog/index.js';
import { isProtected, loadState, ruleFor, type Ask } from '../permissions/index.js';
import { alive, readRecord, runState, type RunRecord } from './records.js';
import { projectSlugs, runChanges, runWorktree, type RunContext } from './index.js';
import { getPrFromBrief, getPrStatus } from '../pipeline/finalise.js';
import { stageRecoveryHint, type StageRecovery } from '../pipeline/hints.js';

export type ViewState = 'not started' | 'running' | 'paused' | 'done' | 'failed' | 'interrupted' | 'stopped' | 'refused';

/** One question of questions.md: "### Q<n>: <title>", a body, "**Suggested:** ...", "**Answer:** ...". */
export interface Question { n: number; title: string; body: string; suggested: string; answer: string }

export interface TestCounts { passed: number; failed: number; skipped: number; total: number }

export interface RunView {
  slug: string;
  state: ViewState;
  /** The stage status.json names (Spec, Plan, Red tests, Implement, Test repair, Review, Finalise), '' before the first. */
  stage: string;
  agent: string;
  model: string;
  effort: string;
  models: Record<string, { model: string; effort: string }>;
  attempt: string;
  /** Why a running run waits, for example a usage limit; '' otherwise. */
  note: string;
  agentStarted: string;
  runStarted: string;
  updated: string;
  record: Partial<RunRecord> | null;
  /** The folder holding the run's files: its worktree, else the main working tree for a run started in place. */
  dir: string | null;
  worktree: string | null;
  branch: string;
  base: string;
  /** Why a start was refused or a run could not begin. */
  message: string;
  questions: Question[];
  /** Refused actions waiting for Allow or Deny. */
  permissions: Ask[];
  /** Previously denied actions that may be allowed or re-decided. */
  deniedPermissions: Ask[];
  tests: TestCounts | null;
  stageFiles: Record<string, string[]>;
  changes: { changed: number; uncommitted: number; files: string[] } | null;
  /** The last lines of run.out. */
  tail: string[];
  /** The item's files, from its folder: brief.md, specs-1.md, logs/run.out … */
  docs: string[];
  /** The command that brings a discarded branch back, '' when none was discarded. */
  discarded: string;
  /** The --from value that resumes the run where it stopped ('' for the start). */
  resumeFrom: string;
  createPr?: boolean;
  pr?: string | null;
  prState?: 'OPEN' | 'MERGED' | 'CLOSED' | null;
  hasPrComments?: boolean;
  testIssues?: string | null;
  recovery?: StageRecovery | null;
}

const readText = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = (file: string): any => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** The questions of a questions.md text, in file order. */
export function parseQuestions(text: string): Question[] {
  const out: Question[] = [];
  let q: Question | null = null;
  let part: 'body' | 'suggested' | 'answer' = 'body';
  const add = (field: 'body' | 'suggested' | 'answer', line: string) => { if (q && line.trim()) q[field] = `${q[field]} ${line.trim()}`.trim(); };
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^### Q(\d+):\s*(.*)$/);
    if (head) {
      q = { n: Number(head[1]), title: head[2].trim(), body: '', suggested: '', answer: '' };
      out.push(q);
      part = 'body';
    } else if (/^\*\*Suggested:\*\*/.test(line)) {
      part = 'suggested';
      add(part, line.replace(/^\*\*Suggested:\*\*/, ''));
    } else if (/^\*\*Answer:\*\*/.test(line)) {
      part = 'answer';
      add(part, line.replace(/^\*\*Answer:\*\*/, ''));
    } else if (part !== 'answer') {
      add(part, line);
    }
  }
  return out;
}

/**
 * Puts each answer on its question's "**Answer:**" line (an answer is one line: newlines become spaces; an empty one
 * keeps what the line had). Returns how many questions there are and how many now have an answer. Throws when the file
 * is missing or a number names no question.
 */
export function answerQuestions(file: string, answers: Record<string, string>): { total: number; answered: number } {
  const text = readText(file);
  if (text === null) throw new Error(`no questions to answer: ${file} is missing`);
  const numbers = new Set(parseQuestions(text).map(q => q.n));
  for (const k of Object.keys(answers)) if (!numbers.has(Number(k))) throw new Error(`there is no question ${k}`);
  let n = 0;
  const lines = text.split('\n').map(line => {
    const head = line.match(/^### Q(\d+):/);
    if (head) n = Number(head[1]);
    const a = (answers[String(n)] ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
    return /^\*\*Answer:\*\*/.test(line) && a ? `**Answer:** ${a}` : line;
  });
  fs.writeFileSync(file, lines.join('\n'));
  const after = parseQuestions(lines.join('\n'));
  return { total: after.length, answered: after.filter(q => q.answer).length };
}

/** The stage a run resumes at: Plan and Red tests at their own stage, Test repair if claims exist, else Implement. */
export function resumeStage(stage: string, hasTestIssues = false): string {
  if (stage === 'Finalise' || stage === 'finalise') return 'finalise';
  if (stage === 'Review' || stage === 'review') return 'review';
  if (stage === 'Test repair' || stage === 'test-repair') return hasTestIssues === true ? 'test-repair' : 'implement';
  if (stage === 'Implement' || stage === 'implement') return 'implement';
  return stage === 'Plan' || stage === 'plan' ? 'plan' : stage === 'Red tests' || stage === 'red-tests' ? 'red-tests' : '';
}

function viewState(rec: Partial<RunRecord> | null, status: any): ViewState {
  if (rec) {
    const rs = runState(rec);
    if (rs === 'running' || rs === 'interrupted' || rs === 'stopped') return rs;
    if (rec.exit_code === '0') return 'done';
    if (rec.exit_code === '2') return 'paused';
    return !rec.worktree && rec.message ? 'refused' : 'failed';
  }
  if (!status) return 'not started';
  if (status.state === 'running') return alive(status.pid) ? 'running' : 'stopped';
  return ['paused', 'done', 'failed'].includes(status.state) ? status.state : 'failed';
}

function testCounts(result: any): TestCounts | null {
  if (!result || !Array.isArray(result.tests)) return null;
  const c = { passed: 0, failed: 0, skipped: 0, total: result.tests.length };
  for (const t of result.tests) if (t.status in c) (c as any)[t.status]++;
  c.failed += Array.isArray(result.suiteErrors) ? result.suiteErrors.length : 0;
  return c;
}

/** The last <n> lines of <file>, read from its last 64 KB. */
function tail(file: string, n: number): string[] {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').replace(/\n$/, '').split('\n');
    if (len < size) lines.shift(); // the first line may be cut
    return lines.slice(-n);
  } finally { fs.closeSync(fd); }
}

function docFiles(docsDir: string): string[] {
  const list = (rel: string): string[] => {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(path.join(docsDir, rel), { withFileTypes: true }); } catch { return []; }
    return names.filter(d => d.isFile()).map(d => (rel ? `${rel}/${d.name}` : d.name));
  };
  return [...list('').sort(), ...list('logs').sort()];
}

/** Everything the run screen shows of <slug>; `changes: false` skips the git calls that count its files. */
export function runView(ctx: RunContext, slug: string, opts: { changes?: boolean; tailLines?: number } = {}): RunView {
  const rec = readRecord(ctx.reg, slug);
  const worktree = runWorktree(ctx, slug);
  const inPlace = exists(path.join(ctx.root, ctx.backlogDir, slug, 'logs', 'status.json')) ? ctx.root : null;
  const dir = worktree || inPlace;
  const docsDir = dir ? path.join(dir, ctx.backlogDir, slug) : path.join(ctx.root, ctx.backlogDir, slug);
  const logs = path.join(docsDir, 'logs');
  const status = dir ? readJson(path.join(logs, 'status.json')) : null;
  const s = status && typeof status === 'object' ? status : {};
  const questions = parseQuestions(readText(path.join(docsDir, 'questions.md')) || '');
  const permState = dir ? loadState(path.join(logs, 'permissions.json')) : null;
  const stageFiles = readJson(path.join(logs, 'stage-files.json'));
  let changes: RunView['changes'] = null;
  if (opts.changes !== false && worktree) {
    const c = runChanges(ctx, slug);
    if (!('error' in c)) changes = { changed: c.changed, uncommitted: c.uncommitted, files: c.files };
  }
  const discarded = (readText(path.join(ctx.reg, `${slug}.discarded`)) || '').trim();
  const stage = typeof s.stage === 'string' ? s.stage : '';
  const state = viewState(rec, status);
  return {
    slug,
    state,
    stage,
    agent: s.agent || '',
    model: s.model || '',
    effort: s.effort || '',
    models: s.models && typeof s.models === 'object' ? s.models : {},
    attempt: s.attempt || '',
    note: s.note || '',
    agentStarted: s.agent_started || '',
    runStarted: s.run_started || '',
    updated: s.updated || rec?.finished || rec?.started || '',
    record: rec,
    dir,
    worktree,
    branch: rec?.branch || `${ctx.branchPrefix}${slug}`,
    base: rec?.base || '',
    message: rec?.message || '',
    questions,
    permissions: permState ? permState.pending : [],
    deniedPermissions: permState ? permState.denied.map(d => ({
      stage: d.stage || '',
      tool: d.tool,
      detail: d.detail,
      rule: d.rule || ruleFor(d.tool, { command: d.detail }, dir || ctx.root, permState.allow),
      protected: typeof d.protected === 'boolean' ? d.protected : isProtected(d.tool, d.detail),
    })) : [],
    tests: dir ? testCounts(readJson(path.join(logs, 'tests.json'))) : null,
    stageFiles: stageFiles && stageFiles.stages && typeof stageFiles.stages === 'object' ? stageFiles.stages : {},
    changes,
    tail: dir ? tail(path.join(logs, 'run.out'), opts.tailLines ?? 40) : [],
    docs: docFiles(docsDir),
    discarded,
    resumeFrom: resumeStage(stage, exists(path.join(docsDir, 'test-issues.md'))),
    testIssues: exists(path.join(docsDir, 'test-issues.md')) ? readText(path.join(docsDir, 'test-issues.md')) : null,
    createPr: (() => {
      const optFile = path.join(logs, 'finalise-options.json');
      if (fs.existsSync(optFile)) {
        try { return JSON.parse(fs.readFileSync(optFile, 'utf8')).createPr === true; } catch { /* ignore */ }
      }
      return false;
    })(),
    ...(() => {
      const p = getPrFromBrief(readText(path.join(docsDir, 'brief.md')) || '')
        || getPrFromBrief(readText(path.join(ctx.root, ctx.backlogDir, slug, 'brief.md')) || '');
      const b = rec?.branch || `${ctx.branchPrefix}${slug}`;
      const st = getPrStatus(ctx.root, p || b, ctx.env);
      return {
        pr: p || (st ? st.url : null),
        prState: st ? st.state : null,
      };
    })(),
    hasPrComments: fs.existsSync(path.join(docsDir, 'pr-comments.md')),
    recovery: ['paused', 'failed', 'refused', 'stopped', 'interrupted'].includes(state)
      ? stageRecoveryHint({
          slug,
          stage,
          state,
          exitCode: rec?.exit_code ? Number(rec.exit_code) : undefined,
          docsDir,
          runOut: dir ? tail(path.join(logs, 'run.out'), 40) : [],
          questions,
          permissions: permState ? permState.pending : [],
          hasTestIssues: exists(path.join(docsDir, 'test-issues.md')),
        })
      : null,
  };
}

/** One card of the board: a run in short. */
export type RunCard = Pick<RunView, 'slug' | 'state' | 'stage' | 'agent' | 'model' | 'effort' | 'attempt' | 'note' | 'updated' | 'message' | 'tests' | 'branch'> & {
  questions: number;
  permissions: number;
  deniedPermissions?: number;
  changes: { changed: number; uncommitted: number } | null;
};

export interface BoardView {
  /** The backlog items, null when the project has no backlog index. */
  items: BacklogItem[] | null;
  runs: RunCard[];
  maxParallel: number;
  running: number;
}

/** The board: the backlog and a card for every run of this checkout (see projectSlugs). */
export function boardView(ctx: RunContext, opts: { changes?: boolean } = {}): BoardView {
  const backlog = backlogItems({ root: ctx.root, backlogDir: ctx.backlogDir, branchPrefix: ctx.branchPrefix });
  const runs = projectSlugs(ctx).map((slug): RunCard => {
    const v = runView(ctx, slug, { changes: opts.changes, tailLines: 0 });
    return {
      slug, state: v.state, stage: v.stage, agent: v.agent, model: v.model, effort: v.effort, attempt: v.attempt, note: v.note, updated: v.updated,
      message: v.message, tests: v.tests, branch: v.branch, questions: v.questions.length, permissions: v.permissions.length,
      deniedPermissions: v.deniedPermissions.length,
      changes: v.changes && { changed: v.changes.changed, uncommitted: v.changes.uncommitted },
    };
  });
  return { items: backlog ? backlog.items : null, runs, maxParallel: ctx.maxParallel, running: runs.filter(r => r.state === 'running').length };
}
