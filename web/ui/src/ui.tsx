// Small pieces every screen uses: the CLI strip, state and Future tags, a Markdown preview, and the shared app context.
import { createContext } from 'preact';
import { useContext, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { cliLine, type ViewState } from './api';
import { parseMarkdown, type Inline } from './markdown';

export interface AppContext {
  project: string;
  go(route: string): void;
  toast(text: string): void;
}
export const Ctx = createContext<AppContext>({ project: '', go: () => {}, toast: () => {} });
export const useApp = () => useContext(Ctx);

export const GLYPH: Record<ViewState, string> = {
  'not started': '○', running: '●', paused: '⏸', done: '✔', failed: '✘', interrupted: '■', stopped: '✘', refused: '✘',
};
/** The pull-request mark (git-pull-request), shown for a finished run whose PR is not merged yet. */
export const PrIcon = ({ title = 'Pull request open' }: { title?: string }) => (
  <svg class="pr-icon" viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" role="img" aria-label={title}>
    <title>{title}</title>
    <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
  </svg>
);

export const stateClass = (s: ViewState) => `s-${s.replace(' ', '-')}`;

export const Spinner = ({ class: cls = '' }: { class?: string }) => <span class={`spinner ${cls}`.trim()} aria-hidden="true" />;

export function StateTag({ state }: { state: ViewState }) {
  return <span class={`tag ${stateClass(state)}`} style={{ borderColor: 'currentColor' }}>{state === 'running' ? <Spinner /> : GLYPH[state]} {state}</span>;
}

/** A control the engine cannot back yet: the request it waits on, from docs/web-ui.md. */
export const Future = ({ id }: { id: string }) => <span class="tag fut" title={`Waits on engine request ${id} (docs/web-ui.md)`}>Future · {id}</span>;

async function copy(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** The command (or commands, run one after the other) that does the same as the screen, with Copy. */
export function Cli({ args, commands }: { args?: string[]; commands?: string[][] }) {
  const [done, setDone] = useState(false);
  const line = `$ ${(commands || [args || []]).map(cliLine).join(' && ')}`;
  return (
    <div class="cli mono">
      <span style={{ overflowWrap: 'anywhere' }}>{line}</span>
      <button class="btn btn-s" type="button" onClick={async () => { setDone(await copy(line.slice(2))); setTimeout(() => setDone(false), 1500); }}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return <button class="btn btn-s" type="button" onClick={async () => { setDone(await copy(text)); setTimeout(() => setDone(false), 1500); }}>{done ? 'Copied' : label}</button>;
}

export function Panel({ title, extra, children }: { title: ComponentChildren; extra?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="pn">
      <div class="ph"><h2>{title}</h2>{extra}</div>
      {children}
    </section>
  );
}

export const ErrorBox = ({ error }: { error: string }) => (error ? <div class="error" role="alert">{error}</div> : null);

const renderInline = (items: Inline[]): ComponentChildren =>
  items.map(n => {
    switch (n.t) {
      case 'text': return n.text;
      case 'code': return <code>{n.text}</code>;
      case 'strong': return <strong>{renderInline(n.children)}</strong>;
      case 'em': return <em>{renderInline(n.children)}</em>;
      case 'link': return <a href={n.href} target="_blank" rel="noreferrer noopener">{renderInline(n.children)}</a>;
    }
  });

/** A Markdown preview built as elements from parsed data (nothing from the text runs as HTML). */
export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text).map((b): ComponentChildren => {
    switch (b.t) {
      case 'heading': { const H = `h${Math.min(b.level, 6)}` as 'h1'; return <H>{renderInline(b.inline)}</H>; }
      case 'para': return <p>{renderInline(b.inline)}</p>;
      case 'code': return <pre class="code mono">{b.text}</pre>;
      case 'list': { const L = b.ordered ? 'ol' : 'ul'; return <L>{b.items.map(i => <li>{renderInline(i)}</li>)}</L>; }
      case 'quote': return <blockquote>{renderInline(b.inline)}</blockquote>;
      case 'table': return (
        <div class="md-table"><table>
          <thead><tr>{b.head.map(c => <th>{renderInline(c)}</th>)}</tr></thead>
          <tbody>{b.rows.map(r => <tr>{r.map(c => <td>{renderInline(c)}</td>)}</tr>)}</tbody>
        </table></div>
      );
      case 'hr': return <hr />;
    }
  });
  return <div class="md">{blocks}</div>;
}
