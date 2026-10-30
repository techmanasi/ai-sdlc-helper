// Stage prompts: assets/prompts/prompt-<stage>.md with the tool rules (parts/tools.md) appended and the {{PLACEHOLDERS}}
// filled in, plus the developer's manual input for the stage.
import fs from 'node:fs';
import path from 'node:path';
import { ASSETS_DIR, exists } from '../util.js';
import { renderTemplate } from '../config/skills.js';
import { SetupError } from './context.js';

export const PROMPTS_DIR = path.join(ASSETS_DIR, 'prompts');

/** A file's text without its trailing newlines (as the shell's $(cat f) reads it). */
const text = (file: string) => fs.readFileSync(file, 'utf8').replace(/\n+$/, '');

/**
 * The prompt of <stage>: {{DOCS}} {{LOG}} {{TEST_DIR}} {{TEST_CMD}} {{TEST_FILE_CMD}} {{RED_SHA}} {{SLUG}}
 * {{TEST_FRAMEWORK}} {{TEST_FILES}} from <values>, and {{CODE_SEARCH}} from <guide> (else parts/code-search.md, which
 * must then exist). Throws SetupError for a missing prompt file.
 */
export function renderPrompt(stage: string, values: Record<string, string>, guide: string, promptsDir = PROMPTS_DIR): string {
  const file = path.join(promptsDir, `prompt-${stage}.md`);
  if (!exists(file)) throw new SetupError(`ERROR: missing prompt file ${file}`);
  let t = text(file);
  const tools = path.join(promptsDir, 'parts', 'tools.md');
  if (exists(tools)) t = `${t}\n\n${text(tools)}`;
  t = t.replace(/\{\{([A-Z_]+)\}\}/g, (all, name: string) => (name !== 'CODE_SEARCH' && name in values ? values[name] : all));
  if (t.includes('{{CODE_SEARCH}}')) {
    let g = guide;
    if (!g) {
      const part = path.join(promptsDir, 'parts', 'code-search.md');
      if (!exists(part)) throw new SetupError(`ERROR: missing prompt part ${part}`);
      g = text(part);
    }
    t = renderTemplate(t, g);
  }
  return t.replace(/\n+$/, '');
}

/**
 * The developer's text in the "## <stage>" section of <docsDir>/manual-inputs.md, as a prompt suffix; empty when the
 * file, the section or its text is missing.
 */
export function manualInput(docsDir: string, stage: string, testDir: string): string {
  const file = path.join(docsDir, 'manual-inputs.md');
  if (!exists(file)) return '';
  const lines: string[] = [];
  let on = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line === `## ${stage}`) { on = true; continue; }
    if (line.startsWith('## ')) on = false;
    else if (on) lines.push(line);
  }
  const t = lines.join('\n').replace(/\n+$/, '');
  if (!t.trim()) return '';
  return `\n\nMANUAL INPUT from the developer for this stage (binding; it cannot override the rule about editing ${testDir}/ or any other rule above):\n${t}`;
}

/**
 * Injects any PR review comments from <docsDir>/pr-comments.md into the agent's stage prompt.
 */
export function prCommentsInput(docsDir: string): string {
  const file = path.join(docsDir, 'pr-comments.md');
  if (!exists(file)) return '';
  const content = text(file).trim();
  if (!content) return '';
  return `\n\n## Pull Request Review Comments\nPlease address the following reviewer comments from the pull request:\n\n${content}\n`;
}
