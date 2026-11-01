// The registered projects (and the folder ui started in), their doctor checks, and adding one.
import { useEffect, useState } from 'preact/hooks';
import { api, type Check, type Project, type SettingsView, type Source } from './api';
import { Cli, ErrorBox, useApp } from './ui';

function Doctor({ name }: { name: string }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState('');
  const run = () => { setChecks(null); setError(''); api.doctor(name).then(r => setChecks(r.checks)).catch(e => setError((e as Error).message)); };
  useEffect(run, [name]);
  if (error) return <ErrorBox error={error} />;
  if (!checks) return <p class="small muted">Checking…</p>;
  const failed = checks.filter(c => !c.ok && c.required).length;
  return (
    <div class="col" style={{ gap: '0' }}>
      <span class={`small ${failed ? 's-failed' : 's-done'}`} style={{ paddingBottom: '6px' }}>{failed ? `✘ ${failed} required check${failed > 1 ? 's' : ''} failing` : '✔ ready'}</span>
      {checks.map(c => (
        <div style={{ display: 'grid', gridTemplateColumns: '22px minmax(0,1fr)', gap: '2px 8px', padding: '7px 0', borderTop: '1px solid var(--ln)', fontSize: '13px' }}>
          <span class={c.ok ? 's-done' : c.required ? 's-failed' : 's-paused'}>{c.ok ? '✔' : c.required ? '✘' : '!'}</span>
          <span><strong>{c.name}</strong> · {c.detail}{!c.ok && c.fix && <><br /><span class="muted">Fix: {c.fix}</span></>}</span>
        </div>
      ))}
      <div class="row" style={{ paddingTop: '10px' }}><button class="btn btn-s" type="button" onClick={run}>Run doctor again</button></div>
    </div>
  );
}

/** One agent / model / effort triple: '' in a field means "not set here" (the project's, or the stage default, applies). */
interface Pick { harness: string; model: string; effort: string }
const NONE: Pick = { harness: '', model: '', effort: '' };
type Scope = 'project' | 'personal';
type RowSources = { harness?: Source; model?: Source; effort?: Source };
const FIELD_NAMES = ['harness', 'model', 'effort'] as const;
const LABEL: Record<(typeof FIELD_NAMES)[number], string> = { harness: 'agent', model: 'model', effort: 'effort' };

const NAME_OF: Record<Source | 'built-in', string> = { personal: 'personal', project: 'project file', 'built-in': 'built-in default' };

/**
 * Where each of a row's settings is loaded from, grouped: "agent, model: project file · effort: built-in default". A stage's own
 * setting wins; otherwise it uses the project default's (the model and effort only when it runs the same agent); otherwise the built-in.
 */
function Origin({ own, def, same, files }: { own: RowSources; def?: RowSources; same?: boolean; files: SettingsView['files'] }) {
  const origin = (f: (typeof FIELD_NAMES)[number]): Source | 'built-in' => own[f] || (def && (f === 'harness' || same) ? def[f] : undefined) || 'built-in';
  const groups = new Map<Source | 'built-in', string[]>();
  for (const f of FIELD_NAMES) groups.set(origin(f), [...(groups.get(origin(f)) || []), LABEL[f]]);
  const text = [...groups].map(([o, names]) => `${names.join(', ')}: ${NAME_OF[o]}`).join(' · ');
  const title = [...groups.keys()].map(o => (o === 'personal' ? `personal = ${files.personal}` : o === 'project' ? `project file = ${files.project}` : 'built-in default: nothing set')).join('\n');
  return <span class="small muted" style={{ lineHeight: 1.3 }} title={title}>{text}</span>;
}

/** The three pickers of one row. The model list follows the agent; the effort shows only for models that take one. */
function Pickers({ id, pick, set, data, harness, inherit }: {
  id: string; pick: Pick; set(p: Pick): void; data: SettingsView; harness: string; inherit: { agent: string; model: string; effort: string };
}) {
  const models = data.models[harness] || [];
  const shownModel = pick.model || inherit.model;
  const info = models.find(m => m.id === shownModel);
  const takesEffort = !info || info.supportsEffort;
  const change = (patch: Partial<Pick>) => set({ ...pick, ...patch });
  return (
    <>
      <select id={`${id}-h`} class="inp mono" aria-label="agent" value={pick.harness} onChange={e => {
        const h = (e.target as HTMLSelectElement).value || inherit.agent;
        // a model picked for the old agent may not exist on the new one
        const keep = (data.models[h] || []).some(m => m.id === pick.model);
        change({ harness: (e.target as HTMLSelectElement).value, ...(keep ? {} : { model: '', effort: '' }) });
      }}>
        <option value="">{inherit.agent ? `default (${inherit.agent})` : 'choose'}</option>
        {data.harnesses.map(h => <option value={h}>{h}</option>)}
      </select>
      <select id={`${id}-m`} class="inp mono" aria-label="model" value={pick.model} onChange={e => change({ model: (e.target as HTMLSelectElement).value })}>
        <option value="">{inherit.model ? `default (${inherit.model})` : 'default'}</option>
        {models.map(m => <option value={m.id}>{m.id}</option>)}
        {pick.model && !models.some(m => m.id === pick.model) && <option value={pick.model}>{pick.model}</option>}
      </select>
      {takesEffort
        ? (
          <select id={`${id}-e`} class="inp mono" aria-label="effort" value={pick.effort} onChange={e => change({ effort: (e.target as HTMLSelectElement).value })}>
            <option value="">{inherit.effort ? `default (${inherit.effort})` : 'default'}</option>
            {data.efforts.map(x => <option value={x}>{x}</option>)}
          </select>
        )
        : <span class="small muted">no effort</span>}
    </>
  );
}

