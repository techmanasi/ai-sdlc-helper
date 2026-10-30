// Triage: turns a free-text report into backlog items (a brief per item and a line in the backlog index) with a Claude
// agent following the shipped triage prompt. The agent writes the files; this module checks what it created and
// commits exactly those files when asked. It never pushes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { allowedTools, resolve } from './config/settings.js';
import { renderSkill } from './config/skills.js';
import { backlogDirOf } from './registry/doctor.js';
import { pickBase, type RunContext } from './runs/index.js';
import { answerQuestions, parseQuestions } from './runs/view.js';
import { ASSETS_DIR, CONFIG_FILE, exists } from './util.js';

/** One backlog line: `- [ ] \`slug\` - title`, with its marker. */
export interface IndexItem { slug: string; marker: string; title: string }

/** The items of a backlog index, in order. */
export function indexItems(text: string): IndexItem[] {
  const out: IndexItem[] = [];
  for (const line of text.split('\n')) {
    const m = /^- \[(.)\] `([^`]+)`\s*(?:-\s*(.*))?$/.exec(line.trim());
    if (m) out.push({ marker: m[1], slug: m[2], title: (m[3] || '').trim() });
  }
  return out;
}

/** What a triage run added: new index lines, and whether each has its brief; briefs with no index line. */
export interface TriageResult {
  added: (IndexItem & { brief: boolean })[];
  /** Briefs written for a slug that has no line in the index. */
  orphans: string[];
  /** Changed or new files outside the backlog folder (triage should write none). */
  outside: string[];
}

const read = (f: string) => (exists(f) ? fs.readFileSync(f, 'utf8') : '');
const git = (root: string, args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
const dirty = (root: string): string[] => git(root, ['status', '--porcelain', '--untracked-files=all']).stdout
  .split('\n').filter(Boolean).map(l => l.slice(3).replace(/^.* -> /, ''));

/** The state triage starts from, to compare with afterwards. */
export interface Before { slugs: Set<string>; briefs: Set<string>; dirty: Set<string> }

export function snapshotBacklog(root: string, backlogDir: string): Before {
  const dir = path.join(root, backlogDir);
  const briefs = exists(dir) ? fs.readdirSync(dir).filter(d => exists(path.join(dir, d, 'brief.md'))) : [];
  return { slugs: new Set(indexItems(read(path.join(dir, 'index.md'))).map(i => i.slug)), briefs: new Set(briefs), dirty: new Set(dirty(root)) };
}

export function compareBacklog(root: string, backlogDir: string, before: Before): TriageResult {
  const dir = path.join(root, backlogDir);
  const items = indexItems(read(path.join(dir, 'index.md')));
  const added = items.filter(i => !before.slugs.has(i.slug)).map(i => ({ ...i, brief: exists(path.join(dir, i.slug, 'brief.md')) }));
  const listed = new Set(items.map(i => i.slug));
  const now = snapshotBacklog(root, backlogDir);
  const orphans = [...now.briefs].filter(s => !before.briefs.has(s) && !listed.has(s)).sort();
  const prefix = `${backlogDir.replace(/\/+$/, '')}/`;
  const outside = [...now.dirty].filter(f => !before.dirty.has(f) && !f.startsWith(prefix)).sort();
  return { added, orphans, outside };
}

/** The prompt: the triage skill rendered for the project, then the report. */
export function triagePrompt(root: string, report: string, { headless = false, env = process.env } = {}): string {
  const skill = renderSkill('triage', root, { env });
  if (skill === null) throw new Error('the triage prompt is missing from this installation');
  const noQuestions = headless
    ? '\nThis run is headless: you cannot ask the person anything (no AskUserQuestion). Decide what the code and conventions settle, and put everything else under "Open questions" in the brief.\n'
    : '';
  return `${skill.trim()}\n${noQuestions}\n## The report\n${report.trim()}\n`;
}

/** The tools a headless triage agent gets: read the code, run read-only commands, write the backlog files. */
export function triageTools(root: string, env: NodeJS.ProcessEnv): string[] {
  const { config } = resolve(root, { env });
  const base = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
  return config ? allowedTools(config) : base;
}

// --- Dashboard runs: the pieces the web server's triage runs are made of (worktree, prompts, files the agent writes) ---

