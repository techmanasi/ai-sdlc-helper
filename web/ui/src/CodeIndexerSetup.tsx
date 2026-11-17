// The Setup Code Indexer dialog: pick graft or graphify, build its index here, and follow the build until it ends.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type CodeSearchView } from './api';
import { ErrorBox } from './ui';

const POLL_MS = 1000;

export function CodeIndexerSetup({ project, onClose }: { project: string; onClose: (changed: boolean) => void }) {
  const [view, setView] = useState<CodeSearchView | null>(null);
  const [picked, setPicked] = useState('');
  const [error, setError] = useState('');
  const [changed, setChanged] = useState(false);
  const wasRunning = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);

  const load = () => api.codeSearch(project).then(v => {
    setView(v);
    setPicked(current => current || (v.indexers.find(i => i.installed && i.runnable) || v.indexers[0] || { name: '' }).name);
    if (wasRunning.current && v.operation.status === 'succeeded') setChanged(true);
    wasRunning.current = v.operation.status === 'running';
  }).catch(e => setError((e as Error).message));
  useEffect(() => { load(); dialog.current?.focus(); }, [project]);

  const running = view?.operation.status === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [running, project]);

  const build = () => {
    setError('');
    wasRunning.current = true;
    api.setupCodeSearch(project, picked).then(load).catch(e => { wasRunning.current = false; setError((e as Error).message); load(); });
  };
  const close = () => onClose(changed);

  const choice = view?.indexers.find(i => i.name === picked);
  const op = view?.operation;
  const finished = op && op.status !== 'idle' && op.status !== 'running';
  return (
    <div
      class="overlay" role="dialog" aria-modal="true" aria-label="Setup Code Indexer" ref={dialog} tabIndex={-1}
      onClick={e => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={e => { if (e.key === 'Escape') close(); }}
    >
      <section class="pn dialog">
        <div class="ph"><h2>Setup Code Indexer</h2><button class="btn btn-s" type="button" onClick={close}>Close</button></div>
        <div class="pb col">
          <ErrorBox error={error} />
          {!view && !error && <p class="small muted">Loading…</p>}
          {view && (
            <>
              <p class="small muted">Now: {view.active.codeSearch === 'none' ? 'Grep and Glob' : view.active.codeSearch} (setting: {view.configured})</p>
              {view.indexers.map(i => (
                <label class="row" style={{ alignItems: 'flex-start', gap: '8px' }}>
                  <input type="radio" name="indexer" value={i.name} checked={picked === i.name} disabled={running} onChange={() => setPicked(i.name)} />
                  <span>
                    <strong class="mono">{i.name}</strong>
                    {' · '}{i.installed ? 'installed' : 'not installed'}{' · '}{i.indexed ? `indexed (${i.index})` : 'no index yet'}
                    {!i.installed && i.setup && <><br /><span class="muted">Install: {i.setup}</span></>}
                    {i.installed && !i.runnable && <><br /><span class="muted">Cannot be built here: {i.build || i.setup}</span></>}
                  </span>
                </label>
              ))}
              {running && <p class="small s-running">Building the {op?.indexer} index…</p>}
              {op?.status === 'succeeded' && <p class="small s-done">✔ The {op.indexer} index is built and agent.codeSearch is set to {op.indexer}.</p>}
              {finished && op.status !== 'succeeded' && <p class="small s-failed">✘ {op.error || 'The build did not finish.'}</p>}
              {op && op.output.length > 0 && <pre class="code mono" style={{ borderRadius: '6px', maxHeight: '240px', overflow: 'auto' }}>{op.output.join('\n')}</pre>}
              <div class="row">
                <button class="btn btn-p" type="button" onClick={build} disabled={running || !choice || !choice.installed || !choice.runnable}>
                  {choice && choice.indexed ? 'Rebuild index' : 'Build index'}
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
