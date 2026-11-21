// Settings: what the settings resolve to, the file itself, and the code indexer setup entry points.
import { useEffect, useState } from 'preact/hooks';
import { api } from './api';
import { CodeSearchModal } from './CodeSearchModal';
import { settingsSetupActions } from './codeSearchSetup';
import { Cli, CopyButton, ErrorBox, Future, Panel, useApp } from './ui';

export function Settings() {
  const { project } = useApp();
  const [data, setData] = useState<{ config: unknown; errors: string[]; warnings: string[]; raw: string | null } | null>(null);
  const [error, setError] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const load = (target: string) => {
    setData(null);
    api.settings(target).then(r => { if (target === project) setData(r); }).catch(e => { if (target === project) setError((e as Error).message); });
  };
  useEffect(() => { setError(''); load(project); }, [project]);
  const actions = settingsSetupActions(data?.warnings || []);

  return (
    <div class="col">
      <div class="row">
        <h1 class="grow">Settings</h1>
        <button class="btn" type="button" onClick={() => setSetupOpen(true)}>Code Search</button>
        <button class="btn btn-p" type="button" disabled title="Editing settings comes in phase 2">Edit settings <Future id="phase 2" /></button>
        <button class="btn" type="button" disabled title="Waits on engine request E-1">Edit prompts <Future id="E-1" /></button>
      </div>
      <ErrorBox error={error} />
      {!data && !error && <p class="muted">Loading…</p>}
      {data && (
        <>
          {data.errors.length > 0 && <div class="error">{data.errors.join('\n')}</div>}
          {data.warnings.length > 0 && (
            <div class="banner">
              {data.warnings.join('\n')}
              {actions.inline && <div style={{ paddingTop: '8px' }}><button class="btn btn-s indexer-action" type="button" onClick={() => setSetupOpen(true)}>Setup Code Indexer</button></div>}
            </div>
          )}
          <div class="split">
            <div class="wide col">
              <Panel title="Resolved settings" extra={<span class="small muted">sdlc.config.json, then detection, then defaults</span>}>
                <pre class="code mono" style={{ borderRadius: '0 0 8px 8px' }}>{JSON.stringify(data.config, null, 2)}</pre>
              </Panel>
            </div>
            <div class="side col">
              <Panel title={<span class="mono">sdlc.config.json</span>} extra={data.raw !== null ? <CopyButton text={data.raw} /> : undefined}>
                <pre class="code mono" style={{ borderRadius: '0 0 8px 8px' }}>{data.raw ?? 'No sdlc.config.json: everything comes from detection and defaults.'}</pre>
              </Panel>
              <Cli args={['show']} />
            </div>
          </div>
        </>
      )}
      <CodeSearchModal project={project} open={setupOpen} onClose={() => setSetupOpen(false)} onConfigured={() => load(project)} />
    </div>
  );
}