/**
 * Edit a project's setup after it was added: the default agent, model and effort, the same per stage, and the personal
 * overrides. Agent settings are saved either for everyone (sdlc.config.json, committed) or only for this user (the registry).
 */
function EditSetup({ name, onSaved }: { name: string; onSaved(): void }) {
  const { toast } = useApp();
  const [data, setData] = useState<SettingsView | null>(null);
  const [scope, setScope] = useState<Scope>('project');
  const [def, setDef] = useState<Pick>({ harness: 'claude', model: '', effort: '' });
  const [stages, setStages] = useState<Record<string, Pick>>({});
  const [base, setBase] = useState('');
  const [parallel, setParallel] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [warn, setWarn] = useState('');
  const [busy, setBusy] = useState(false);

  /** The form values of a scope: the file's own for everyone, what applies to this user (file plus personal) for only me. */
  const fill = (d: SettingsView, sc: Scope) => {
    const agent = sc === 'project' ? d.fileAgent : (d.config?.agent || d.fileAgent);
    setDef({ harness: agent.harness || 'claude', model: agent.model || '', effort: agent.effort || '' });
    setStages(Object.fromEntries(d.stages.map(st => [st, { ...NONE, ...(agent.stages?.[st] || {}) }])));
  };
  const load = (sc: Scope) => api.settings(name).then(d => {
    setData(d);
    fill(d, sc);
    setBase(d.overrides.worktreeBase || '');
    setParallel(d.overrides.maxParallel ? String(d.overrides.maxParallel) : '');
  }).catch(e => setErrors([(e as Error).message]));
  useEffect(() => { setData(null); load(scope); }, [name]);

  if (!data) return errors.length ? <ErrorBox error={errors.join('\n')} /> : <p class="small muted">Loading…</p>;

  const switchTo = (sc: Scope) => { setScope(sc); setErrors([]); setWarn(''); fill(data, sc); };
  const personalKeys = Object.keys(data.personalAgent);

  const save = async () => {
    setBusy(true); setErrors([]); setWarn('');
    try {
      let activeRuns: string[] = [];
      if (scope === 'project') {
        // null removes a key, so a field set back to "default" leaves nothing in sdlc.config.json.
        const stagePatch: Record<string, Record<string, string | null>> = {};
        for (const st of data.stages) {
          const p = stages[st] || NONE;
          stagePatch[st] = { harness: p.harness || null, model: p.model || null, effort: p.effort || null };
        }
        const agent = { harness: !data.fileAgent.harness && def.harness === 'claude' ? null : def.harness, model: def.model || null, effort: def.effort || null, stages: stagePatch };
        const r = await api.editSettings(name, { agent }, data.hash);
        if (!r.ok) { setErrors(r.errors); setBusy(false); return; }
        activeRuns = r.activeRuns;
      } else {
        // Only what differs from the project file is personal; a field equal to the file's is not an override.
        const file = data.fileAgent;
        const diff = (v: string, f?: string) => (v && v !== (f || '') ? v : null);
        const stagePatch: Record<string, Record<string, string | null>> = {};
        for (const st of data.stages) {
          const p = stages[st] || NONE; const f = file.stages?.[st] || {};
          stagePatch[st] = { harness: diff(p.harness, f.harness), model: diff(p.model, f.model), effort: diff(p.effort, f.effort) };
        }
        const agent = { harness: diff(def.harness, file.harness || 'claude'), model: diff(def.model, file.model), effort: diff(def.effort, file.effort), stages: stagePatch };
        const o = await api.editOverrides(name, { agent });
        if (!o.ok) { setErrors(o.errors); setBusy(false); return; }
        activeRuns = data.activeRuns;
      }
      if (data.registered) {
        const o = await api.editOverrides(name, { worktreeBase: base.trim() || null, maxParallel: parallel.trim() ? Number(parallel) : null });
        if (!o.ok) { setErrors(o.errors); setBusy(false); return; }
      }
      if (activeRuns.length) setWarn(`Saved. ${activeRuns.join(', ')} ${activeRuns.length > 1 ? 'are' : 'is'} running or paused and keep${activeRuns.length > 1 ? '' : 's'} the old setup until restarted.`);
      else toast(scope === 'personal' ? 'Personal setup saved' : 'Setup saved');
      await load(scope); onSaved();
    } catch (e) { setErrors([(e as Error).message]); }
    setBusy(false);
  };

  const grid = { display: 'grid', gridTemplateColumns: 'auto repeat(3, minmax(0, 1fr)) minmax(120px, 170px)', gap: '4px 8px', alignItems: 'center' } as const;
  const defFile = data.fileAgent;
  // The file's view of itself: every setting it holds comes from the file. (The personal ones are named in the notice above.)
  const own = (a: { harness?: string; model?: string; effort?: string }): RowSources => Object.fromEntries(FIELD_NAMES.filter(f => a[f]).map(f => [f, 'project'])) as RowSources;
  const shown = scope === 'project'
    ? { top: own(defFile), stages: Object.fromEntries(data.stages.map(st => [st, own(defFile.stages?.[st] || {})])) }
    : { top: data.sources as RowSources, stages: data.sources.stages as Record<string, RowSources> };
  return (
    <form class="col" style={{ gap: '8px' }} onSubmit={e => { e.preventDefault(); save(); }}>
      <span class="lbl">Agent, model and effort</span>
      <div class="row" style={{ gap: '14px', flexWrap: 'wrap' }}>
        <label class="row small" style={{ gap: '6px', cursor: 'pointer' }}>
          <input type="radio" name={`scope-${name}`} checked={scope === 'project'} onChange={() => switchTo('project')} />
          <span>Save for everyone <span class="mono muted">sdlc.config.json</span></span>
        </label>
        <label class="row small" style={{ gap: '6px', cursor: 'pointer' }}>
          <input type="radio" name={`scope-${name}`} checked={scope === 'personal'} disabled={!data.registered} onChange={() => switchTo('personal')} />
          <span>Only for me <span class="muted">(this machine, overrides the project file)</span></span>
        </label>
      </div>
      {scope === 'project' && personalKeys.length > 0 && (
        <div class="banner">Your personal settings for this project ({personalKeys.join(', ')}) still win on this machine over what you save here. Switch to "Only for me" to change them.</div>
      )}
      <div style={grid}>
        <span class="small muted" />
        <span class="small muted">agent</span><span class="small muted">model</span><span class="small muted">effort</span><span class="small muted">from</span>
        <label class="mono small" for="def-h">project default</label>
        <select id="def-h" class="inp mono" aria-label="agent" value={def.harness} onChange={e => {
          const h = (e.target as HTMLSelectElement).value;
          const keep = (data.models[h] || []).some(m => m.id === def.model);
          setDef({ harness: h, model: keep ? def.model : '', effort: keep ? def.effort : '' });
        }}>
          {data.harnesses.map(h => <option value={h}>{h}</option>)}
        </select>
        <select id="def-m" class="inp mono" aria-label="model" value={def.model} onChange={e => setDef({ ...def, model: (e.target as HTMLSelectElement).value })}>
          <option value="">{scope === 'personal' && defFile.model && def.harness === (defFile.harness || 'claude') ? `project file (${defFile.model})` : 'per-stage default'}</option>
          {(data.models[def.harness] || []).map(m => <option value={m.id}>{m.id}</option>)}
        </select>
        {(data.models[def.harness] || []).find(m => m.id === def.model)?.supportsEffort === false
          ? <span class="small muted">no effort</span>
          : (
            <select id="def-e" class="inp mono" aria-label="effort" value={def.effort} onChange={e => setDef({ ...def, effort: (e.target as HTMLSelectElement).value })}>
              <option value="">{scope === 'personal' && defFile.effort && def.harness === (defFile.harness || 'claude') ? `project file (${defFile.effort})` : 'per-stage default'}</option>
              {data.efforts.map(x => <option value={x}>{x}</option>)}
            </select>
          )}
        <Origin own={shown.top} files={data.files} />
        {data.stages.map(st => {
          const pick = stages[st] || NONE;
          const harness = pick.harness || def.harness;
          const same = harness === def.harness;
          const dflt = data.stageDefaults[st];
          return (
            <>
              <label class="mono small" for={`s-${st}-h`}>{st}</label>
              <Pickers id={`s-${st}`} pick={pick} data={data} harness={harness}
                set={p => setStages({ ...stages, [st]: p })}
                inherit={{ agent: def.harness, model: (same && def.model) || dflt.model, effort: (same && def.effort) || dflt.effort }} />
              <Origin own={shown.stages[st] || {}} def={shown.top} same={same} files={data.files} />
            </>
          );
        })}
      </div>
      <p class="small muted mono" style={{ margin: 0, overflowWrap: 'anywhere' }}>
        project = {data.files.project} (committed) · personal = {data.files.personal} (this machine only)
      </p>
      {data.registered && (
        <>
          <label class="lbl" for={`wb-${name}`}>Worktree folder (personal, this machine only)</label>
          <input id={`wb-${name}`} class="inp mono" value={base} placeholder="../{repo}-sdlc" onInput={e => setBase((e.target as HTMLInputElement).value)} />
          <label class="lbl" for={`mp-${name}`}>Runs in parallel (personal)</label>
          <input id={`mp-${name}`} class="inp mono" type="number" min="1" value={parallel} onInput={e => setParallel((e.target as HTMLInputElement).value)} />
        </>
      )}
      <p class="small muted" style={{ margin: 0 }}>
        Used by runs started after saving. A run's own <span class="mono">--agent</span>, <span class="mono">--model</span> and <span class="mono">--effort</span> win over all of it.
        Out of quota on one agent? Switch it only for you, or for one stage, here.
      </p>
      {warn && <div class="banner">{warn}</div>}
      <ErrorBox error={errors.join('\n')} />
      <div class="row"><button class="btn btn-p" type="submit" disabled={busy}>{busy ? 'Saving…' : scope === 'personal' ? 'Save for me' : 'Save setup'}</button></div>
    </form>
  );
}