export type TriageState = 'running' | 'choosing' | 'waiting' | 'ready' | 'interrupted' | 'stopped' | 'failed' | 'done';
export type DraftStatus = 'pending' | 'saved' | 'skipped';
export interface TriageItem { slug: string; type: string; priority: string; title: string; summary: string }
export interface TriageDraft { slug: string; type: 'bug' | 'feature'; priority: string; title: string; brief: string }
export interface TriageQuestion { id: string; text: string; suggested: string }
export interface TriageStreamPart { sessionId?: string; texts: string[]; tools: { name: string; summary: string }[] }

/** The folder (under the backlog folder) holding the files of dashboard runs. */
export const TRIAGE_DIR = '.triage';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const pad = (n: number) => String(n).padStart(2, '0');

/** A run id safe for folder and branch names: `YYYYMMDD-HHMMSS-<4 hex>`. */
export function newRunId(date = new Date()): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}-${time}-${crypto.randomBytes(2).toString('hex')}`;
}

/** The run's folder, relative to its worktree. */
export const triageRunDir = (backlogDir: string, runId: string): string => `${backlogDir}/${TRIAGE_DIR}/${runId}`;

const gitEnv = (cwd: string, env: NodeJS.ProcessEnv, args: string[]) =>
  spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });

/** Removes a triage worktree and its branch; what is not there is skipped. */
export function removeTriageWorktree(ctx: RunContext, worktree: string, branch: string): void {
  if (exists(worktree) && gitEnv(ctx.root, ctx.env, ['worktree', 'remove', '--force', worktree]).status !== 0) {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
  gitEnv(ctx.root, ctx.env, ['worktree', 'prune']);
  gitEnv(ctx.root, ctx.env, ['branch', '-D', branch]);
}

/**
 * Makes the worktree and branch of a dashboard run from the base (as `start` does, without a run record), then copies in
 * what is not committed yet: the settings, the backlog index and the briefs. Nothing is committed. A failure leaves nothing.
 */
export function createTriageWorktree(ctx: RunContext, runId: string): { worktree: string; branch: string; base: string } {
  const wt = path.join(ctx.wtBase, `triage-${runId}`);
  const branch = `${ctx.branchPrefix}triage-${runId}`;
  const base = pickBase(ctx);
  if (!base) throw new Error('the repository has no commit to start the branch from; commit first, or set SDLC_BASE');
  if (exists(wt)) throw new Error(`${wt} already exists`);
  if (gitEnv(ctx.root, ctx.env, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) throw new Error(`branch ${branch} already exists`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const add = gitEnv(ctx.root, ctx.env, ['worktree', 'add', wt, '-b', branch, base]);
  if (add.status !== 0) {
    removeTriageWorktree(ctx, wt, branch);
    throw new Error(`git worktree add ${wt} failed: ${add.stderr.trim().split('\n').pop()}`);
  }
  try {
    const config = path.join(ctx.root, CONFIG_FILE);
    if (!exists(path.join(wt, CONFIG_FILE)) && exists(config)) fs.copyFileSync(config, path.join(wt, CONFIG_FILE));
    const backlog = path.join(ctx.root, ctx.backlogDir);
    const index = path.join(backlog, 'index.md');
    if (exists(index)) {
      fs.mkdirSync(path.join(wt, ctx.backlogDir), { recursive: true });
      fs.copyFileSync(index, path.join(wt, ctx.backlogDir, 'index.md'));
    }
    const dirs = exists(backlog) ? fs.readdirSync(backlog, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== TRIAGE_DIR) : [];
    for (const d of dirs) {
      const from = path.join(backlog, d.name, 'brief.md');
      const to = path.join(wt, ctx.backlogDir, d.name, 'brief.md');
      if (exists(from) && !exists(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
  } catch (e) {
    removeTriageWorktree(ctx, wt, branch);
    throw e;
  }
  return { worktree: wt, branch, base };
}

const triageText = (name: string, values: Record<string, string>): string =>
  fs.readFileSync(path.join(ASSETS_DIR, 'prompts', `triage-${name}.md`), 'utf8')
    .replace(/\{\{([A-Z_]+)\}\}/g, (all, k: string) => (k in values ? values[k] : all)).trim();

/** The split phase: the headless triage prompt, then where to write the list of items. */
export function triageSplitPrompt(root: string, report: string, runDir: string, { env = process.env } = {}): string {
  return `${triagePrompt(root, report, { headless: true, env })}\n${triageText('split', { RUN_DIR: runDir, ITEMS_FILE: `${runDir}/items.json` })}\n`;
}

/** The item phase for one proposed item; interactive runs may write questions to a file instead of asking. */
export function triageItemPrompt(root: string, report: string, item: TriageItem, runDir: string, { headless = false, env = process.env } = {}): string {
  const questionsFile = `${runDir}/${item.slug}-questions.md`;
  const questions = headless ? '' : triageText('item-questions', { QUESTIONS_FILE: questionsFile });
  const text = triageText('item', {
    SLUG: item.slug, TYPE: item.type, PRIORITY: item.priority, TITLE: item.title, SUMMARY: item.summary,
    RUN_DIR: runDir, QUESTIONS_FILE: questionsFile, QUESTIONS: questions,
  });
  return `${triagePrompt(root, report, { headless, env })}\n${text}\n`;
}

/** The message that resumes an item session once its questions are answered. */
export const triageAnsweredMessage = (questionsFile: string): string => triageText('answered', { QUESTIONS_FILE: questionsFile });

/** The message that resumes a session that was interrupted. */
export const triageContinueMessage = (): string => triageText('continue', {});

/** The proposed items in <file>; <label> is how the file is named in messages. Throws with the problem. */
export function parseTriageItems(file: string, label: string): TriageItem[] {
  if (!exists(file)) throw new Error(`${label} is missing`);
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${label} is not valid JSON: ${(e as Error).message}`); }
  const shape = `${label} must be a list of { slug, type, priority, title, summary }`;
  if (!Array.isArray(data)) throw new Error(`${shape}: it is not a list`);
  const seen = new Set<string>();
  return data.map((e, i) => {
    const ok = e && typeof e === 'object' && ['slug', 'type', 'priority', 'title', 'summary'].every(k => typeof (e as Record<string, unknown>)[k] === 'string');
    if (!ok) throw new Error(`${shape}: entry ${i} is not`);
    const { slug, type, priority, title, summary } = e as TriageItem;
    if (!SLUG.test(slug)) throw new Error(`${label}: '${slug}' is not a slug (lowercase letters, digits and dashes)`);
    if (seen.has(slug)) throw new Error(`${label}: slug '${slug}' appears twice`);
    seen.add(slug);
    return { slug, type, priority, title, summary };
  });
}

