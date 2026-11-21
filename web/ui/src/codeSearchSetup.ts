// Pure decisions for the code search setup dialog: the badges, copy text and actions for each indexer state. Kept free of
// Preact and the DOM so the presentation is exercised directly by web/test/code-search-ui.test.ts and shared by the
// modal and both entry points.
import type { Check, CodeIndexerStatus } from './api';

/** A button in an indexer's card. `body` is the setup request to send; `refresh` re-inspects instead. */
export interface SetupAction {
  label: string;
  disabled: boolean;
  body?: { indexer: string; build: boolean };
  refresh?: boolean;
}

export interface IndexerView {
  badges: string[];
  /** The command to copy, when there is one (an install command or a manual build invocation). */
  copyText: string | null;
  /** The rest of the display-only instructions, shown separately from the copied command. */
  copyInstructions: string | null;
  actions: SetupAction[];
  copyDisabled: boolean;
  busy: boolean;
}

/** The manual invocation inside display text such as "build the graph with /graphify . in Claude Code". */
const invocation = (ix: CodeIndexerStatus): string | null => {
  const build = ix.build || '';
  const m = /(^|\s)(\/[A-Za-z][\w-]*(?:\s+\S+)?)/.exec(build);
  return m ? m[2] : (build || null);
};

/**
 * The command to install a missing binary, separated from the rest of the display-only instructions.
 * The copied command ends at the first alternative (" (or pipx …)") or the trailing ", then …"; everything
 * after stays visible, so Graphify copies only `uv tool install graphifyy` while its pipx alternative and
 * build step remain in the instructions.
 */
const installOf = (setup: string | null): { command: string | null; instructions: string | null } => {
  const text = setup || '';
  const alternative = text.indexOf(' (');
  const trailing = text.indexOf(',');
  const cut = Math.min(alternative < 0 ? text.length : alternative, trailing < 0 ? text.length : trailing);
  const rest = text.slice(cut).replace(/^\s*,\s*/, '').trim();
  return {
    command: text.slice(0, cut).trim() || null,
    instructions: rest || null,
  };
};

/**
 * What one indexer card shows and offers. Installation and indexing are independent: a missing binary cannot be set up,
 * an index that exists can be used without rebuilding, and a manual build can only be configured once its index appears.
 */
export function indexerPresentation(ix: CodeIndexerStatus, busy: boolean): IndexerView {
  const body = (build: boolean) => ({ indexer: ix.name, build });
  const badges = [
    ix.installed ? 'Installed' : 'Not installed',
    ix.index ? (ix.indexed ? 'Indexed' : 'Unindexed') : 'No index required',
  ];

  let view: IndexerView;
  if (!ix.installed) {
    const install = installOf(ix.setup);
    view = {
      badges,
      copyText: install.command,
      copyInstructions: install.instructions,
      actions: [
        { label: 'Build Index', disabled: true, body: body(true) },
        { label: `Configure (agent.codeSearch: ${ix.name})`, disabled: true, body: body(false) },
      ],
      copyDisabled: false,
      busy: false,
    };
  } else if (!ix.index || ix.indexed) {
    // An existing index (or one that is not required) can be selected directly; rebuilding is optional.
    view = {
      badges,
      copyText: null,
      copyInstructions: null,
      actions: [
        { label: `Use ${ix.name}`, disabled: false, body: body(false) },
        { label: 'Rebuild Index', disabled: !ix.canBuild, body: body(true) },
      ],
      copyDisabled: false,
      busy: false,
    };
  } else if (ix.canBuild) {
    view = {
      badges,
      copyText: null,
      copyInstructions: null,
      actions: [{ label: 'Build Index', disabled: false, body: body(true) }],
      copyDisabled: false,
      busy: false,
    };
  } else {
    // Installed and unindexed, but the build is a human instruction: configure only after a refresh finds the index.
    view = {
      badges,
      copyText: invocation(ix),
      copyInstructions: ix.build || null,
      actions: [
        { label: 'Build Index', disabled: true, body: body(true) },
        { label: `Configure (agent.codeSearch: ${ix.name})`, disabled: true, body: body(false) },
        { label: 'Refresh status', disabled: false, refresh: true },
      ],
      copyDisabled: false,
      busy: false,
    };
  }

  return busy
    ? { ...view, busy: true, copyDisabled: true, actions: view.actions.map(a => ({ ...a, disabled: true })) }
    : view;
}

/** The message and captured process output of a failed setup request. */
export function setupFailure(error: unknown): { error: string; output?: string } {
  const e = error as { message?: string; output?: string } | null;
  const message = e && typeof e.message === 'string' ? e.message : String(error);
  return { error: message, ...(e && typeof e.output === 'string' && e.output ? { output: e.output } : {}) };
}

const CODE_SEARCH = /code\s*(?:search|indexer)|indexer/i;

/** Only a failing code indexer check offers the setup action. */
export const doctorSetupAction = (check: { name?: string; ok?: boolean }): boolean =>
  Boolean(check && !check.ok && CODE_SEARCH.test(check.name || ''));

/** The checks a successful setup returned, applied to the Doctor immediately. */
export const configuredChecks = (result: unknown): Check[] => {
  const r = result as { ok?: boolean; checks?: Check[] } | null;
  return r && r.ok === true && Array.isArray(r.checks) ? r.checks : [];
};

/** A Settings warning refers to code search when it names code search or an indexer. */
export const isCodeSearchWarning = (warning: string): boolean => CODE_SEARCH.test(warning || '');

/** The header action is always available; the inline one only appears in a matching warning banner. */
export const settingsSetupActions = (warnings: string[]): { header: boolean; inline: boolean } => ({
  header: true,
  inline: (warnings || []).some(isCodeSearchWarning),
});
