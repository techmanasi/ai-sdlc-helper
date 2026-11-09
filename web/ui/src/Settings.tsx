// Resolved settings, source file, and code search setup.
import { useEffect, useState } from 'preact/hooks';
import { api, type CodeSearchView } from './api';
import { Cli, CopyButton, ErrorBox, Future, Panel, useApp } from './ui';
import { CodeSearchModal } from './CodeSearchModal';

export function Settings() {
  const { project } = useApp();
  const [data, setData] = useState<{ config: unknown; errors: string[]; warnings: string[]; raw: string | null } | null>(null);
  const [search, setSearch] = useState<CodeSearchView | null>(null);
  const [setup, setSetup] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [error, setError] = useState('');
  const load = () => {
    api.settings(project).then(settings => { setData(settings); setError(''); }).catch(e => setError((e as Error).message));
    api.codeSearch(project).then(setSearch).catch(e => setSearchError((e as Error).message));
  };
  useEffect(() => { setData(null); setSearch(null); setSearchError(''); load(); }, [project]);
  const configured = search?.indexers.find(ix => ix.name === search.setting);
  const needsSetup = search?.effective === 'none' && Boolean(search.warning) || Boolean(configured && (!configured.installed || !configured.indexed));

  return (
    <div class="col">
      <div class="row">
        <h1 class="grow">Settings</h1>
        <button class="btn btn-p" type="button" disabled title="Editing settings comes in phase 2">Edit settings <Future id="phase 2" /></button>
        <button class="btn" type="button" disabled title="Waits on engine request E-1">Edit prompts <Future id="E-1" /></button>
      </div>
      <ErrorBox error={error} />
      {!data && !error && <p class="muted">Loading…</p>}
      {data && (
        <>
          {data.errors.length > 0 && <div class="error">{data.errors.join('\n')}</div>}
          {data.warnings.length > 0 && <div class="banner">{data.warnings.join('\n')}</div>}
          <div class="split">
            <div class="wide col">
              <Panel title="Resolved settings" extra={<span class="small muted">sdlc.config.json, then detection, then defaults</span>}>
                <pre class="code mono" style={{ borderRadius: '0 0 8px 8px' }}>{JSON.stringify(data.config, null, 2)}</pre>
              </Panel>
            </div>
            <div class="side col">
              <Panel title="Code Search">
                <div class="pb col">
                  {search ? <>
                    <p>Setting: <strong>{search.setting}</strong></p>
                    <p>In use: <strong>{search.effective === 'none' ? 'none (Grep and Glob)' : search.effective}</strong></p>
                    {search.warning && <div class="banner">{search.warning}</div>}
                    <button class={`btn ${needsSetup ? 'btn-p' : ''}`} type="button" onClick={() => setSetup(true)}>{needsSetup ? 'Setup Code Indexer' : 'Configure Code Indexer'}</button>
                  </> : searchError ? <ErrorBox error={searchError} /> : <p class="muted">Loading code search…</p>}
                </div>
              </Panel>
              <Panel title={<span class="mono">sdlc.config.json</span>} extra={data.raw !== null ? <CopyButton text={data.raw} /> : undefined}>
                <pre class="code mono" style={{ borderRadius: '0 0 8px 8px' }}>{data.raw ?? 'No sdlc.config.json: everything comes from detection and defaults.'}</pre>
              </Panel>
              <Cli args={['show']} />
            </div>
          </div>
        </>
      )}
      {setup && <CodeSearchModal project={project} onChanged={load} onClose={() => setSetup(false)} />}
    </div>
  );
}
