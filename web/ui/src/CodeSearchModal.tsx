// The code indexer setup dialog: a fresh inspection on open, one card per indexer, and a single setup request whose
// result belongs to the view that opened it. The presentation decisions live in codeSearchSetup.ts.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type CodeSearchSetupResponse, type CodeSearchStatusResponse } from './api';
import { dialogKey, firstFocusable, focusable } from './dialog';
import { wrappers } from './dialogDom';
import { indexerPresentation, setupFailure, type SetupAction } from './codeSearchSetup';
import { CopyButton, ErrorBox, useApp } from './ui';

export interface CodeSearchModalProps {
  project: string;
  open: boolean;
  onClose(): void;
  onConfigured(result: CodeSearchSetupResponse): void;
  /** Focus target when the opening button has gone (a failing Doctor row that just turned green). */
  focusFallback?(): HTMLElement | null;
}

interface Failure { error: string; output?: string }

export function CodeSearchModal({ project, open, onClose, onConfigured, focusFallback }: CodeSearchModalProps) {
  const { toast } = useApp();
  const overlay = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const openRef = useRef(open);
  const fallbackRef = useRef(focusFallback);
  const requestId = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const [status, setStatus] = useState<CodeSearchStatusResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [output, setOutput] = useState('');
  const [rev, setRev] = useState(0);
  openRef.current = open;
  fallbackRef.current = focusFallback;

  useEffect(() => {
    if (!open) return;
    const id = ++requestId.current;
    setStatus(null); setLoadError(''); setFailure(null); setOutput('');
    api.codeSearch(project).then(r => { if (id === requestId.current) setStatus(r); })
      .catch(e => { if (id === requestId.current) setLoadError((e as Error).message); });
  }, [open, project, rev]);

  useEffect(() => {
    if (open && !wasOpen.current) {
      opener.current = document.activeElement as HTMLElement | null;
      firstFocusable(wrappers(overlay.current))?.el.focus();
    } else if (!open && wasOpen.current) {
      const target = opener.current && opener.current.isConnected ? opener.current : fallbackRef.current?.();
      target?.focus();
      opener.current = null;
    }
    wasOpen.current = open;
  }, [open]);

  const submit = (action: SetupAction) => {
    if (busy || pending.current || !action.body) return;
    const body = action.body;
    pending.current = (async () => {
      setBusy(true); setFailure(null); setOutput('');
      try {
        const result = await api.setupCodeSearch(project, body);
        toast(`Code search set to ${result.codeSearch}`);
        onConfigured(result);
        if (openRef.current) onClose();
      } catch (e) {
        if (openRef.current) {
          const f = setupFailure(e);
          setFailure(f); setOutput(f.output || '');
        }
      } finally {
        setBusy(false);
        pending.current = null;
      }
    })();
  };

  if (!open) return null;

  return (
    <div
      class="overlay code-search-overlay" role="dialog" aria-modal="true" aria-label="Code Search Setup"
      ref={overlay} tabIndex={-1}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={e => {
        const items = focusable(wrappers(overlay.current)).map(w => w.el);
        const a = dialogKey(e, items, document.activeElement as HTMLElement | null);
        if (a.kind === 'close') onClose();
        else if (a.kind === 'focus') { e.preventDefault(); a.target.focus(); }
        else if (a.kind === 'prevent') e.preventDefault();
      }}
    >
      <section class="pn dialog dialog-wide code-search-dialog">
        <div class="ph"><h2 class="mono">Code Search Setup · {project}</h2><button class="btn btn-s" type="button" onClick={onClose}>Close</button></div>
        <div class="pb col" style={{ gap: '12px' }}>
          <ErrorBox error={loadError} />
          {!status && !loadError && <p class="small muted">Checking code search…</p>}
          {status && (
            <>
              <p class="small" style={{ margin: 0 }}>
                Configured: <span class="mono">{status.setting}</span> · Effective: <span class="mono">{status.current}</span>
              </p>
              {status.indexers.map(ix => {
                const view = indexerPresentation(ix, busy);
                return (
                  <section class="pn indexer-card" key={ix.name}>
                    <div class="ph">
                      <h3 class="mono">{ix.name}</h3>
                      <span class="row indexer-status" style={{ gap: '6px' }}>
                        {view.badges.map(b => <span class="tag" key={b}>{b}</span>)}
                        {status.setting === ix.name && <span class="tag s-done">Current</span>}
                      </span>
                    </div>
                    <div class="pb col" style={{ gap: '8px' }}>
                      {ix.command && <span class="small muted">Command: <span class="mono">{ix.command}</span>{ix.index && <> · Index: <span class="mono">{ix.index}</span></>}</span>}
                      {view.copyText && (
                        <div class="row" style={{ gap: '8px' }}>
                          <code class="mono">{view.copyText}</code>
                          <CopyButton text={view.copyText} disabled={view.copyDisabled} />
                        </div>
                      )}
                      {view.copyInstructions && <p class="small muted" style={{ margin: 0 }}>{view.copyInstructions}</p>}
                      <div class="row indexer-actions" style={{ gap: '8px', flexWrap: 'wrap' }}>
                        {view.actions.map(a => (
                          <button
                            class={`btn btn-s indexer-action ${a.refresh ? '' : 'btn-p'}`}
                            type="button"
                            key={a.label}
                            disabled={a.disabled}
                            onClick={() => {
                              if (a.refresh) setRev(rev + 1);
                              else submit(a);
                            }}
                          >{a.label}</button>
                        ))}
                      </div>
                    </div>
                  </section>
                );
              })}
            </>
          )}
          {busy && <p class="small cs-busy" role="status" aria-live="polite">Building index…</p>}
          {failure && (
            <>
              <ErrorBox error={failure.error} />
              {output && <pre class="code mono build-output">{output}</pre>}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