/** What the agent wrote for <slug> in the worktree, ready to load into the new-item form. Throws with the problem. */
export function buildTriageDraft(worktree: string, backlogDir: string, slug: string): TriageDraft {
  const briefRel = `${backlogDir}/${slug}/brief.md`;
  const briefFile = path.join(worktree, briefRel);
  if (!exists(briefFile)) throw new Error(`${slug}: ${briefRel} is missing`);
  const brief = fs.readFileSync(briefFile, 'utf8');
  // [ \t]*, not \s*: an empty `Type:` or `Priority:` line must not take the next line's text.
  const type = (/^Type:[ \t]*(\S+)/m.exec(brief)?.[1] || '').toLowerCase();
  if (type !== 'bug' && type !== 'feature') throw new Error(`${slug}: ${briefRel} has Type '${type}', not bug or feature`);
  const entry = indexItems(read(path.join(worktree, backlogDir, 'index.md'))).find(i => i.slug === slug);
  if (!entry) throw new Error(`${slug}: ${backlogDir}/index.md has no line for ${slug}`);
  const priority = (/^Priority:[ \t]*(.*)$/m.exec(brief)?.[1] || '').trim();
  return { slug, type, priority, title: entry.title.replace(/^(bug|feature):\s*/i, ''), brief };
}

/** The questions in <file> that have no answer yet. */
export function pendingTriageQuestions(file: string): TriageQuestion[] {
  if (!exists(file)) return [];
  return parseQuestions(fs.readFileSync(file, 'utf8')).filter(q => !q.answer)
    .map(q => ({ id: `Q${q.n}`, text: [q.title, q.body].filter(Boolean).join('\n'), suggested: q.suggested }));
}

