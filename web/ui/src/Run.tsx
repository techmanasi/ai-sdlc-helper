// One run: its stages, the questions and refused actions it waits on, its environment, files and live output, and every
// control the engine has (start, resume, restart from a stage, stop, discard). An item with no run shows its brief.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, type RunView, type SettingsView } from './api';
import { Cli, CopyButton, ErrorBox, Future, GLYPH, Markdown, Panel, Spinner, StateTag, stateClass, useApp } from './ui';
import { buildDocTree, type DocTreeNode } from './tree';

const STAGES = [
  { name: 'Spec', key: 'spec' }, { name: 'Plan', key: 'plan' }, { name: 'Red tests', key: 'red-tests' },
  { name: 'Implement', key: 'implement' }, { name: 'Test repair', key: 'test-repair' }, { name: 'Review', key: 'review' },
  { name: 'Finalise', key: 'finalise' },
];
const MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const envKey = (kind: 'MODEL' | 'EFFORT', key: string) => `${kind}_${key.toUpperCase().replace(/-/g, '_')}`;
const AGENT_ENV = (key: string) => `AGENT_${key.toUpperCase().replace(/-/g, '_')}`;
const ENV_STORE = (project: string, slug: string) => `sdlc-env:${project}:${slug}`;

function loadEnv(project: string, slug: string): [string, string][] {
  try { const v = JSON.parse(localStorage.getItem(ENV_STORE(project, slug)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveEnv(project: string, slug: string, rows: [string, string][]): void {
  try { localStorage.setItem(ENV_STORE(project, slug), JSON.stringify(rows)); } catch { /* private window */ }
}

type StageState = 'done' | 'active' | 'paused' | 'failed' | 'pending';
function stageStates(v: RunView): StageState[] {
  const stageName = v.stage || (v.state === 'running' && v.record?.from ? (STAGES.find(s => s.key === v.record?.from)?.name || '') : '');
  const at = v.state === 'done' ? STAGES.length : Math.max(0, STAGES.findIndex(s => s.name === stageName || (s.name === 'Finalise' && (stageName === 'Finalise' || stageName === '6/6 Finalise' || stageName === 'Commit' || stageName === 'Ship'))));
  return STAGES.map((_, i) => {
    if (v.state === 'done' || i < at) return 'done';
    if (i > at || v.state === 'not started' || (!v.stage && !v.record?.from && v.state !== 'running')) return 'pending';
    if (v.state === 'running') return 'active';
    if (v.state === 'paused') return 'paused';
    return 'failed';
  });
}
const STAGE_GLYPH: Record<StageState, string> = { done: '✔', active: '●', paused: '⏸', failed: '✘', pending: '○' };
const STAGE_CLASS: Record<StageState, string> = { done: 's-done', active: 's-running', paused: 's-paused', failed: 's-failed', pending: 's-not-started' };

function DocTreeNodeView({
  node,
  openFile,
  openDirs,
  onToggleDir,
}: {
  node: DocTreeNode;
  openFile: (path: string) => void;
  openDirs: Record<string, boolean>;
  onToggleDir: (path: string, isOpen: boolean) => void;
}) {
  if (!node.isDir) {
    return (
      <div
        class="row"
        style={{
          justifyContent: 'space-between',
          padding: '2px 0',
          minHeight: '28px',
          flexWrap: 'nowrap',
          width: '100%',
        }}
      >
        <span
          class="mono small"
          title={node.path}
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginRight: '8px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            minWidth: 0,
          }}
        >
          <span class="muted" aria-hidden="true" style={{ flexShrink: 0 }}>📄</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
        </span>
        <button
          class="btn btn-s"
          type="button"
          style={{ flexShrink: 0 }}
          onClick={() => openFile(node.path)}
        >
          Open
        </button>
      </div>
    );
  }

  // Directory node: folders containing multiple files/nodes default to closed
  const defaultOpen = node.children.length <= 1;
  const isOpen = openDirs[node.path] !== undefined ? openDirs[node.path] : defaultOpen;

  return (
    <details
      open={isOpen}
      onToggle={(e) => {
        e.stopPropagation();
        const target = e.currentTarget as HTMLDetailsElement;
        onToggleDir(node.path, target.open);
      }}
      style={{ width: '100%' }}
    >
      <summary
        class="mono small"
        style={{
          cursor: 'pointer',
          userSelect: 'none',
          padding: '3px 0',
          display: 'list-item',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span aria-hidden="true">📁</span>
          <span style={{ fontWeight: 500 }}>{node.name}</span>
          <span class="muted" style={{ fontSize: '11px' }}>({node.children.length})</span>
        </span>
      </summary>
      <div
        style={{
          paddingLeft: '14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
          marginTop: '2px',
        }}
      >
        {node.children.map((child) => (
          <DocTreeNodeView
            key={child.path}
            node={child}
            openFile={openFile}
            openDirs={openDirs}
            onToggleDir={onToggleDir}
          />
        ))}
      </div>
    </details>
  );
}

function RecoveryCard({
  recovery,
  busy,
  onAutoAction,
  onOpenFile,
  onEscapeHatch,
}: {
  recovery: NonNullable<RunView['recovery']>;
  busy: string;
  onAutoAction: () => void;
  onOpenFile: (file: string) => void;
  onEscapeHatch: () => void;
}) {
  return (
    <div
      class="panel"
      style={{
        border: '1px solid var(--accent, #e53e3e)',
        backgroundColor: 'rgba(229, 62, 62, 0.05)',
        borderRadius: '8px',
        margin: '10px 0',
      }}
    >
      <div class="ph" style={{ borderBottom: '1px solid rgba(229, 62, 62, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong>Stage Recovery: {recovery.stage}</strong>
        <span class="tag s-paused">Guaranteed Forward Progress</span>
      </div>
      <div class="pb col" style={{ gap: '10px' }}>
        <p style={{ margin: 0, fontWeight: 500 }}>{recovery.diagnosis}</p>
        <div class="row" style={{ gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          {recovery.autoAction && (
            <button
              class="btn btn-p"
              type="button"
              disabled={!!busy}
              onClick={onAutoAction}
              title={recovery.autoAction.command}
            >
              {busy ? <Spinner /> : null} 1. Auto: {recovery.autoAction.label}
            </button>
          )}
          {recovery.manualAction && (
            <div class="row" style={{ gap: '6px', alignItems: 'center' }}>
              <span class="small">2. Manual: {recovery.manualAction.instruction}</span>
              {recovery.manualAction.file && (
                <button
                  class="btn btn-s"
                  type="button"
                  onClick={() => onOpenFile(recovery.manualAction!.file!)}
                >
                  Open {recovery.manualAction.file}
                </button>
              )}
            </div>
          )}
          {recovery.escapeHatch && (
            <button
              class="btn btn-d"
              type="button"
              disabled={!!busy}
              onClick={onEscapeHatch}
              title={recovery.escapeHatch.command}
            >
              3. Bailout: {recovery.escapeHatch.label}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Run({ slug }: { slug: string }) {
  const { project, go, toast } = useApp();
  const [v, setV] = useState<RunView | null>(null);
  const [brief, setBrief] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState('');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [env, setEnv] = useState<[string, string][]>(() => loadEnv(project, slug));
  const [createPr, setCreatePr] = useState(false);
  const [catalog, setCatalog] = useState<SettingsView | null>(null);
  useEffect(() => { api.settings(project).then(setCatalog).catch(() => setCatalog(null)); }, [project]);
  const [from, setFrom] = useState('');
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [issuesDraft, setIssuesDraft] = useState<string | null>(null);

  const testIssuesRejects = useMemo(() => {
    if (!v?.tail) return [];
    return v.tail.filter(l => l.startsWith('REJECT:') || l.startsWith('TEST REPAIR REJECTED:'));
  }, [v?.tail]);

  const questionsSig = v?.questions.map(q => `${q.n}:${q.title}`).join('|') ?? '';
  const lastQuestionsSig = useRef(questionsSig);

  useEffect(() => {
    if (lastQuestionsSig.current !== questionsSig || (v && v.state !== 'paused')) {
      lastQuestionsSig.current = questionsSig;
      setAnswers({});
    }
  }, [questionsSig, v?.state]);

  useEffect(() => {
    if (v && v.createPr !== undefined) setCreatePr(v.createPr);
    else if (envObj.SDLC_CREATE_PR === '1') setCreatePr(true);
  }, [v?.createPr]);

  const handleToggleCreatePr = async (checked: boolean) => {
    setCreatePr(checked);
    setEnvVar('SDLC_CREATE_PR', checked ? '1' : '0');
    if (v && v.state !== 'not started') {
      try {
        await api.setOptions(project, slug, { createPr: checked });
        toast(checked ? 'PR creation enabled for Finalise' : 'PR creation disabled');
      } catch (e) {
        toast((e as Error).message);
      }
    }
  };

  const load = () => api.run(project, slug).then(x => { setV(x); setError(''); }).catch(e => setError((e as Error).message));
  useEffect(() => {
    setAnswers({});
    setOpenDirs({});
    load();
    api.brief(project, slug).then(b => setBrief(b.brief)).catch(() => setBrief(null));
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [project, slug]);
  useEffect(() => saveEnv(project, slug, env), [env]);

  const envObj = Object.fromEntries(env.filter(([k]) => k.trim()).map(([k, val]) => [k.trim(), val]));
  const envArgs = Object.entries(envObj).map(([k, val]) => `${k}=${val}`);
  const setEnvVar = (k: string, val: string) => setEnv(rows => (val ? [...rows.filter(r => r[0] !== k), [k, val]] : rows.filter(r => r[0] !== k)));

  async function act(label: string, work: () => Promise<{ ok?: boolean; out?: string[]; err?: string[] } | unknown>) {
    setBusy(label); setConfirm('');
    try {
      const o = await work() as { ok?: boolean; out?: string[]; err?: string[] };
      if (o && o.ok === false) toast(`${label}: ${(o.err || []).join(' ') || 'refused'}`);
      else if (o && o.out && o.out.length) toast(o.out[o.out.length - 1]);
      await load();
    } catch (e) { toast(`${label}: ${(e as Error).message}`); }
    setBusy('');
  }

  if (!v) return <div class="col"><h1 class="mono">{slug}</h1>{error ? <ErrorBox error={error} /> : <p class="muted">Loading…</p>}</div>;

  const running = v.state === 'running';
  const states = stageStates(v);
  const unanswered = v.questions.filter(q => !(answers[q.n] !== undefined ? answers[q.n] : q.answer).trim()).length;
  const startLabel = v.state === 'not started' || v.state === 'refused' ? 'Start' : v.resumeFrom ? `Resume from ${STAGES.find(s => s.key === v.resumeFrom)?.name || v.resumeFrom}` : 'Resume';
  const startArgs = ['start', slug, ...(v.resumeFrom && v.state !== 'not started' ? ['--from', v.resumeFrom] : [])];
  const editorLink = v.worktree ? `vscode://file${v.worktree.startsWith('/') ? '' : '/'}${v.worktree}` : '';
  const openFile = async (p: string) => { try { setFile({ path: p, text: (await api.file(project, slug, p)).text }); } catch (e) { toast((e as Error).message); } };
  const docTree = useMemo(() => (v ? buildDocTree(v.docs) : []), [v?.docs.join('|')]);

  return (
    <div class="col">
      <a href="#/board" onClick={e => { e.preventDefault(); go('/board'); }} class="small">← Board</a>
      <div class="row" style={{ gap: '10px 16px', alignItems: 'center', flexWrap: 'wrap' }}>
        <h1 class="mono" style={{ fontWeight: 500 }}>{slug}</h1>
        <StateTag state={v.state} />
        {v.stage && <span class="tag">at {v.stage}</span>}
        {v.attempt && (
          <span class={`tag ${v.state === 'running' ? 's-running' : v.state === 'paused' ? 's-paused' : ''}`}>
            {v.state === 'running' ? `running iteration ${v.attempt}` : `iteration ${v.attempt}`}
          </span>
        )}
        {v.state !== 'not started' && <span class="tag">branch {v.branch}</span>}
        {v.base && <span class="tag">base {v.base}</span>}
        {v.pr && (
          <div class="row" style={{ gap: '6px', alignItems: 'center' }}>
            <a href={v.pr} target="_blank" rel="noreferrer" class="tag s-done mono" style={{ textDecoration: 'underline' }}>PR ↗</a>
            {v.prState && <span class={`tag mono ${v.prState === 'MERGED' ? 's-done' : 's-running'}`}>{v.prState.toLowerCase()}</span>}
          </div>
        )}
        {v.note && <span class="tag s-paused">{v.note}</span>}
      </div>
      <ErrorBox error={error} />
      {v.message && <div class="error">{v.message}</div>}

      {v.recovery && ['paused', 'failed', 'refused'].includes(v.state) && (
        <RecoveryCard
          recovery={v.recovery}
          busy={busy}
          onAutoAction={() => {
            const auto = v.recovery!.autoAction;
            if (!auto) return;
            const customEnv = auto.env ? { ...envObj, ...auto.env } : envObj;
            if (auto.command.includes('--from spec')) {
              act(auto.label, () => api.start(project, slug, 'spec', customEnv));
            } else if (auto.command.includes('--from plan')) {
              act(auto.label, () => api.start(project, slug, 'plan', customEnv));
            } else if (auto.command.includes('--from red-tests')) {
              act(auto.label, () => api.start(project, slug, 'red-tests', customEnv));
            } else if (auto.command.includes('--from implement')) {
              act(auto.label, () => api.start(project, slug, 'implement', customEnv));
            } else if (auto.command.includes('--from test-repair')) {
              act(auto.label, () => api.start(project, slug, 'test-repair', customEnv));
            } else if (auto.command.includes('--from review')) {
              act(auto.label, () => api.start(project, slug, 'review', customEnv));
            } else if (auto.command.includes('--from finalise')) {
              act(auto.label, () => api.start(project, slug, 'finalise', customEnv));
            } else {
              act(auto.label, () => api.start(project, slug, v.resumeFrom || undefined, customEnv));
            }
          }}
          onOpenFile={openFile}
          onEscapeHatch={() => {
            const esc = v.recovery!.escapeHatch;
            if (!esc) return;
            const fromMatch = esc.command.match(/--from (\S+)/);
            const targetFrom = fromMatch ? fromMatch[1] : undefined;
            act(esc.label, () => api.start(project, slug, targetFrom, envObj));
          }}
        />
      )}

      <div class="row">
        <button class="btn btn-p" type="button" disabled={running || !!busy} onClick={() => act(startLabel, () => api.start(project, slug, v.state === 'not started' ? undefined : v.resumeFrom || undefined, envObj))}>{busy === startLabel ? <><Spinner /> Starting…</> : startLabel}</button>
        <label class="sr" for="from">Restart from</label>
        <select id="from" class="sel" style={{ minHeight: '40px' }} value={from} onChange={e => setFrom((e.target as HTMLSelectElement).value)} disabled={v.state === 'not started'}>
          <option value="">from the start</option>
          {STAGES.filter(s => s.key).map(s => <option value={s.key}>from {s.name}</option>)}
        </select>
        {confirm === 'restart'
          ? <><button class="btn btn-d" type="button" disabled={!!busy} onClick={() => act('Restart', () => api.restart(project, slug, from || undefined, envObj))}>{busy === 'Restart' ? <><Spinner /> Restarting…</> : 'Confirm: discard and start again'}</button><button class="btn" type="button" disabled={!!busy} onClick={() => setConfirm('')}>Keep it</button></>
          : <button class="btn" type="button" disabled={v.state === 'not started' || !!busy} onClick={() => setConfirm('restart')}>Restart…</button>}
        <button class="btn" type="button" disabled={v.state === 'not started' || !!busy} onClick={() => act(`Resume at ${from || 'start'}`, () => api.start(project, slug, from || undefined, envObj))}>{busy === `Resume at ${from || 'start'}` ? <><Spinner /> Resuming…</> : 'Resume at selected stage'}</button>
        {confirm === 'stop'
          ? <><button class="btn btn-d" type="button" disabled={!!busy} onClick={() => act('Stop', () => api.stop(project, slug))}>{busy === 'Stop' ? <><Spinner /> Stopping…</> : 'Confirm stop'}</button><button class="btn" type="button" disabled={!!busy} onClick={() => setConfirm('')}>Keep running</button></>
          : <button class="btn" type="button" disabled={!running || !!busy} onClick={() => setConfirm('stop')}>Stop</button>}
        {editorLink && <a class="btn" href={editorLink}>Open worktree in editor</a>}
        {v.worktree && <CopyButton text={v.worktree} label="Copy worktree path" />}
        <button class="btn" type="button" disabled title="Waits on engine request E-10">Merge into base <Future id="E-10" /></button>
        {confirm === 'discard'
          ? <><button class="btn btn-d" type="button" disabled={!!busy} onClick={() => act('Discard', () => api.discard(project, slug))}>{busy === 'Discard' ? <><Spinner /> Discarding…</> : 'Confirm discard'}</button><button class="btn" type="button" disabled={!!busy} onClick={() => setConfirm('')}>Keep it</button></>
          : <button class="btn btn-d" type="button" disabled={v.state === 'not started' || !!busy} onClick={() => setConfirm('discard')}>Discard…</button>}
      </div>
      {confirm === 'discard' && <p class="small s-failed" style={{ margin: 0 }}>Deletes the worktree at {v.worktree || 'its folder'}, the branch {v.branch} (its tip is saved) and the run record.</p>}
      <div class="row" style={{ alignItems: 'center', gap: '8px', margin: '4px 0' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={envObj.SDLC_AUTO_ACCEPT === '1'}
            onChange={e => setEnvVar('SDLC_AUTO_ACCEPT', (e.target as HTMLInputElement).checked ? '1' : '')}
          />
          <span>Auto-accept suggested answers (Spec, Plan, Triage)</span>
        </label>
      </div>
      {catalog && !running && (
        <div class="row" style={{ alignItems: 'center', gap: '6px', margin: '4px 0', flexWrap: 'wrap' }}>
          <span class="small muted">This run, every stage:</span>
          <select class="sel" aria-label="run agent" value={envObj.SDLC_FORCE_AGENT || ''} onChange={e => {
            const h = (e.target as HTMLSelectElement).value;
            setEnvVar('SDLC_FORCE_AGENT', h);
            if (envObj.SDLC_FORCE_MODEL && !(catalog.models[h || catalog.config?.agent?.harness || 'claude'] || []).some(m => m.id === envObj.SDLC_FORCE_MODEL)) setEnvVar('SDLC_FORCE_MODEL', '');
          }}>
            <option value="">agent: project's</option>
            {catalog.harnesses.map(h => <option value={h}>{h}</option>)}
          </select>
          <select class="sel" aria-label="run model" value={envObj.SDLC_FORCE_MODEL || ''} onChange={e => setEnvVar('SDLC_FORCE_MODEL', (e.target as HTMLSelectElement).value)}>
            <option value="">model: per stage</option>
            {(catalog.models[envObj.SDLC_FORCE_AGENT || catalog.config?.agent?.harness || 'claude'] || []).map(m => <option value={m.id}>{m.id}</option>)}
          </select>
          <select class="sel" aria-label="run effort" value={envObj.SDLC_FORCE_EFFORT || ''} onChange={e => setEnvVar('SDLC_FORCE_EFFORT', (e.target as HTMLSelectElement).value)}>
            <option value="">effort: per stage</option>
            {catalog.efforts.map(x => <option value={x}>{x}</option>)}
          </select>
        </div>
      )}
      <Cli args={startArgs} />
      {envArgs.length > 0 && <p class="mono small muted" style={{ margin: 0 }}>with {envArgs.join(' ')}</p>}
      {v.discarded && <p class="small muted" style={{ margin: 0 }}>Discarded before. To get that branch back: <span class="mono">{v.discarded}</span></p>}

      <Panel title="Stages" extra={<span class="small muted">A stage's model and effort apply when the run starts or resumes (MODEL_&lt;STAGE&gt;, EFFORT_&lt;STAGE&gt;). Changing them while it runs: <Future id="E-2" /></span>}>
        <div class="rail-scroll">
          <div class="rail">
            {STAGES.map((s, i) => {
              const st = states[i];
              const inUse = s.key && v.models[s.key];
              const locked = running && st !== 'pending';
              return (
                <div class={`stage ${st === 'active' ? 'stage-active' : st === 'paused' ? 'stage-paused' : ''}`}>
                  <strong class={STAGE_CLASS[st]}>{st === 'active' ? <Spinner /> : STAGE_GLYPH[st]} {s.name}</strong>
                  {v.attempt && st === 'active' && (
                    <span class="tag small s-running" style={{ marginTop: '2px', fontSize: '11px', padding: '2px 6px', alignSelf: 'flex-start' }}>
                      running iteration {v.attempt}
                    </span>
                  )}
                  {v.attempt && st === 'paused' && (
                    <span class="tag small s-paused" style={{ marginTop: '2px', fontSize: '11px', padding: '2px 6px', alignSelf: 'flex-start' }}>
                      iteration {v.attempt}
                    </span>
                  )}
                  {s.key === 'finalise' && (
                    <div class="col" style={{ gap: '4px' }}>
                      <span class="small muted">no agent · commits files</span>
                      {v.pr ? (
                        <div class="row" style={{ gap: '4px', alignItems: 'center' }}>
                          <a href={v.pr} target="_blank" rel="noreferrer" class="small s-done mono" style={{ textDecoration: 'underline' }}>View PR ↗</a>
                          {v.prState && <span class={`tag small mono ${v.prState === 'MERGED' ? 's-done' : 's-running'}`}>{v.prState.toLowerCase()}</span>}
                        </div>
                      ) : (
                        (st === 'done' || v.stage === 'Finalise' || v.state === 'done') ? (
                          <button
                            class="btn btn-xs btn-p"
                            type="button"
                            disabled={!!busy}
                            onClick={() => act('Create PR', () => api.createRunPr(project, slug))}
                          >
                            {busy === 'Create PR' ? <><Spinner /> Creating…</> : 'Create PR'}
                          </button>
                        ) : (
                          <label class="row small" style={{ gap: '6px', alignItems: 'center', cursor: (st !== 'pending') ? 'not-allowed' : 'pointer' }}>
                            <input
                              type="checkbox"
                              checked={createPr}
                              disabled={st !== 'pending'}
                              onChange={e => handleToggleCreatePr((e.target as HTMLInputElement).checked)}
                            />
                            <span>Create PR</span>
                          </label>
                        )
                      )}
                    </div>
                  )}
                  {s.key && s.key !== 'finalise' && (locked || running
                    ? <span class="mono small muted">{inUse ? `${inUse.model} · ${inUse.effort}` : 'default'}{st === 'active' ? ' · in use' : ''}</span>
                    : (
                      <div class="row" style={{ gap: '4px' }}>
                        {catalog && (
                          <select class="sel" aria-label={`${s.name} agent`} value={envObj[AGENT_ENV(s.key)] || ''} onChange={e => {
                            setEnvVar(AGENT_ENV(s.key), (e.target as HTMLSelectElement).value);
                            setEnvVar(envKey('MODEL', s.key), '');
                          }}>
                            <option value="">{catalog.config?.agent?.stages?.[s.key]?.harness || catalog.config?.agent?.harness || 'agent'}</option>
                            {catalog.harnesses.map(h => <option value={h}>{h}</option>)}
                          </select>
                        )}
                        <select class="sel" aria-label={`${s.name} model`} value={envObj[envKey('MODEL', s.key)] || ''} onChange={e => setEnvVar(envKey('MODEL', s.key), (e.target as HTMLSelectElement).value)}>
                          {['', ...(catalog ? (catalog.models[envObj[AGENT_ENV(s.key)] || catalog.config?.agent?.stages?.[s.key]?.harness || catalog.config?.agent?.harness || 'claude'] || []).map(m => m.id) : MODELS.slice(1))].map(m => <option value={m}>{m || (inUse ? inUse.model : 'default')}</option>)}
                        </select>
                        <select class="sel" aria-label={`${s.name} effort`} value={envObj[envKey('EFFORT', s.key)] || ''} onChange={e => setEnvVar(envKey('EFFORT', s.key), (e.target as HTMLSelectElement).value)}>
                          {EFFORTS.map(m => <option value={m}>{m || (inUse ? inUse.effort : 'default')}</option>)}
                        </select>
                      </div>
                    ))}
                  {s.key === 'test-repair' && v.models['test-audit'] && <span class="mono small muted">audit: {v.models['test-audit'].model} · {v.models['test-audit'].effort}</span>}
                  {v.stageFiles[s.name] && <span class="small muted">{v.stageFiles[s.name].length} files</span>}
                  {s.name === 'Finalise' && v.deniedPermissions && v.deniedPermissions.length > 0 && <span class="small s-failed">{v.deniedPermissions.length} denied</span>}
                  {s.key && s.key !== 'implement' && s.key !== 'finalise' && <span class="small"><Future id="E-7" /> skip</span>}
                </div>
              );
            })}
          </div>
        </div>
      </Panel>

      <div class="split">
        <div class="wide col">
          {v.questions.length > 0 && (
            <Panel title={<span class="s-paused">The agent has {v.questions.length} question{v.questions.length > 1 ? 's' : ''}</span>} extra={<button class="btn btn-s" type="button" onClick={() => openFile('questions.md')}>Open raw</button>}>
              <div class="pb col">
                {v.questions.map(q => (
                  <div class="col" style={{ gap: '6px' }}>
                    <strong>Q{q.n} · {q.title}</strong>
                    {q.body && <span class="small muted">{q.body}</span>}
                    {q.suggested && <span class="small">Suggested: <span class="s-done">{q.suggested}</span></span>}
                    <div class="row" style={{ alignItems: 'flex-start' }}>
                      <button class="btn btn-s" type="button" onClick={() => setAnswers(a => ({ ...a, [q.n]: 'accept' }))}>Use suggested</button>
                      <label class="sr" for={`q${q.n}`}>Answer to Q{q.n}</label>
                      <textarea id={`q${q.n}`} class="inp" rows={2} style={{ flex: '1 1 320px', width: 'auto' }} placeholder="Your answer ('accept' takes the suggestion)" value={answers[q.n] !== undefined ? answers[q.n] : q.answer} onInput={e => setAnswers(a => ({ ...a, [q.n]: (e.target as HTMLTextAreaElement).value }))} />
                    </div>
                  </div>
                ))}
                <div class="row">
                  <button class="btn btn-p" type="button" disabled={!!busy} onClick={() => act('Answers', async () => {
                    const payload: Record<number, string> = {};
                    for (const q of v.questions) {
                      const val = answers[q.n] !== undefined ? answers[q.n] : q.answer;
                      if (val !== undefined && val !== '') payload[q.n] = val.trim();
                    }
                    const r = await api.answers(project, slug, payload, envObj);
                    setAnswers({});
                    toast(r.resumed ? (r.resumed.ok ? 'Answers saved; the run resumed' : `Answers saved; resume refused: ${r.resumed.err.join(' ')}`) : `Saved ${r.answered} of ${r.total} answers`);
                    return {};
                  })}>{busy === 'Answers' ? <><Spinner /> Saving…</> : (unanswered ? 'Save answers' : 'Submit answers and resume')}</button>
                  <button class="btn" type="button" disabled={!!busy} onClick={() => act('Auto-accept', async () => {
                    const payload: Record<number, string> = {};
                    for (const q of v.questions) payload[q.n] = 'accept';
                    setEnvVar('SDLC_AUTO_ACCEPT', '1');
                    const effectiveEnv = { ...envObj, SDLC_AUTO_ACCEPT: '1' };
                    const r = await api.answers(project, slug, payload, effectiveEnv);
                    setAnswers({});
                    toast(r.resumed ? (r.resumed.ok ? 'All suggestions accepted; the run resumed' : `Suggestions accepted; resume refused: ${r.resumed.err.join(' ')}`) : `Accepted all suggestions (${r.answered} of ${r.total})`);
                    return {};
                  })}>{busy === 'Auto-accept' ? <><Spinner /> Resuming…</> : 'Auto-accept all suggestions and resume'}</button>
                  <span class="small muted">{v.questions.length - unanswered} of {v.questions.length} answered · the run resumes once every question has an answer</span>
                </div>
              </div>
            </Panel>
          )}

          {v.permissions.length > 0 && (
            <Panel title={<span class="s-paused">{v.permissions.length} action{v.permissions.length > 1 ? 's were' : ' was'} refused</span>} extra={<span class="mono small muted">logs/permissions.json · .claude/sdlc-permissions.json</span>}>
              <div class="pb col">
                {v.permissions.map((a, i) => (
                  <div class="col" style={{ gap: '8px' }}>
                    <div class="code mono" style={{ borderRadius: '6px', padding: '8px 10px' }}>{a.tool}  {a.detail}  <span class="muted">({a.stage})</span></div>
                    {a.protected && <span class="small s-paused">Protected path: allowing it runs the whole {a.stage} stage with permission checks off.</span>}
                    <div class="row">
                      <button class="btn btn-s btn-p" type="button" disabled={!!busy} onClick={() => act('Allow', () => api.permit(project, slug, String(i), 'allow', envObj))}>{busy === 'Allow' ? <><Spinner /> Allowing…</> : (a.protected ? 'Allow (stage runs unchecked)' : `Allow this run (${a.rule})`)}</button>
                      {!a.protected && <button class="btn btn-s" type="button" disabled={!!busy} onClick={() => act('Allow always', () => api.permit(project, slug, String(i), 'always', envObj))}>{busy === 'Allow always' ? <><Spinner /> Allowing…</> : 'Allow always'}</button>}
                      <button class="btn btn-s btn-d" type="button" disabled={!!busy} onClick={() => act('Deny', () => api.permit(project, slug, String(i), 'deny', envObj))}>{busy === 'Deny' ? <><Spinner /> Denying…</> : 'Deny'}</button>
                    </div>
                  </div>
                ))}
                <div class="row" style={{ borderTop: '1px solid var(--ln)', paddingTop: '12px' }}>
                  <button class="btn btn-s" type="button" disabled={!!busy} onClick={() => act('Allow all', () => api.permit(project, slug, 'all', 'allow', envObj))}>{busy === 'Allow all' ? <><Spinner /> Allowing all…</> : 'Allow all'}</button>
                  <button class="btn btn-s btn-d" type="button" disabled={!!busy} onClick={() => act('Deny all', () => api.permit(project, slug, 'all', 'deny', envObj))}>{busy === 'Deny all' ? <><Spinner /> Denying all…</> : 'Deny all'}</button>
                  <span class="mono small muted" style={{ marginLeft: 'auto' }}>$ ai-sdlc-helper permit {slug} allow all</span>
                </div>
              </div>
            </Panel>
          )}

          {v.deniedPermissions && v.deniedPermissions.length > 0 && (
            <Panel title={<span class="s-failed">{v.deniedPermissions.length} denied permission{v.deniedPermissions.length > 1 ? 's' : ''}</span>} extra={<span class="mono small muted">logs/permissions.json · .claude/sdlc-permissions.json</span>}>
              <div class="pb col">
                {v.deniedPermissions.map((a, i) => (
                  <div class="col" style={{ gap: '8px' }}>
                    <div class="code mono" style={{ borderRadius: '6px', padding: '8px 10px' }}>{a.tool}  {a.detail}  {a.stage && <span class="muted">({a.stage})</span>}</div>
                    {a.protected && <span class="small s-paused">Protected path: allowing it runs the whole {a.stage || 'stage'} stage with permission checks off.</span>}
                    <div class="row">
                      <button class="btn btn-s btn-p" type="button" disabled={!!busy} onClick={() => act('Allow', () => api.permit(project, slug, `denied:${i}`, 'allow', envObj))}>{busy === 'Allow' ? <><Spinner /> Allowing…</> : (a.protected ? 'Allow (stage runs unchecked)' : `Allow this run (${a.rule})`)}</button>
                      {!a.protected && <button class="btn btn-s" type="button" disabled={!!busy} onClick={() => act('Allow always', () => api.permit(project, slug, `denied:${i}`, 'always', envObj))}>{busy === 'Allow always' ? <><Spinner /> Allowing…</> : 'Allow always'}</button>}
                      <button class="btn btn-s btn-d" type="button" disabled={!!busy} onClick={() => act('Deny', () => api.permit(project, slug, `denied:${i}`, 'deny', envObj))}>{busy === 'Deny' ? <><Spinner /> Denying…</> : 'Keep denied'}</button>
                    </div>
                  </div>
                ))}
                <div class="row" style={{ borderTop: '1px solid var(--ln)', paddingTop: '12px' }}>
                  <button class="btn btn-s" type="button" disabled={!!busy} onClick={() => act('Allow all', () => api.permit(project, slug, 'denied:all', 'allow', envObj))}>{busy === 'Allow all' ? <><Spinner /> Allowing all…</> : 'Allow all'}</button>
                  <button class="btn btn-s btn-d" type="button" disabled={!!busy} onClick={() => act('Deny all', () => api.permit(project, slug, 'denied:all', 'deny', envObj))}>{busy === 'Deny all' ? <><Spinner /> Denying all…</> : 'Keep all denied'}</button>
                  <span class="mono small muted" style={{ marginLeft: 'auto' }}>$ ai-sdlc-helper permit {slug} denied:all allow</span>
                </div>
              </div>
            </Panel>
          )}

          {v.state === 'paused' && !v.questions.length && !v.permissions.length && (
            <div class="banner">Paused at {v.stage || 'the start'} with nothing left to answer or decide: press {startLabel} to continue.</div>
          )}

          {(v.testIssues !== undefined && v.testIssues !== null || v.stage === 'Test repair' || v.resumeFrom === 'test-repair') && (
            <Panel
              title={
                <span class={v.state === 'failed' ? 's-failed' : 's-running'}>
                  Test defect claims (test-issues.md)
                </span>
              }
              extra={<span class="mono small muted">test-issues.md</span>}
            >
              <div class="pb col" style={{ gap: '10px' }}>
                <p class="small muted" style={{ margin: 0 }}>
                  Format: <span class="mono">&lt;test file&gt; :: &lt;full test name&gt; :: &lt;why citing spec/plan/isolation&gt;</span>
                </p>
                {testIssuesRejects.length > 0 && (
                  <div class="error" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                    {testIssuesRejects.join('\n')}
                  </div>
                )}
                <textarea
                  class="inp mono small"
                  rows={4}
                  style={{ width: '100%', resize: 'vertical' }}
                  placeholder="test/example.test.ts :: my test name :: why citing spec..."
                  value={issuesDraft !== null ? issuesDraft : (v.testIssues || '')}
                  onInput={e => setIssuesDraft((e.target as HTMLTextAreaElement).value)}
                />
                <div class="row">
                  <button
                    class="btn btn-p"
                    type="button"
                    disabled={!!busy}
                    onClick={() => act('Save & Resume Test repair', async () => {
                      const text = issuesDraft !== null ? issuesDraft : (v.testIssues || '');
                      const r = await api.saveTestIssues(project, slug, text, true);
                      setIssuesDraft(null);
                      toast(r.resumed?.ok ? 'Claims saved; Test repair resumed' : 'Claims saved');
                      return {};
                    })}
                  >
                    {busy === 'Save & Resume Test repair' ? <><Spinner /> Resuming…</> : 'Save claims & Resume Test repair'}
                  </button>
                  <button
                    class="btn"
                    type="button"
                    disabled={!!busy}
                    onClick={() => act('Save claims', async () => {
                      const text = issuesDraft !== null ? issuesDraft : (v.testIssues || '');
                      await api.saveTestIssues(project, slug, text, false);
                      toast('Claims saved to test-issues.md');
                      return {};
                    })}
                  >
                    {busy === 'Save claims' ? <><Spinner /> Saving…</> : 'Save claims only'}
                  </button>
                  <button
                    class="btn"
                    type="button"
                    disabled={running || !!busy}
                    onClick={() => act('Resume at Test repair', () => api.start(project, slug, 'test-repair', envObj))}
                  >
                    {busy === 'Resume at Test repair' ? <><Spinner /> Resuming…</> : 'Resume at Test repair'}
                  </button>
                </div>
              </div>
            </Panel>
          )}

          {(v.state === 'failed' || v.state === 'stopped') && v.tail.length > 0 && (
            <Panel title={<span class="s-failed">Why it {v.state === 'failed' ? 'failed' : 'stopped'}</span>} extra={<CopyButton text={v.tail.slice(-15).join('\n')} />}>
              <pre class="code mono" style={{ borderRadius: '0 0 8px 8px' }}>{v.tail.slice(-15).join('\n')}</pre>
            </Panel>
          )}

          {v.state === 'not started' && (
            <Panel title="Brief" extra={<span class="mono small muted">brief.md</span>}>
              <div class="pb">{brief === null ? <span class="muted">No brief.md for this item.</span> : <Markdown text={brief} />}</div>
            </Panel>
          )}

          {(v.pr || v.hasPrComments || v.stage === 'Finalise' || v.state === 'done') && (
            <Panel
              title={
                <span class="row" style={{ gap: '8px', alignItems: 'center' }}>
                  <span>Pull Request</span>
                  {v.prState && (
                    <span class={`tag small mono ${v.prState === 'MERGED' ? 's-done' : 's-running'}`}>
                      {v.prState.toLowerCase()}
                    </span>
                  )}
                </span>
              }
              extra={
                v.pr ? (
                  <div class="row" style={{ gap: '6px' }}>
                    <button
                      class="btn btn-s"
                      type="button"
                      disabled={!!busy}
                      onClick={() => act('Sync PR Comments', async () => {
                        const r = await api.syncRunPrComments(project, slug);
                        toast(r.ok ? `Synced ${r.count} PR comment(s)` : `Sync failed: ${(r.err || []).join(' ')}`);
                        return {};
                      })}
                    >
                      {busy === 'Sync PR Comments' ? <><Spinner /> Syncing…</> : 'Sync PR Comments'}
                    </button>
                    <a href={v.pr} target="_blank" rel="noreferrer" class="btn btn-s" style={{ textDecoration: 'none' }}>
                      Open on GitHub ↗
                    </a>
                  </div>
                ) : null
              }
            >
              <div class="pb col" style={{ gap: '10px' }}>
                {v.pr ? (
                  <div class="col" style={{ gap: '6px' }}>
                    <div class="row" style={{ gap: '8px', alignItems: 'center' }}>
                      <span class="muted small">Link:</span>
                      <a href={v.pr} target="_blank" rel="noreferrer" class="mono s-done" style={{ textDecoration: 'underline' }}>
                        {v.pr}
                      </a>
                    </div>
                    {v.prState === 'OPEN' && (
                      <div class="banner">
                        Pull Request is open. Task will automatically move to <strong>Completed</strong> once this PR is merged on GitHub.
                      </div>
                    )}
                    {v.prState === 'MERGED' && (
                      <div class="banner s-done">
                        ✔ Pull Request is merged into base!
                      </div>
                    )}
                    {v.hasPrComments && (
                      <div class="row" style={{ gap: '8px', alignItems: 'center', marginTop: '4px' }}>
                        <button
                          class="btn btn-s"
                          type="button"
                          onClick={() => openFile('pr-comments.md')}
                        >
                          View PR Comments (pr-comments.md)
                        </button>
                        <button
                          class="btn btn-s btn-p"
                          type="button"
                          disabled={running || !!busy}
                          onClick={() => act('Resume to fix PR comments', () => api.start(project, slug, 'implement', envObj))}
                        >
                          {busy === 'Resume to fix PR comments' ? <><Spinner /> Resuming…</> : 'Resume at Implement to fix PR comments'}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <span class="muted small">Finalise completed, but no pull request has been opened yet.</span>
                    <button
                      class="btn btn-s btn-p"
                      type="button"
                      disabled={!!busy}
                      onClick={() => act('Create PR', () => api.createRunPr(project, slug))}
                    >
                      {busy === 'Create PR' ? <><Spinner /> Creating…</> : 'Create PR Now'}
                    </button>
                  </div>
                )}
              </div>
            </Panel>
          )}

          {v.state !== 'not started' && (
            <Panel title="Output" extra={<div class="row"><span class="mono small muted">logs/run.out</span><CopyButton text={v.tail.join('\n')} /><button class="btn btn-s" type="button" onClick={() => openFile('logs/run.out')}>Whole file</button></div>}>
              <pre class="code mono" style={{ borderRadius: '0 0 8px 8px', maxHeight: '420px', overflowY: 'auto' }}>{v.tail.join('\n') || 'No output yet.'}</pre>
            </Panel>
          )}
        </div>

        <div class="side col">
          <Panel title="This run">
            <dl class="facts pb">
              <dt class="muted">State</dt><dd class={stateClass(v.state)}>{v.state === 'running' ? <Spinner /> : GLYPH[v.state]} {v.state}</dd>
              {v.agent && <><dt class="muted">Agent</dt><dd class="mono">{v.agent} {v.model && `· ${v.model} · ${v.effort}`}</dd></>}
              <dt class="muted">Files</dt><dd>{v.changes ? `${v.changes.changed} changed · ${v.changes.uncommitted} uncommitted` : '—'}</dd>
              <dt class="muted">Tests</dt><dd>{v.tests ? `${v.tests.passed} passed · ${v.tests.failed} failing · ${v.tests.total} total` : 'not run yet'}</dd>
              {v.worktree && <><dt class="muted">Worktree</dt><dd class="mono">{v.worktree}</dd></>}
              {v.updated && <><dt class="muted">Updated</dt><dd>{v.updated}</dd></>}
              <dt class="muted">Usage</dt><dd>— <Future id="E-9" /></dd>
            </dl>
          </Panel>

          <Panel title="Environment for this run" extra={<span class="small muted">applies on start, resume and restart</span>}>
            <div class="pb col" style={{ gap: '6px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none', marginBottom: '4px' }}>
                <input
                  type="checkbox"
                  checked={envObj.SDLC_AUTO_ACCEPT === '1'}
                  onChange={e => setEnvVar('SDLC_AUTO_ACCEPT', (e.target as HTMLInputElement).checked ? '1' : '')}
                />
                <span class="small">Auto-accept suggested answers (Spec, Plan, Triage)</span>
              </label>
              {env.map(([k, val], i) => (
                <div class="row" style={{ flexWrap: 'nowrap' }}>
                  <input class="inp mono" aria-label="Name" value={k} placeholder="NAME" onInput={e => setEnv(rows => rows.map((r, j) => (j === i ? [(e.target as HTMLInputElement).value, r[1]] : r)))} />
                  <input class="inp mono" aria-label="Value" value={val} placeholder="value" onInput={e => setEnv(rows => rows.map((r, j) => (j === i ? [r[0], (e.target as HTMLInputElement).value] : r)))} />
                  <button class="btn btn-s" type="button" aria-label={`Remove ${k}`} onClick={() => setEnv(rows => rows.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <div class="row">
                <button class="btn btn-s" type="button" onClick={() => setEnv(rows => [...rows, ['', '']])}>Add variable</button>
                {['SDLC_AUTO_ACCEPT', 'SDLC_BASE', 'SDLC_LIMIT_MAX_WAIT', 'SDLC_DEP_SCRIPTS', 'SDLC_ALLOW_MERGED'].filter(k => !envObj[k]).map(k => <button class="btn btn-s" type="button" onClick={() => setEnvVar(k, k === 'SDLC_AUTO_ACCEPT' ? '1' : '')}>{k}</button>)}
              </div>
            </div>
          </Panel>

          {Object.keys(v.stageFiles).length > 0 && (
            <Panel title="Files changed per stage">
              <div class="pb col" style={{ gap: '8px' }}>
                {Object.entries(v.stageFiles).map(([name, files]) => (
                  <details>
                    <summary>{name} <span class="muted">({files.length})</span></summary>
                    <ul class="mono small" style={{ margin: '4px 0', paddingLeft: '18px' }}>{files.map(f => <li>{f}</li>)}</ul>
                  </details>
                ))}
              </div>
            </Panel>
          )}

          <Panel title="Documents" extra={<span class="mono small muted">its folder in the backlog</span>}>
            <div style={{ padding: '8px 14px 12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {docTree.map(node => (
                <DocTreeNodeView
                  key={node.path}
                  node={node}
                  openFile={openFile}
                  openDirs={openDirs}
                  onToggleDir={(path, open) => setOpenDirs(prev => (prev[path] === open ? prev : { ...prev, [path]: open }))}
                />
              ))}
              {!v.docs.length && <span class="muted small">No files yet.</span>}
            </div>
          </Panel>

          {v.record && (
            <Panel title="Run record" extra={<span class="mono small muted">.git/sdlc-runs/{slug}.json</span>}>
              <pre class="code mono" style={{ borderRadius: '0 0 8px 8px' }}>{JSON.stringify(v.record, null, 2)}</pre>
            </Panel>
          )}
        </div>
      </div>

      {file && (
        <div class="overlay" role="dialog" aria-modal="true" aria-label={file.path} onClick={e => { if (e.target === e.currentTarget) setFile(null); }}>
          <div class="pn dialog">
            <div class="ph"><span class="mono">{file.path}</span><div class="row"><CopyButton text={file.text} /><button class="btn btn-s" type="button" onClick={() => setFile(null)}>Close</button></div></div>
            <pre class="code mono">{file.text}</pre>
            <p class="small muted pb" style={{ margin: 0 }}>Read-only here; editing files in place comes with phase 2. Edit it in the worktree meanwhile.</p>
          </div>
        </div>
      )}
    </div>
  );
}
