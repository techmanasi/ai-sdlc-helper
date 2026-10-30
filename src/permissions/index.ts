// Permission requests of the SDLC agents: what a headless `claude -p` agent was refused, and what the developer decided.
// The state file (<backlogDir>/<slug>/logs/permissions.json) holds: pending (asks not decided yet), allow (rules for this
// run), bypass (stage keys run without permission checks), denied (asks refused). Rules are never secrets: a tool name and
// a path or command.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../runs/records.js';

/** The repository's saved allow rules, in its main working tree. */
export const REPO_RULES = '.claude/sdlc-permissions.json';
const PATH_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];
export const CHOICES = ['allow', 'always', 'deny'] as const;
export type Choice = typeof CHOICES[number];

export interface Ask { stage: string; tool: string; detail: string; rule: string; protected: boolean }
export interface DeniedAsk { tool: string; detail: string; stage?: string; rule?: string; protected?: boolean }
export interface PermissionState { pending: Ask[]; allow: string[]; bypass: string[]; denied: DeniedAsk[] }

const readJson = (file: string | undefined, fallback: any): any => {
  try { return JSON.parse(fs.readFileSync(file!, 'utf8')); } catch { return fallback; }
};
const emptyState = (): PermissionState => ({ pending: [], allow: [], bypass: [], denied: [] });

export function loadState(file: string): PermissionState {
  const s = readJson(file, null);
  const e = emptyState();
  if (!s || typeof s !== 'object') return e;
  for (const k of Object.keys(e) as (keyof PermissionState)[]) if (Array.isArray(s[k])) (e as any)[k] = s[k];
  return e;
}
const saveState = (file: string, s: PermissionState): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
};

const pathOf = (i: Record<string, any>): string =>
  (typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : '');

/** The parts of a shell command line, split on ; && || | & and newlines outside quotes. */
export function commandParts(command: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"') { cur += c + (command[i + 1] || ''); i++; continue; }
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '\\') {
      cur += c + (command[i + 1] || ''); i++; continue;
    } else if (';|&\n'.includes(c)) {
      parts.push(cur); cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map(x => x.trim()).filter(Boolean);
}

/** Package managers whose `run`/`exec` would allow every script: their rule names the script too. */
const SCRIPT_RUNNERS = ['npm', 'pnpm', 'yarn', 'bun'];

/** The rule for one command: its first one or two words; for `npm run <script>` and the like, the first three. */
function commandRule(command: string): string {
  const words = command.split(/\s+/);
  const head = words[0] && /^[\w./-]+$/.test(words[0]) ? [words[0]] : [];
  if (head.length && words[1] && /^[a-z][\w-]*$/.test(words[1])) head.push(words[1]);
  if (head.length === 2 && SCRIPT_RUNNERS.includes(words[0]) && ['run', 'run-script', 'exec'].includes(words[1]) && words[2] && /^[\w:.@/-]+$/.test(words[2]) && !words[2].startsWith('-')) {
    head.push(words[2]);
  }
  return head.length ? `Bash(${head.join(' ')}:*)` : 'Bash';
}

/** Whether an allow rule (`Bash(prefix:*)`, `Bash(prefix *)` or an exact `Bash(command)`) already covers one command. */
export function covers(rule: string, command: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const prefix = m[1].replace(/(:\*| \*)$/, '');
  if (prefix === m[1]) return command === prefix;
  return command === prefix || command.startsWith(`${prefix} `);
}

/**
 * The denial as a short, narrow allow rule: the path for a file tool, the first command words for Bash, else the tool name.
 * For a command line with several commands, the first one that no rule in <allowed> covers: naming an allowed one (the
 * `cd` of `cd x; sed ...`) would grant nothing, and the agent would be refused again.
 */
