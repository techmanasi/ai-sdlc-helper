// The Default editor dialog's decisions, DOM-free so a test can run them without a page. The rules themselves live in
// the shared pure module (src/config/editor.ts, imported here as 'ai-sdlc-helper/editor'), so what the dialog checks
// before saving is exactly what the server checks when it saves.
import { validateCustomEditor } from 'ai-sdlc-helper/editor';

/** What the dialog holds while it is open: the picked choice and the custom command as typed. */
export interface EditorDraft {
  choice: string;
  custom: string;
}

/** The inline error under the draft ('' when Save can go ahead): only the custom choice needs a command typed. */
export function draftProblem(draft: EditorDraft): string {
  if (draft.choice !== 'custom') return '';
  return validateCustomEditor(draft.custom) || '';
}

/**
 * The PUT body of a draft: the choice, and the custom command only when it is valid text — junk typed before
 * switching to another editor is dropped rather than saved, and a valid command is kept so switching back remembers it.
 */
export function editorPatch(draft: EditorDraft): { choice: string; custom?: string } {
  const custom = draft.custom.trim();
  if (draft.choice === 'custom') return { choice: draft.choice, custom };
  return { choice: draft.choice, ...(custom && !validateCustomEditor(custom) ? { custom } : {}) };
}