/** Writes the answers (keys `Q<n>`; "accept" is kept as written) once every pending question has one. Writes nothing otherwise. */
export function answerTriageQuestions(file: string, answers: Record<string, string>): void {
  for (const k of Object.keys(answers)) if (!/^Q\d+$/.test(k)) throw new Error(`not a question id: '${k}'`);
  for (const q of pendingTriageQuestions(file)) {
    if (typeof answers[q.id] !== 'string' || !answers[q.id].trim()) throw new Error(`question ${q.id} is not answered`);
  }
  answerQuestions(file, Object.fromEntries(Object.entries(answers).map(([k, v]) => [k.slice(1), v])));
}

const SUMMARY_FIELDS = ['file_path', 'path', 'pattern', 'command', 'url', 'description'];

/** One line of `claude -p --output-format stream-json --verbose`: its session id, prose and tool calls. */
export function parseStreamLine(line: string): TriageStreamPart {
  const part: TriageStreamPart = { texts: [], tools: [] };
  let data: any;
  try { data = JSON.parse(line); } catch { return part; }
  if (!data || typeof data !== 'object') return part;
  if (typeof data.session_id === 'string') part.sessionId = data.session_id;
  if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
    for (const c of data.message.content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) part.texts.push(c.text);
      else if (c?.type === 'tool_use' && typeof c.name === 'string') {
        const field = SUMMARY_FIELDS.find(f => typeof c.input?.[f] === 'string');
        const arg = field ? String(c.input[field]).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        part.tools.push({ name: c.name, summary: arg ? `${c.name} ${arg}` : c.name });
      }
    }
  }
  return part;
}

/** Starts claude and resolves its exit code: interactive (the terminal is the agent's) or headless (`-p`, output captured). */
export type RunClaude = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; interactive: boolean }) => Promise<{ code: number; stdout: string }>;

export const runClaude: RunClaude = (args, { cwd, env, interactive }) => new Promise(resolvePromise => {
  const child = spawn('claude', args, { cwd, env, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout?.on('data', c => { stdout += c; });
  child.on('error', e => resolvePromise({ code: 127, stdout: `${e.message}\n` }));
  child.on('close', code => resolvePromise({ code: code ?? 1, stdout }));
});

export interface TriageOptions {
  root: string;
  report: string;
  headless: boolean;
  model?: string;
  env?: NodeJS.ProcessEnv;
  run?: RunClaude;
}

/** Runs the triage agent and reports what it added to the backlog. */
export async function triage(opts: TriageOptions): Promise<{ code: number; output: string; result: TriageResult; backlogDir: string }> {
  const env = opts.env || process.env;
  const { config } = resolve(opts.root, { env });
  const backlogDir = backlogDirOf(config, opts.root);
  const before = snapshotBacklog(opts.root, backlogDir);
  const prompt = triagePrompt(opts.root, opts.report, { headless: opts.headless, env });
  const model = opts.model ? ['--model', opts.model] : [];
  const args = opts.headless
    ? ['-p', prompt, ...model, '--permission-mode', 'acceptEdits', '--allowedTools', ...triageTools(opts.root, env)]
    : [...model, prompt];
  const r = await (opts.run || runClaude)(args, { cwd: opts.root, env, interactive: !opts.headless });
  return { code: r.code, output: r.stdout, result: compareBacklog(opts.root, backlogDir, before), backlogDir };
}

/** Commits exactly the new briefs and the index on the current branch. Returns the commit hash, or throws with git's error. */
export function commitTriage(root: string, backlogDir: string, slugs: string[]): string {
  const files = [`${backlogDir}/index.md`, ...slugs.map(s => `${backlogDir}/${s}/brief.md`)];
  const add = git(root, ['add', '--', ...files]);
  if (add.status !== 0) throw new Error(add.stderr.trim());
  const c = git(root, ['commit', '-q', '-m', `docs(backlog): triage ${slugs.join(', ')}`, '--', ...files]);
  if (c.status !== 0) throw new Error((c.stderr || c.stdout).trim());
  return git(root, ['rev-parse', '--short', 'HEAD']).stdout.trim();
}