export function ruleFor(tool: string, input: unknown, cwd: string, allowed: string[] = []): string {
  const i: Record<string, any> = input && typeof input === 'object' ? input : {};
  if (PATH_TOOLS.includes(tool)) {
    const p = pathOf(i);
    if (!p) return tool;
    const rel = path.isAbsolute(p) ? path.relative(cwd, p) : p;
    return `${tool}(./${rel.replace(/^\.\//, '')})`;
  }
  if (tool === 'Bash' && typeof i.command === 'string') {
    const parts = commandParts(i.command.trim());
    if (!parts.length) return 'Bash';
    const open = parts.find(c => !allowed.some(r => covers(r, c)));
    return commandRule(open || parts[0]);
  }
  return tool;
}

/**
 * Whether a refused command line is already decided: every part is covered by a rule, and one of the developer's run
 * rules covers a part (so a refusal the developer allowed is not asked again under the name of another, allowed part).
 */
function decidedLine(tool: string, input: unknown, allowed: string[], runRules: string[]): boolean {
  const i: Record<string, any> = input && typeof input === 'object' ? input : {};
  if (tool !== 'Bash' || typeof i.command !== 'string') return false;
  const parts = commandParts(i.command.trim());
  const all = [...allowed, ...runRules];
  return parts.length > 0 && parts.every(c => all.some(r => covers(r, c))) && parts.some(c => runRules.some(r => covers(r, c)));
}

/** What the person is shown: the file, the command, or the tool's input in one line. */
export function detailFor(tool: string, input: unknown, cwd: string): string {
  const i: Record<string, any> = input && typeof input === 'object' ? input : {};
  const p = pathOf(i);
  if (p) return path.isAbsolute(p) ? path.relative(cwd, p) : p;
  if (typeof i.command === 'string') return i.command.replace(/\s+/g, ' ').trim().slice(0, 200);
  return JSON.stringify(i).slice(0, 200);
}

/** A path under a `.claude/` folder is refused as a "sensitive file" even when an allow rule names it: only a bypass lifts it. */
export const isProtected = (tool: string, detail: string): boolean => PATH_TOOLS.includes(tool) && /(^|\/)\.claude\//.test(detail);

/**
 * Reads the agent's `--output-format json` result: writes its text to <logFile>, and records the denials as pending asks
 * (unless decided). A file that is not JSON (an older agent, a provider error) is copied to the log unchanged.
 * <allowed> holds the rules the agent ran with, so a refused command line is named by its part that was not allowed.
 * Returns the number of pending asks.
 */
export function extract({ jsonFile, logFile, stateFile, stage, cwd, errFile, allowed = [] }: {
  jsonFile: string; logFile: string; stateFile: string; stage: string; cwd: string; errFile?: string; allowed?: string[];
}): number {
  const raw = fs.existsSync(jsonFile) ? fs.readFileSync(jsonFile, 'utf8') : '';
  const err = errFile && fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
  let data: any = null;
  try { data = JSON.parse(raw); } catch { data = null; }
  const state = loadState(stateFile);
  if (!data || typeof data !== 'object') {
    const lines = raw.split('\n').filter(l => l.trim().length > 0);
    const jsonlEvents: any[] = [];
    let codexText = '';
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        jsonlEvents.push(ev);
        if (ev.type === 'message' || ev.type === 'response') {
          if (typeof ev.content === 'string') codexText = ev.content;
          else if (ev.message?.content) codexText = String(ev.message.content);
        }
      } catch {}
    }
    if (jsonlEvents.length > 0) {
      fs.writeFileSync(logFile, `${codexText}${codexText.endsWith('\n') ? '' : '\n'}${err}`);
      for (const ev of jsonlEvents) {
        if (ev.type === 'tool_denial' || ev.action === 'denied') {
          const tool = String(ev.tool || 'command');
          const detail = String(ev.command || ev.detail || '');
          const ask: Ask = {
            stage, tool, detail,
            rule: ruleFor(tool, { command: detail }, cwd, [...allowed, ...state.allow]),
            protected: isProtected(tool, detail),
          };
          const same = (a: { tool: string; detail: string }) => a.tool === ask.tool && a.detail === ask.detail;
          if (state.denied.some(same) || state.pending.some(a => same(a) && a.stage === stage)) continue;
          if (!ask.protected && (state.allow.includes(ask.rule) || decidedLine(tool, { command: detail }, allowed, state.allow))) continue;
          state.pending.push(ask);
        }
      }
      saveState(stateFile, state);
      return state.pending.length;
    }
    fs.writeFileSync(logFile, raw + err);
    return state.pending.length;
  }
  const text = typeof data.result === 'string' ? data.result : '';
  const note = data.subtype && data.subtype !== 'success' ? `[agent ended: ${data.subtype}]\n` : '';
  fs.writeFileSync(logFile, `${note}${text}${text.endsWith('\n') ? '' : '\n'}${err}`);
  for (const d of Array.isArray(data.permission_denials) ? data.permission_denials : []) {
    const tool = String(d.tool_name || '');
    if (!tool) continue;
    const detail = detailFor(tool, d.tool_input, cwd);
    const ask: Ask = { stage, tool, detail, rule: ruleFor(tool, d.tool_input, cwd, [...allowed, ...state.allow]), protected: isProtected(tool, detail) };
    const same = (a: { tool: string; detail: string }) => a.tool === ask.tool && a.detail === ask.detail;
    if (state.denied.some(same) || state.pending.some(a => same(a) && a.stage === stage)) continue;
    if (!ask.protected && (state.allow.includes(ask.rule) || decidedLine(tool, d.tool_input, allowed, state.allow))) continue;
    state.pending.push(ask);
  }
  saveState(stateFile, state);
  return state.pending.length;
}

