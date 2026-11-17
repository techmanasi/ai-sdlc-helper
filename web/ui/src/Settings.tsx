// Settings, read-only in phase 1 apart from Setup Code Indexer: what the settings resolve to and the file itself. Editing
// them (and the prompts) comes in phase 2; the command palette can already run `code-search --use`, `init-tests` and the rest.
import { useEffect, useState } from 'preact/hooks';
import { api } from './api';
import { CodeIndexerSetup } from './CodeIndexerSetup';
import { settingsSetupAction } from './codeIndexerState';
import { Cli, CopyButton, ErrorBox, Future, Panel, useApp } from './ui';

export function Settings() {
  const { project } = useApp();
  const [data, setData] = useState<{ config: unknown; errors: string[]; warnings: string[]; raw: string | null } | null>(null);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState(false);
  const load = () => { setData(null); api.settings(project).then(setData).catch(e => setError((e as Error).message)); };
  useEffect(load, [project]);
  const setupAction = settingsSetupAction('auto');

  return (
    <div class="col">
      <div class="row">
        <h1 class="grow">Settings</h1>
        {setupAction.available && <button class="btn" type="button" onClick={() => setSetup(true)}>{setupAction.label}</button>}
        <button class="btn btn-p" type="button" disabled title="Editing settings comes in phase 2">Edit settings <Future id="phase 2" /></button>
        <button class="btn" type="button" disabled title="Waits on engine request E-1">Edit prompts <Future id="E-1" /></button>
      </div>
      {setup && <CodeIndexerSetup project={project} onClose={changed => { setSetup(false); if (changed) load(); }} />}
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
              <Panel title={<span class="mono">sdlc.config.json</span>} extra={data.raw !== null ? <CopyButton text={data.raw} /> : undefined}>
                <pre class="code mono" style={{ borderRadius: '0 0 8px 8px' }}>{data.raw ?? 'No sdlc.config.json: everything comes from detection and defaults.'}</pre>
              </Panel>
              <Cli args={['show']} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
