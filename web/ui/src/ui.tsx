// Small pieces every screen uses: the CLI strip, state and Future tags, a Markdown preview, and the shared app context.
import { createContext } from 'preact';
import { useContext, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { cliLine, type ViewState } from './api';

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

/** A plain Markdown preview: headings, list items and paragraphs, as text (nothing from the file runs as HTML). */
export function Markdown({ text }: { text: string }) {
  const blocks: ComponentChildren[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) { blocks.push(<p>{para.join(' ')}</p>); para = []; }
    if (list.length) { blocks.push(<ul>{list.map(l => <li>{l}</li>)}</ul>); list = []; }
  };
  for (const line of text.split('\n')) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (h) { flush(); const H = (`h${h[1].length}`) as 'h1'; blocks.push(<H>{h[2]}</H>); } else if (li) { if (para.length) flush(); list.push(li[1]); } else if (!line.trim()) flush(); else { if (list.length) flush(); para.push(line.trim()); }
  }
  flush();
  return <div class="md">{blocks}</div>;
}