export const FINALISE_PERMISSIONS = [
  'Bash(git push:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr list:*)',
  'Bash(gh pr:*)',
  'Bash(gh:*)',
];

/** Allow rules for a stage's run: this run's decisions plus the repository's saved ones. */
export function rulesFor(docsDir: string, repoFile: string, stage?: string): string[] {
  const run = loadState(path.join(docsDir, 'logs', 'permissions.json')).allow;
  const repo = readJson(repoFile, {});
  const saved: string[] = Array.isArray(repo.allow) ? repo.allow.filter((r: unknown) => typeof r === 'string') : [];
  const stageSpecific = stage === 'finalise' ? FINALISE_PERMISSIONS : [];
  return [...new Set([...saved, ...run, ...stageSpecific])];
}

/** The permission mode a stage's agent runs with: bypassPermissions once a protected path was allowed for it. */
export const modeFor = (docsDir: string, stage: string): 'bypassPermissions' | 'acceptEdits' =>
  (loadState(path.join(docsDir, 'logs', 'permissions.json')).bypass.includes(stage) ? 'bypassPermissions' : 'acceptEdits');

/**
 * Applies a decision to pending asks (<which>: an index or "all"). `allow` grants for this run (a protected path lifts the
 * checks for that stage), `always` also saves a rule in the repository file (never for a protected path), `deny` records
 * the refusal so it does not ask again. Returns the number still pending; throws on an unknown choice or index.
 */
