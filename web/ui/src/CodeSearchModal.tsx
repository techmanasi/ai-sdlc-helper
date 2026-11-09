import { useEffect, useState } from 'preact/hooks';
import { api, type CodeSearchSetupResult, type CodeSearchView } from './api';
import { CopyButton, ErrorBox, Spinner } from './ui';

export function CodeSearchModal({ project, onClose, onChanged }: { project: string; onClose(): void; onChanged(): void }) {
  const [view, setView] = useState<CodeSearchView | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<CodeSearchSetupResult | null>(null);

  const refresh = () => api.codeSearch(project).then(next => {
    setView(next);
    setSelected(current => next.indexers.some(ix => ix.name === current) || current === 'auto' || current === 'none' ? current : next.setting);
    setError('');
  }).catch(e => setError((e as Error).message));
  useEffect(() => { refresh(); }, [project]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);

  const [building, setBuilding] = useState(false);
  const submit = async (build: boolean) => {
    setBusy(true); setBuilding(build); setError(''); setResult(null);
    try {
      const response = await api.codeSearchSetup(project, { indexer: selected, build });
      if (!response.ok) { setError(response.error || 'Could not set up code search'); setResult(response); }
      else { onChanged(); onClose(); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setBuilding(false); }
  };
  const ix = view?.indexers.find(item => item.name === selected);
  const install = ix?.setup?.split(/, then | then /)[0] || '';
  const output = result?.buildOutput?.stderr || result?.buildOutput?.stdout;
  return (
    <div class="overlay" onClick={() => { if (!busy) onClose(); }}>
      <section class="dialog" role="dialog" aria-modal="true" aria-label="Code Search Indexer" onClick={e => e.stopPropagation()}>
        <div class="ph"><h2>Code Search Indexer</h2><button class="btn btn-s" type="button" disabled={busy} onClick={onClose}>Close</button></div>
        <div class="pb col">
          <ErrorBox error={error} />
          {output && <pre class="code mono" style={{ maxHeight: '200px', overflow: 'auto' }}>{output}</pre>}
          {!view ? <p class="muted">Loading indexers…</p> : <>
            <div class="col" role="radiogroup" aria-label="Code search options">
              {[{ name: 'auto', label: 'Auto (first available)' }, { name: 'none', label: 'None (Grep and Glob)' }, ...view.indexers.map(item => ({ name: item.name, label: item.name }))].map(option => (
                <label class="row" key={option.name}>
                  <input type="radio" name="code-search-indexer" value={option.name} checked={selected === option.name} disabled={busy} onChange={() => { setSelected(option.name); setError(''); setResult(null); }} />
                  {option.label}
                </label>
              ))}
            </div>
            {ix ? <div class="col">
              <div class="row"><span class={ix.installed ? 's-done' : 's-failed'}>{ix.installed ? '✔ Installed on PATH' : '✘ Not installed on PATH'}</span><span class={ix.indexed ? 's-done' : 's-failed'}>{ix.indexed ? '✔ Indexed' : '✘ Unindexed'}</span></div>
              {!ix.installed && <><div class="banner">Install {ix.name} on the server host, then refresh its status.</div>{install && <div class="cli mono"><span>{install}</span><CopyButton text={install} /></div>}</>}
              {ix.installed && !ix.indexed && !ix.canBuild && <><p>Build this index interactively in Claude Code.</p><div class="cli mono"><span>{ix.build?.match(/\/graphify\s+\./)?.[0] || ix.build || 'See indexer instructions'}</span><CopyButton text={ix.build?.match(/\/graphify\s+\./)?.[0] || ix.build || ''} /></div></>}
              {ix.installed && ix.indexed && <div class="row"><button class="btn btn-p" type="button" disabled={busy} onClick={() => submit(false)}>Use Indexer</button>{ix.canBuild && <button class="btn" type="button" disabled={busy} onClick={() => submit(true)}>Rebuild Index</button>}</div>}
              {ix.installed && !ix.indexed && ix.canBuild && <button class="btn btn-p" type="button" disabled={busy} onClick={() => submit(true)}>Build Index</button>}
            </div> : <div class="col"><p>{selected === 'auto' ? 'Automatically use the first available indexed engine.' : 'Always use Grep and Glob without warnings.'}</p><button class="btn btn-p" type="button" disabled={busy} onClick={() => submit(false)}>Save Setting</button></div>}
            <div class="row"><button class="btn btn-s" type="button" disabled={busy} onClick={refresh}>Refresh</button>{busy && <span><Spinner /> {building ? 'Building index... (this may take a minute)' : 'Saving…'}</span>}</div>
          </>}
        </div>
      </section>
    </div>
  );
}
