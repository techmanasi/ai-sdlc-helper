// The editor "Open in editor" opens: the six built-in choices, the custom command, and the argv each one runs. Pure,
// with no Node imports, so the web UI shares it through the "ai-sdlc-helper/editor" subpath exactly as it shares
// review-limit. The saved choice itself is machine-wide (one user on one machine, every project at once) and lives
// in the registry file root (src/registry/projects.ts), never in a project's committed sdlc.config.json.

/** The editors the Default editor dialog offers, in order. */
export const EDITOR_IDS = ['vscode', 'cursor', 'zed', 'idea', 'system', 'custom'] as const;
export type EditorId = (typeof EDITOR_IDS)[number];

/** What the registry file root's "editor" may hold: the choice's id, and the custom command when one was typed. */
export interface EditorSetting {
  /** One of EDITOR_IDS; the default (vscode) applies when nothing was saved. */
  choice?: string;
  /** The custom command, with {path} where the folder to open goes. */
  custom?: string;
}

/** The editor that opens when nothing was saved yet. */
export const DEFAULT_EDITOR: EditorId = 'vscode';

/** One row of the Default editor dialog: the editor's id, its name, and the command the row shows. */
export interface EditorInfo { id: EditorId; name: string; cmd: string }

/** The six editors; the system one's command depends on the platform (systemEditorCmd), the custom one is typed. */
export const EDITORS: ReadonlyArray<EditorInfo> = [
  { id: 'vscode', name: 'VS Code', cmd: 'code' },
  { id: 'cursor', name: 'Cursor', cmd: 'cursor' },
  { id: 'zed', name: 'Zed', cmd: 'zed' },
  { id: 'idea', name: 'IntelliJ IDEA', cmd: 'idea' },
  { id: 'system', name: 'System default', cmd: '' },
  { id: 'custom', name: 'Custom command', cmd: '' },
];

/** The editor's display name; an unknown id (a registry hand-edited to something else) names the default. */
export const editorName = (id: string | undefined): string => (EDITORS.find(e => e.id === id) || EDITORS[0]).name;

/**
 * What opens a folder with the system's default program: `open` on macOS, `xdg-open` on Linux, `explorer` on Windows.
 * (explorer, not `cmd /c start ""`: the tool never builds a shell string to run.)
 */
export const systemEditorCmd = (platform: string): string =>
  platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';

/** The dialog's six rows, each with the command it shows on this machine. */
export const editorChoices = (platform: string): EditorInfo[] =>
  EDITORS.map(e => (e.id === 'system' ? { ...e, cmd: systemEditorCmd(platform) } : e));

/** Splits a custom command into words: whitespace separates, "double quoted" words stay together. No shell anywhere. */
export function splitWords(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let word = false;
  for (const ch of line) {
    if (quote) { if (ch === '"') quote = false; else cur += ch; continue; }
    if (ch === '"') { quote = true; word = true; continue; }
    if (/\s/.test(ch)) { if (word) { out.push(cur); cur = ''; word = false; } continue; }
    cur += ch;
    word = true;
  }
  if (word) out.push(cur);
  return out;
}

/**
 * The argv that opens <path> with the editor <choice> on <platform>: the command and its arguments, with {path}
 * replaced by the path as ONE argument — never a string interpolated into a command. An unknown <choice> (a registry
 * hand-edited to something else) opens the default, so what the dialog shows is what opens.
 */
export function editorArgv(choice: string | undefined, customCommand: string | undefined, path: string, platform: string): { cmd: string; args: string[] } {
  if (choice === 'custom') {
    const words = splitWords(customCommand || '');
    return { cmd: words[0] || '', args: words.slice(1).map(w => (w === '{path}' ? path : w)) };
  }
  if (choice === 'system') return { cmd: systemEditorCmd(platform), args: [path] };
  const editor = EDITORS.find(e => e.id === choice) || EDITORS[0]; // an unknown id opens the default, VS Code
  return { cmd: editor.cmd, args: [path] };
}

/**
 * Why a custom command cannot be used: it is empty, it has no {path} of its own (the placeholder is replaced with the
 * folder as one argument, so it must stand as a whole word), or it holds a character that only means something in a
 * shell string — it never runs in one.
 */
export function validateCustomEditor(cmd: string | undefined): string | null {
  const text = (cmd || '').trim();
  if (!text) return 'the command is empty; type one with {path} where the folder goes';
  if (/[\r\n]/.test(text)) return 'the command must be one line, without newlines';
  if (/[;|&$`<>]/.test(text)) return 'the command must not contain ; | & $ ` < or > (it runs without a shell)';
  if (!splitWords(text).includes('{path}')) return 'the command must contain {path} as its own word; it is replaced with the folder as one argument';
  return null;
}

/**
 * Problems with a saved editor setting: the choice must be one of EDITOR_IDS, and a custom command must be one that
 * can run without a shell — also when another editor is chosen (a remembered command is kept, but it must stay valid).
 */
export function editorSettingErrors(choice: unknown, custom: unknown): string[] {
  if (typeof choice !== 'string' || !(EDITOR_IDS as readonly string[]).includes(choice)) {
    return [`editor: must be one of ${EDITOR_IDS.join(', ')} (got ${JSON.stringify(choice)})`];
  }
  if (custom !== undefined && custom !== null && typeof custom !== 'string') return ['editor.custom: must be text'];
  if (choice !== 'custom' && (custom === undefined || custom === null)) return [];
  const bad = validateCustomEditor(typeof custom === 'string' ? custom : undefined);
  return bad ? [`editor.custom: ${bad}`] : [];
}

/**
 * The saved editor setting as it applies: an unknown choice or no setting at all means the default, VS Code. This is
 * what the dialog shows and what "Open in editor" runs, so the two can never disagree.
 */
export function normalizeEditor(stored: EditorSetting | undefined | null): { choice: EditorId; custom?: string } {
  const choice = stored?.choice && (EDITOR_IDS as readonly string[]).includes(stored.choice) ? (stored.choice as EditorId) : DEFAULT_EDITOR;
  return { choice, ...(stored?.custom ? { custom: stored.custom } : {}) };
}