export function decide(stateFile: string, which: string, choice: string, repoFile?: string): number {
  if (!(CHOICES as readonly string[]).includes(choice)) throw new Error(`choice must be allow, always or deny, not '${choice}'`);
  const state = loadState(stateFile);
  const fromDenied = which.startsWith('denied:');
  const rawWhich = fromDenied ? which.slice('denied:'.length) : which;
  const list = fromDenied ? state.denied : state.pending;
  const picked = rawWhich === 'all' ? list.map((_, i) => i) : [Number(rawWhich)];
  if (picked.some(i => !Number.isInteger(i) || i < 0 || i >= list.length)) {
    throw new Error(`no ${fromDenied ? 'denied' : 'pending'} request '${rawWhich}'`);
  }
  const repo = readJson(repoFile, {});
  const saved: string[] = Array.isArray(repo.allow) ? repo.allow : [];
  let isSaved = false;
  for (const i of picked) {
    const item = list[i] as any;
    const ask: Ask = {
      stage: ('stage' in item && typeof item.stage === 'string' && item.stage) || '',
      tool: item.tool,
      detail: item.detail,
      rule: ('rule' in item && typeof item.rule === 'string' && item.rule) || ruleFor(item.tool, { command: item.detail }, path.dirname(stateFile), state.allow),
      protected: ('protected' in item && typeof item.protected === 'boolean') ? item.protected : isProtected(item.tool, item.detail),
    };
    if (fromDenied) {
      if (choice === 'allow' || choice === 'always') {
        if (ask.protected) {
          if (ask.stage && !state.bypass.includes(ask.stage)) state.bypass.push(ask.stage);
        } else {
          if (!state.allow.includes(ask.rule)) state.allow.push(ask.rule);
          if (choice === 'always' && !saved.includes(ask.rule)) { saved.push(ask.rule); isSaved = true; }
        }
      }
    } else {
      if (choice === 'deny') {
        state.denied.push({ tool: ask.tool, detail: ask.detail });
      } else if (ask.protected) {
        if (!state.bypass.includes(ask.stage)) state.bypass.push(ask.stage);
      } else {
        if (!state.allow.includes(ask.rule)) state.allow.push(ask.rule);
        if (choice === 'always' && !saved.includes(ask.rule)) { saved.push(ask.rule); isSaved = true; }
      }
    }
  }
  if (fromDenied) {
    if (choice === 'allow' || choice === 'always') {
      state.denied = state.denied.filter((_, i) => !picked.includes(i));
    }
  } else {
    state.pending = state.pending.filter((_, i) => !picked.includes(i));
  }
  saveState(stateFile, state);
  if (isSaved && repoFile) {
    fs.mkdirSync(path.dirname(repoFile), { recursive: true });
    fs.writeFileSync(repoFile, `${JSON.stringify({ ...repo, allow: saved }, null, 2)}\n`);
  }
  return state.pending.length;
}

/**
 * The project's saved rules file: in the checkout the project lives in, also when <root> is one of its pipeline runs'
 * worktrees (see projectRoot), so every run of the project sees the same rules.
 */
export function repoRulesFile(root: string): string {
  return path.join(projectRoot(root), REPO_RULES);
}

/**
 * `ai-sdlc-helper permissions extract <agent.json> <log> <state.json> <stage> <cwd> [<stderr file>] | args <docs-dir>
 * <stage> [<repo-rules.json>] | mode <docs-dir> <stage> | list <state.json> | decide <state.json> <n|all>
 * allow|always|deny [<repo-rules.json>]`. Relative paths are taken from <cwd>. Throws on an error.
 */
export function permissionsMain(argv: string[], out: (line: string) => void, cwd: string): void {
  const [cmd, ...a] = argv;
  const at = (f: string | undefined) => (f === undefined ? f : path.resolve(cwd, f));
  switch (cmd) {
    case 'extract': {
      const [jsonFile, logFile, stateFile, stage, agentCwd, errFile] = a;
      if (!jsonFile || !logFile || !stateFile || !stage || !agentCwd) {
        throw new Error('extract: <agent.json> <log> <state.json> <stage> <cwd> [<stderr file>]');
      }
      // SDLC_ALLOWED: the agent's allow rules, one per line.
      const allowed = (process.env.SDLC_ALLOWED || '').split('\n').filter(Boolean);
      out(String(extract({ jsonFile: at(jsonFile)!, logFile: at(logFile)!, stateFile: at(stateFile)!, stage, cwd: agentCwd, errFile: at(errFile), allowed })));
      break;
    }
    case 'args':
      for (const r of rulesFor(at(a[0] || '.')!, at(a[2] || REPO_RULES)!)) out(r);
      break;
    case 'mode':
      out(modeFor(at(a[0] || '.')!, a[1]));
      break;
    case 'list':
      out(JSON.stringify(loadState(at(a[0] || '')!).pending));
      break;
    case 'decide':
      out(String(decide(at(a[0] || '')!, a[1], a[2], at(a[3] || REPO_RULES))));
      break;
    default:
      throw new Error('Usage: ai-sdlc-helper permissions extract|args|mode|list|decide ...');
  }
}