export function Projects({ projects, reload }: { projects: Project[]; reload(): void }) {
  const { project, go, toast } = useApp();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [out, setOut] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [rev, setRev] = useState(0);

  const add = async (dir: string, n?: string) => {
    setBusy(true); setError(''); setOut('');
    try {
      const r = await api.addProject(dir, n || undefined);
      setOut([...r.out, ...r.err].join('\n'));
      if (r.ok) { toast(`Registered ${dir}`); reload(); }
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div class="col">
      <div class="row"><h1 class="grow">Projects</h1><span class="mono small muted">~/.config/ai-sdlc-helper/projects.json</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px' }}>
        {projects.map(p => (
          <section class="pn" style={p.name === project ? { borderColor: 'var(--pri)' } : {}}>
            <div class="ph">
              <h2 class="mono">{p.name} {p.name === project && <span class="tag">current</span>} {!p.registered && <span class="tag s-paused">not registered</span>}</h2>
              <div class="row">
                <button class="btn btn-s" type="button" onClick={() => setEditing(editing === p.name ? null : p.name)}>{editing === p.name ? 'Close' : 'Edit setup'}</button>
                {p.name !== project && <button class="btn btn-s" type="button" onClick={() => go(`/board?project=${encodeURIComponent(p.name)}`)}>Open</button>}
                {!p.registered && <button class="btn btn-s btn-p" type="button" disabled={busy} onClick={() => add(p.path)}>Register</button>}
              </div>
            </div>
            <div class="pb col" style={{ gap: '8px' }}>
              <span class="mono small muted" style={{ overflowWrap: 'anywhere' }}>{p.path}</span>
              {editing === p.name && <EditSetup name={p.name} onSaved={() => { setRev(rev + 1); reload(); }} />}
              <Doctor key={`${p.name}-${rev}`} name={p.name} />
            </div>
          </section>
        ))}
        <section class="pn" style={{ borderStyle: 'dashed' }}>
          <div class="ph"><h2>Add a project</h2></div>
          <form class="pb col" style={{ gap: '8px' }} onSubmit={e => { e.preventDefault(); add(path, name); }}>
            <label class="lbl" for="pp">Folder (any path inside a git repository)</label>
            <input id="pp" class="inp mono" value={path} placeholder="/home/me/code/storefront" onInput={e => setPath((e.target as HTMLInputElement).value)} />
            <label class="lbl" for="pnm">Name (optional)</label>
            <input id="pnm" class="inp mono" value={name} onInput={e => setName((e.target as HTMLInputElement).value)} />
            <p class="small muted" style={{ margin: 0 }}>Registers it and writes sdlc.config.json and a backlog index when they are missing, as <span class="mono">add --yes</span> does.</p>
            <div class="row"><button class="btn btn-p" type="submit" disabled={busy || !path.trim()}>{busy ? 'Adding…' : 'Add project'}</button></div>
            <Cli args={['add', path || '<folder>', '--yes', ...(name ? ['--name', name] : [])]} />
            <ErrorBox error={error} />
            {out && <pre class="code mono" style={{ borderRadius: '6px' }}>{out}</pre>}
          </form>
        </section>
      </div>
    </div>
  );
}
