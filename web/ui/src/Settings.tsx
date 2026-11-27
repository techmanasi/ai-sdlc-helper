// Settings: the run behaviour and appearance for this project, and the read-only view of what the settings resolve to.
import { useEffect, useState } from 'preact/hooks';
import { api, type RunBehaviourSettings, type RunBehaviourView } from './api';
import { CodeSearchModal } from './CodeSearchModal';
import { settingsSetupActions } from './codeSearchSetup';
import { Cli, CopyButton, ErrorBox, Future, Panel, useApp } from './ui';
import { envSetNote, RUN_ENV, secondsError, variableNameError } from './runBehaviour';
import { THEME_OPTIONS } from './theme';

/** The Light / Dark / System choice, kept in this browser and applied as data-theme on <html> (see theme.ts). */
function Appearance() {
  const { theme, setTheme } = useApp();
  return (
    <Panel title="Appearance" extra={<span class="small muted">this browser</span>}>
      <div class="pb col" style={{ gap: '8px' }}>
        <div class="segs" role="group" aria-label="Theme">
          {THEME_OPTIONS.map(t => (
            <button type="button" class={`seg ${theme === t ? 'seg-on' : ''}`} aria-pressed={theme === t} onClick={() => setTheme(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </div>
        <p class="small muted" style={{ margin: 0 }}>System follows your operating system's appearance.</p>
      </div>
    </Panel>
  );
}

/** The personal, per-project run behaviour (overrides.run): what the controls and pipeline read as environment variables. */
function RunBehaviour({ project }: { project: string }) {
  const { toast } = useApp();
  const [view, setView] = useState<RunBehaviourView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [allowMerged, setAllowMerged] = useState(false);
  const [retry, setRetry] = useState('');
  const [maxWait, setMaxWait] = useState('');
  const [vars, setVars] = useState<{ name: string; value: string }[]>([]);

  const load = (target: string) => {
    api.runBehaviour(target).then(v => {
      if (target !== project) return;
      setView(v);
      setAllowMerged(v.saved?.allowMerged === true);
      setRetry(v.saved?.limitRetry !== undefined ? String(v.saved.limitRetry) : '');
      setMaxWait(v.saved?.limitMaxWait !== undefined ? String(v.saved.limitMaxWait) : '');
      setVars(Object.entries(v.saved?.env || {}).map(([name, value]) => ({ name, value })));
    }).catch(e => { if (target === project) setError((e as Error).message); });
  };
  useEffect(() => { setError(''); load(project); }, [project]);

  if (!view) return error ? <ErrorBox error={error} /> : <p class="small muted">Loading…</p>;
  const envSet = view.envSet || {};
  const note = (name: string) => envSetNote(name, envSet);
  const allowEnv = note(RUN_ENV.allowMerged);
  const retryEnv = note(RUN_ENV.limitRetry);
  const maxWaitEnv = note(RUN_ENV.limitMaxWait);

  const setVar = (i: number, patch: Partial<{ name: string; value: string }>) => setVars(vars.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const save = async () => {
    setBusy(true); setError('');
    const errs: string[] = [];
    const re = secondsError(retry, 0, 'Retry limit'); if (re) errs.push(re);
    const me = secondsError(maxWait, 1, 'Max wait'); if (me) errs.push(me);
    const seen = new Set<string>();
    for (const v of vars) {
      const name = v.name.trim();
      if (!name) continue;
      const e = variableNameError(name);
      if (e) errs.push(`${name}: ${e}`);
      else if (seen.has(name)) errs.push(`${name}: used twice`);
      else seen.add(name);
    }
    if (errs.length) { setError(errs.join('\n')); setBusy(false); return; }
    const run: RunBehaviourSettings = {};
    if (allowMerged) run.allowMerged = true;
    if (retry.trim() !== '') run.limitRetry = Number(retry);
    if (maxWait.trim() !== '') run.limitMaxWait = Number(maxWait);
    const env: Record<string, string> = {};
    for (const v of vars) { const n = v.name.trim(); if (n) env[n] = v.value; }
    if (Object.keys(env).length) run.env = env;
    try {
      const r = await api.saveRunBehaviour(project, run);
      if (!r.ok) { setError((r.errors || []).join('\n')); setBusy(false); return; }
      toast('Run behaviour saved');
      await load(project);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <Panel title="Run behaviour" extra={<span class="small muted">this machine · this project</span>}>
      <form class="pb col" style={{ gap: '10px' }} onSubmit={e => { e.preventDefault(); save(); }}>
        <label class="row small" style={{ cursor: 'pointer', gap: '8px', alignItems: 'flex-start' }}>
          <input id="run-allow-merged" type="checkbox" checked={allowMerged} disabled={!!allowEnv} onChange={e => setAllowMerged((e.target as HTMLInputElement).checked)} />
          <span>Allow already merged branches<br /><span class="muted mono">SDLC_ALLOW_MERGED</span>{allowEnv && <span class="muted"> · {allowEnv}</span>}</span>
        </label>
        <div class="row" style={{ alignItems: 'flex-start', gap: '12px' }}>
          <label class="col small grow" style={{ gap: '4px' }}>
            <span>Retry limit <span class="muted mono">SDLC_LIMIT_RETRY</span>{retryEnv && <span class="muted"> · {retryEnv}</span>}</span>
            <input id="run-retry-limit" class="inp mono" type="number" min="0" step="1" placeholder="0 (off)" value={retry} disabled={!!retryEnv} onInput={e => setRetry((e.target as HTMLInputElement).value)} />
          </label>
          <label class="col small grow" style={{ gap: '4px' }}>
            <span>Max wait <span class="muted mono">SDLC_LIMIT_MAX_WAIT</span>{maxWaitEnv && <span class="muted"> · {maxWaitEnv}</span>}</span>
            <input id="run-max-wait" class="inp mono" type="number" min="1" step="1" placeholder="21600 (6 h)" value={maxWait} disabled={!!maxWaitEnv} onInput={e => setMaxWait((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <p class="small muted" style={{ margin: 0 }}>Retry limit is the seconds between retries after a usage limit; max wait is the seconds to keep retrying in all. Leave a field empty for the default.</p>
        <div class="col" style={{ gap: '6px' }}>
          <span class="lbl">Extra variables</span>
          {vars.map((v, i) => {
            const name = v.name.trim();
            const inEnv = note(name);
            const nameErr = variableNameError(name);
            return (
              <div class="col" style={{ gap: '2px' }}>
                <div class="row" style={{ gap: '8px', flexWrap: 'nowrap' }}>
                  <input class="inp mono" style={{ width: '180px' }} aria-label="Variable name" placeholder="NAME" value={v.name} onInput={e => setVar(i, { name: (e.target as HTMLInputElement).value })} />
                  <input class="inp mono grow" aria-label="Variable value" placeholder="value" value={v.value} onInput={e => setVar(i, { value: (e.target as HTMLInputElement).value })} />
                  <button class="btn btn-s" type="button" aria-label={`Remove variable ${name || i + 1}`} onClick={() => setVars(vars.filter((_, j) => j !== i))}>✕</button>
                </div>
                {(inEnv || nameErr) && <span class={`small ${nameErr ? 's-failed' : 'muted'}`}>{nameErr || inEnv}</span>}
              </div>
            );
          })}
          <div class="row"><button class="btn btn-s" type="button" onClick={() => setVars([...vars, { name: '', value: '' }])}>Add variable</button></div>
        </div>
        <ErrorBox error={error} />
        <div class="row">
          <button class="btn btn-p" type="submit" disabled={busy || !view.registered}>{busy ? 'Saving…' : 'Save run behaviour'}</button>
          {!view.registered && <span class="small muted">Register this project to save personal settings.</span>}
        </div>
      </form>
    </Panel>
  );
}

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
              <RunBehaviour project={project} />
              <Panel title="Resolved settings" extra={<span class="small muted">sdlc.config.json, then detection, then defaults</span>}>
                <pre class="code mono" style={{ borderRadius: '0 0 8px 8px' }}>{JSON.stringify(data.config, null, 2)}</pre>
              </Panel>
            </div>
            <div class="side col">
              <Appearance />
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
