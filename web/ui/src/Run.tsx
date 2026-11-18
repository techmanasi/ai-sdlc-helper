// One run: its stages, the questions and refused actions it waits on, its environment, files and live output, and every
// control the engine has (start, resume, restart from a stage, stop, discard). An item with no run shows its brief.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { REVIEW_LIMIT_ENV, REVIEW_LIMIT_REQUIREMENT } from 'ai-sdlc-helper/review-limit';
import { api, type ModelInfo, type RunView, type SettingsView } from './api';
import { configValue } from './modelFilter';
import { ModelSelect } from './ModelSelect';
import { elapsedText, linkPaths, resolveShown, showTestIssues, stepBanner } from './stages';
import { BackBar, Guarantees, LockDetail, OutputPanel, RoundChips, StageRail, StepList, UsagePanel, usePhone, type RailStage } from './RunInsights';
import { backBar, followNote, followedStage, phoneOpens, pickRound, prBadge, roundsOf, shownStage, waitsFor } from './stagePane';
import { hasUsage, openLock, skipped, stageStates, usageText, verifiedLock, type StageState } from './insights';
import { PrCi } from './PrCi';
import { agentChanged, defaultChoiceLabel, pickProblem } from './stageAgent';
import { Cli, CopyButton, ErrorBox, GLYPH, Markdown, Panel, Spinner, stateClass, useApp } from './ui';
import { defaultPick, needsResumeConfirm, resumeCommand, resumeOptions } from './resume';
import { handoffBlocks, noteError, noteToSend } from './handoff';
import { isMarkdownPath } from './markdown';
import { addEnvKey, quickKeys, reviewLimitOptions, setEnvValue } from './env';
import { usePoll } from './usePoll';
import { useSyncLabel } from './useSyncLabel';
import { useStream } from './useStream';
import { applyRunEvent } from './stream';
import { staleLabel } from './stale';
import { buildDocTree, defaultDirOpen, isStageDirOpen, recordStageDir, type DocTreeNode, type StageDirState } from './tree';

/** What the stage is doing now, under the Stages pane. The elapsed time ticks in the browser only; nothing is written for it. */
function StepBar({ v }: { v: RunView }) {
  const b = stepBanner(v);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!b) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [!!b]);
  if (!b) return null;
  return (
    <div class="stepbar" role="status" aria-live="polite">
      <div class="stepbar-row">
        <Spinner />
        <strong>{b.label}</strong>
        <span class="small muted">{b.position}{b.stage ? ` · ${b.stage}` : ''}{elapsedText(b.started, now) ? ` · ${elapsedText(b.started, now)}` : ''}</span>
      </div>
      <div class="stepbar-track" aria-hidden="true"><div class="stepbar-fill" style={{ width: `${b.percent}%` }} /></div>
    </div>
  );
}

const STAGES = [
  { name: 'Spec', key: 'spec' }, { name: 'Plan', key: 'plan' }, { name: 'Red tests', key: 'red-tests' },
  { name: 'Implement', key: 'implement' }, { name: 'Test repair', key: 'test-repair' }, { name: 'Review', key: 'review' },
  { name: 'Finalise', key: 'finalise' }, { name: 'Resolve conflicts', key: 'resolve-conflicts' },
];
const MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const unique = <T,>(values: T[]): T[] => [...new Set(values)];
const envKey = (kind: 'MODEL' | 'EFFORT', key: string) => `${kind}_${key.toUpperCase().replace(/-/g, '_')}`;
const AGENT_ENV = (key: string) => `AGENT_${key.toUpperCase().replace(/-/g, '_')}`;
const ENV_STORE = (project: string, slug: string) => `sdlc-env:${project}:${slug}`;

function loadEnv(project: string, slug: string): [string, string][] {
  try { const v = JSON.parse(localStorage.getItem(ENV_STORE(project, slug)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function saveEnv(project: string, slug: string, rows: [string, string][]): void {
  try { localStorage.setItem(ENV_STORE(project, slug), JSON.stringify(rows)); } catch { /* private window */ }
}



const STAGE_GLYPH: Record<StageState, string> = { done: '✔', active: '●', paused: '⏸', failed: '✘', pending: '○' };
const STAGE_CLASS: Record<StageState, string> = { done: 's-done', active: 's-running', paused: 's-paused', failed: 's-failed', pending: 's-not-started' };

function DocTreeNodeView({
  node,
  openFile,
  isDirOpen,
  onToggleDir,
}: {
  node: DocTreeNode;
  openFile?: (path: string) => void;
  isDirOpen: (node: DocTreeNode) => boolean;
  onToggleDir: (node: DocTreeNode, isOpen: boolean) => void;
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
        {openFile && (
          <button
            class="btn btn-s"
            type="button"
            style={{ flexShrink: 0 }}
            onClick={() => openFile(node.path)}
          >
            Open
          </button>
        )}
      </div>
    );
  }

  // Directory node: folders containing multiple files/nodes default to closed
  const isOpen = isDirOpen(node);

  return (
    <details
      open={isOpen}
      onToggle={(e) => {
        e.stopPropagation();
        const target = e.currentTarget as HTMLDetailsElement;
        onToggleDir(node, target.open);
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
            isDirOpen={isDirOpen}
            onToggleDir={onToggleDir}
          />
        ))}
      </div>
    </details>
  );
}

function RecoveryCard({
  recovery,
  state,
  busy,
  onAutoAction,
  onOpenFile,
  onEscapeHatch,
}: {
  recovery: NonNullable<RunView['recovery']>;
  state: string;
  busy: string;
  onAutoAction: () => void;
  onOpenFile: (file: string) => void;
  onEscapeHatch: () => void;
}) {
  const failed = state !== 'paused';
  return (
    <section class={`recov ${failed ? 'recov-failed' : ''}`} aria-label="How to go on">
      <div class="recov-head">
        <strong>{recovery.stage} {failed ? 'stopped' : 'is waiting'}: {recovery.diagnosis}</strong>
        <span class="chip" title="Every stop names its cause and offers a way on: a fix the tool can make, what you can do, and a way around">No dead ends · {[recovery.autoAction, recovery.manualAction, recovery.escapeHatch].filter(Boolean).length} ways on</span>
      </div>
      <div class="recov-ways">
        {recovery.autoAction && (
          <div class="way way-first">
            <span class="lbl">Let the tool fix it <span class="chip chip-running">recommended</span></span>
            <p>{recovery.autoAction.label}</p>
            <button class="btn btn-p" type="button" disabled={!!busy} onClick={onAutoAction} title={recovery.autoAction.command}>
              {busy ? <Spinner /> : null} {recovery.autoAction.label}
            </button>
          </div>
        )}
        {recovery.manualAction && (
          <div class="way">
            <span class="lbl">Do it yourself</span>
            <p>{recovery.manualAction.instruction}</p>
            {recovery.manualAction.file && (
              <button class="btn" type="button" onClick={() => onOpenFile(recovery.manualAction!.file!)}>Open {recovery.manualAction.file}</button>
            )}
          </div>
        )}
        {recovery.escapeHatch && (
          <div class="way">
            <span class="lbl">Go around it</span>
            <p>{recovery.escapeHatch.label}</p>
            <button class="btn" type="button" disabled={!!busy} onClick={onEscapeHatch} title={recovery.escapeHatch.command}>{recovery.escapeHatch.label}</button>
          </div>
        )}
      </div>
    </section>
  );
}

/** The Implement round blocks of the run log ("Round <n>: implement" and its indented lines, WARNINGs after it), each its own block. */
function ciRounds(tail: string[]): string[][] {
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of tail) {
    if (/^Round \d+: implement/.test(line)) { cur = [line]; blocks.push(cur); }
    else if (cur && (/^\s/.test(line) || line.startsWith('WARNING:')) && line.trim()) cur.push(line);
    else cur = null;
  }
  return blocks;
}

export function Run({ slug }: { slug: string }) {
  const { project, go, toast } = useApp();
  const [v, setV] = useState<RunView | null>(null);
  const [brief, setBrief] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const syncLabel = useSyncLabel(busy === 'Sync PR', project, slug);
  const [confirm, setConfirm] = useState('');
  /** A run-level override picked but not confirmed yet: a popup explains what it overrides before it is applied. */
  const [forceAsk, setForceAsk] = useState<{ key: string; value: string } | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [env, setEnv] = useState<[string, string][]>(() => loadEnv(project, slug));
  const [createPr, setCreatePr] = useState(false);
  const [catalog, setCatalog] = useState<SettingsView | null>(null);
  useEffect(() => { api.settings(project).then(setCatalog).catch(() => setCatalog(null)); }, [project]);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState('');
  /** The user's optional instruction for the agent of the stage picked (kept apart from the pipeline's finding). */
  const [note, setNote] = useState('');
  const [resumeAsk, setResumeAsk] = useState<{ key: string; name: string } | null>(null);
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [fileView, setFileView] = useState<'rendered' | 'source'>('rendered');
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [stageDirs, setStageDirs] = useState<StageDirState>({});
  const [issuesDraft, setIssuesDraft] = useState<string | null>(null);
  /** The stage the user picked in the rail, and the run's followed stage when they picked it (the pick lapses once the run moves on). */
  const [picked, setPicked] = useState<{ key: string; at: string }>({ key: '', at: '' });
  /** The round of that stage on view (0: the latest). */
  const [pickedRound, setPickedRound] = useState(0);
  /** On a phone the details open under a tapped stage; 'auto' leaves it to the run (a stop opens it). */
  const [phoneMode, setPhoneMode] = useState<'auto' | 'open' | 'shut'>('auto');
  const phone = usePhone();

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

  const load = (refresh = false) => api.run(project, slug, refresh ? { refresh: true } : {}).then(x => { setV(x); setError(''); }).catch(e => setError((e as Error).message));
  useEffect(() => {
    setAnswers({});
    setOpenDirs({});
    setStageDirs({});
    load();
    api.brief(project, slug).then(b => setBrief(b.brief)).catch(() => setBrief(null));
  }, [project, slug]);
  const streaming = v?.state === 'running' || v?.state === 'paused';
  usePoll(load, v?.state, `${project}/${slug}`, streaming);
  useStream({
    url: streaming ? api.runEventsUrl(project, slug) : null,
    on: { snapshot: d => setV(p => applyRunEvent(p, 'snapshot', d)), run: d => setV(p => applyRunEvent(p, 'run', d)), tail: d => setV(p => applyRunEvent(p, 'tail', d)) },
    poll: () => load(),
    banner: on => setError(on ? 'Lost the connection to the server; retrying…' : ''),
  });
  const { error: limitError, env: envObj, summary: reviewLimitSummary, canLaunch } = reviewLimitOptions(env);
  useEffect(() => {
    if (!limitError) saveEnv(project, slug, env);
  }, [project, slug, env, limitError]);

  const limitRow = env.find(([k]) => k.trim() === REVIEW_LIMIT_ENV);
  const limitDraft = limitRow ? limitRow[1] : '';
  const envArgs = Object.entries(envObj).map(([k, val]) => `${k}=${val}`);
  const setEnvVar = (k: string, val: string) => setEnv(rows => setEnvValue(rows, k, val));

  /** Applies a confirmed run-level override; an agent change also drops a model the new agent does not offer. */
  const applyForce = (key: string, value: string) => {
    setEnvVar(key, value);
    // A changed agent never keeps the old agent's model or effort.
    if (key === 'SDLC_FORCE_AGENT') { setEnvVar('SDLC_FORCE_MODEL', ''); setEnvVar('SDLC_FORCE_EFFORT', ''); }
    if (key === 'SDLC_FORCE_MODEL') {
      const levels = forceModels.find(m => m.id === value || configValue(m, forceModels) === value)?.supportedEfforts;
      if (levels && !levels.includes(envObj.SDLC_FORCE_EFFORT)) setEnvVar('SDLC_FORCE_EFFORT', '');
    }
    setForceAsk(null);
  };
  /** Clearing an override is safe; setting one overrides every stage, so it asks first. */
  const askForce = (key: string, value: string) => {
    if (!value) applyForce(key, '');
    else setForceAsk({ key, value });
  };
  /** The run-level overrides as they would be after <pending> is applied, for the popup's text. */
  const forceAfter = (pending: { key: string; value: string }): Record<string, string> => ({ ...envObj, [pending.key]: pending.value });

  /** The first stage whose agent/model/effort pick cannot work, as a message; '' when all are fine. */
  const pickError = (env: Record<string, string>): string => {
    if (!catalog) return '';
    for (const stage of STAGES) {
      const k = stage.key;
      const agent = env.SDLC_FORCE_AGENT || env[AGENT_ENV(k)] || catalog.config?.agent?.stages?.[k]?.harness || catalog.config?.agent?.harness || 'claude';
      const model = env.SDLC_FORCE_MODEL || env[envKey('MODEL', k)] || '';
      const effort = env.SDLC_FORCE_EFFORT || env[envKey('EFFORT', k)] || '';
      const problem = pickProblem(stage.name || k, { agent, model, effort }, catalog.models, a => a !== 'claude');
      if (problem) return problem;
    }
    return '';
  };
  /** Starts a run, refusing a stale agent/model/effort combination here, before any call to the backend. */
  const startRun = (stage: string | undefined, env: Record<string, string>, note?: string) => {
    const problem = pickError(env);
    if (problem) return Promise.reject(new Error(problem));
    return api.start(project, slug, stage, env, note);
  };

  async function act(label: string, work: () => Promise<{ ok?: boolean; out?: string[]; err?: string[] } | unknown>) {
    setBusy(label); setConfirm('');
    try {
      const o = await work() as { ok?: boolean; out?: string[]; err?: string[] };
      if (o && o.ok === false) toast(`${label}: ${(o.err || []).join(' ') || 'refused'}`);
      else if (o && o.out && o.out.length) toast(o.out[o.out.length - 1]);
      await load(true);
    } catch (e) { toast(`${label}: ${(e as Error).message}`); }
    setBusy('');
  }

  function launch(label: string, work: () => Promise<unknown>) {
    if (!canLaunch) { toast(limitError); return; }
    return act(label, work);
  }

  if (!v) return <div class="col"><div class="hero"><h1>{slug}</h1></div>{error ? <ErrorBox error={error} /> : <><div class="skel" style={{ height: '64px' }} /><div class="skel" style={{ height: '150px' }} /><div class="skel" style={{ height: '320px' }} /><span class="sr" role="status">Loading the run</span></>}</div>;

  const running = v.state === 'running';
  const states = stageStates(v, STAGES);
  const spanOf = (name: string) => v.timeline?.stages.find(x => x.stage === name);
  const lock = verifiedLock(v);
  const lockOpen = openLock(v);
  const railStages: RailStage[] = STAGES.map((s, i) => ({
    name: s.name, key: s.key, afterPr: s.key === 'resolve-conflicts',
    state: skipped(s.name, states[i], v.timeline?.stages, v.stageFiles) ? 'skipped' as const : states[i],
    model: v.models[s.key]?.model || '', files: v.stageFiles[s.name]?.length || 0,
  })).filter(s => !s.afterPr || resolveShown(v));
  const paneStages = railStages.map(r => ({ key: r.key, name: r.name, state: r.state }));
  const followedKey = followedStage(paneStages, { state: v.state, stage: v.stage });
  const shownKey = shownStage(paneStages, followedKey, picked.at === followedKey ? picked.key : '');
  const paneStage = STAGES.find(x => x.key === shownKey);
  const followedState = paneStages.find(x => x.key === followedKey)?.state;
  const phoneIsOpen = phone && (phoneMode === 'open' || (phoneMode === 'auto' && phoneOpens(followedState)));
  const phoneAuto = phone && phoneMode === 'auto' && phoneOpens(followedState);
  const pickStage = (key: string) => {
    if (phone && phoneIsOpen && key === shownKey) { setPhoneMode('shut'); return; }
    setPicked({ key, at: followedKey }); setPickedRound(0); setPhoneMode('open');
  };
  const unanswered = v.questions.filter(q => !(answers[q.n] !== undefined ? answers[q.n] : q.answer).trim()).length;
  // A run with no recorded stage resumes at Spec, named and sent as such: no button starts without saying where.
  const resumeKey = v.resumeFrom || 'spec';
  const startLabel = v.state === 'not started' || v.state === 'refused' ? 'Start' : `Resume from ${STAGES.find(s => s.key === resumeKey)?.name || resumeKey}`;
  const options = resumeOptions({ redCommit: v.redCommit, hasTestIssues: v.testIssues != null, resumeFrom: v.resumeFrom });
  // The recovery card's Auto action already resumes at this stage: one button for it, not two.
  const autoStage = v.recovery?.autoAction?.command.match(/--from (\S+)/)?.[1];
  const primaryDuplicated = !!v.recovery && ['paused', 'failed'].includes(v.state) && autoStage === resumeKey;
  // The reviewers of a resolution the agent doubts: how many (0 to 5, 3 by default), and each one's agent, model and effort.
  const reviewerConfig = () => {
    const count = /^\d+$/.test(envObj.SDLC_RESOLVE_REVIEWERS || '') ? Math.min(5, Number(envObj.SDLC_RESOLVE_REVIEWERS)) : 3;
    // Each reviewer needs its own agent and model: what every reviewer runs with, as "<agent>:<model>".
    const keyOf = (stage: string) => {
      const st = catalog?.config?.agent?.stages?.[stage];
      const agent = envObj[AGENT_ENV(stage)] || st?.harness || catalog?.config?.agent?.harness || 'claude';
      const model = envObj[envKey('MODEL', stage)] || st?.model || (agent === (catalog?.config?.agent?.harness || 'claude') ? catalog?.stageDefaults?.[stage]?.model : '') || '(default)';
      return `${agent}:${model}`;
    };
    const keys = Array.from({ length: count }, (_, i) => keyOf(`resolve-review-${i + 1}`));
    const clash = keys.map((k, i) => (keys.indexOf(k) !== i || keys.lastIndexOf(k) !== i ? i + 1 : 0)).filter(Boolean);
    return (
      <div class="col" style={{ gap: '6px' }}>
        <label class="row small" style={{ gap: '6px', alignItems: 'center' }}>
          <span>Independent reviewers when the agent is unsure</span>
          <select class="sel" aria-label="number of reviewers" disabled={running} value={String(count)} onChange={e => setEnvVar('SDLC_RESOLVE_REVIEWERS', (e.target as HTMLSelectElement).value === '3' ? '' : (e.target as HTMLSelectElement).value)}>
            {[0, 1, 2, 3, 4, 5].map(n => <option value={String(n)}>{n === 0 ? 'none: ask me' : n === 3 ? '3 (default)' : String(n)}</option>)}
          </select>
        </label>
        <span class="small muted">The doubt is overridden only when all of them find the resolution safe; otherwise a judge agent sums up their opinions for you.</span>
        {Array.from({ length: count }, (_, i) => (
          <div class="row small" style={{ gap: '6px', alignItems: 'center' }}>
            <span class="muted" style={{ minWidth: '70px' }}>Reviewer {i + 1}</span>
            {running ? <span class="row small" style={{ gap: '4px', alignItems: 'center' }}>{overrideBadge}<span class="mono muted">{v.models[`resolve-review-${i + 1}`] ? `${v.models[`resolve-review-${i + 1}`].model} · ${v.models[`resolve-review-${i + 1}`].effort}` : 'default'}</span></span> : stagePickers({ key: `resolve-review-${i + 1}`, name: `Reviewer ${i + 1}`, taken: keys.filter((_, j) => j !== i) })}
          </div>
        ))}
        {clash.length > 0 && <span class="small s-failed">Reviewers {clash.join(', ')} share an agent and model, so none of them would be asked. Give each its own: pick another model or agent.</span>}
        {count > 0 && (
          <div class="row small" style={{ gap: '6px', alignItems: 'center' }}>
            <span class="muted" style={{ minWidth: '70px' }}>Judge</span>
            {running ? <span class="row small" style={{ gap: '4px', alignItems: 'center' }}>{overrideBadge}<span class="mono muted">{v.models['resolve-judge'] ? `${v.models['resolve-judge'].model} · ${v.models['resolve-judge'].effort}` : 'default'}</span></span> : stagePickers({ key: 'resolve-judge', name: 'Judge' })}
          </div>
        )}
      </div>
    );
  };

  // Review: one reviewer (default), or several different models whose findings a summariser merges.
  const reviewConfig = () => {
    const multi = envObj.SDLC_REVIEW_MODE === 'multi';
    const count = /^\d+$/.test(envObj.SDLC_REVIEW_REVIEWERS || '') ? Math.min(5, Math.max(2, Number(envObj.SDLC_REVIEW_REVIEWERS))) : 2;
    const stageKey = (i: number) => (i === 0 ? 'review' : `review-${i + 1}`);
    const keyOf = (stage: string) => {
      const st = catalog?.config?.agent?.stages?.[stage];
      const agent = envObj[AGENT_ENV(stage)] || st?.harness || catalog?.config?.agent?.harness || 'claude';
      const model = envObj[envKey('MODEL', stage)] || st?.model || (agent === (catalog?.config?.agent?.harness || 'claude') ? catalog?.stageDefaults?.[stage]?.model : '') || '(default)';
      return `${agent}:${model}`;
    };
    // review.syncEachRound: the project's default; SDLC_REVIEW_SYNC_ROUNDS (0 or 1) is this run's own choice.
    const syncDefault = (catalog?.config as { review?: { syncEachRound?: boolean } } | undefined)?.review?.syncEachRound !== false;
    const syncRounds = envObj.SDLC_REVIEW_SYNC_ROUNDS === '1' ? true : envObj.SDLC_REVIEW_SYNC_ROUNDS === '0' ? false : syncDefault;
    const names = [...Array.from({ length: count }, (_, i) => stageKey(i)), 'review-summary'];
    const keys = names.map(keyOf);
    const clash = keys.map((k, i) => (keys.indexOf(k) !== i || keys.lastIndexOf(k) !== i ? i : -1)).filter(i => i >= 0);
    return (
      <div class="col" style={{ gap: '6px' }}>
        <label class="row small" style={{ gap: '6px', alignItems: 'center' }}>
          <span>Review</span>
          <select class="sel" aria-label="review mode" disabled={running} value={multi ? 'multi' : 'single'} onChange={e => setEnvVar('SDLC_REVIEW_MODE', (e.target as HTMLSelectElement).value === 'multi' ? 'multi' : '')}>
            <option value="single">single (default)</option>
            <option value="multi">multi-model</option>
          </select>
        </label>
        {multi && (
          <label class="row small" style={{ gap: '6px', alignItems: 'center' }}>
            <span>Reviewers</span>
            <select class="sel" aria-label="number of review reviewers" disabled={running} value={String(count)} onChange={e => setEnvVar('SDLC_REVIEW_REVIEWERS', (e.target as HTMLSelectElement).value === '2' ? '' : (e.target as HTMLSelectElement).value)}>
              {[2, 3, 4, 5].map(n => <option value={String(n)}>{n === 2 ? '2 (default)' : String(n)}</option>)}
            </select>
          </label>
        )}
        {multi && names.map((stage, i) => (
          <div class="row small" style={{ gap: '6px', alignItems: 'center' }}>
            <span class="muted" style={{ minWidth: '70px' }}>{stage === 'review-summary' ? 'Summariser' : `Reviewer ${i + 1}`}</span>
            {running ? <span class="row small" style={{ gap: '4px', alignItems: 'center' }}>{overrideBadge}<span class="mono muted">{v.models[stage] ? `${v.models[stage].model} · ${v.models[stage].effort}` : 'default'}</span></span> : stagePickers({ key: stage, name: stage === 'review-summary' ? 'Summariser' : `Reviewer ${i + 1}`, taken: keys.filter((_, j) => j !== i) })}
          </div>
        ))}
        {multi && clash.length > 0 && <span class="small s-failed">{clash.map(i => (names[i] === 'review-summary' ? 'The summariser' : `Reviewer ${i + 1}`)).join(', ')} share an agent and model, and the run would be refused. Give each its own: pick another model or agent.</span>}
        <label class="row small" for="review-loop-override">
          Review loop limit override
          <input class="inp" id="review-loop-override" inputMode="numeric" value={limitDraft} disabled={running}
            aria-invalid={Boolean(limitError)} aria-describedby="review-override-help"
            onInput={e => setEnvVar(REVIEW_LIMIT_ENV, e.currentTarget.value)} />
        </label>
        <span class="small muted" id="review-override-help">Leave blank to use the project limit{catalog?.config?.review ? ` (${catalog.config.review.maxLoops})` : ''}. Each loop sends findings back to Red tests and Implement.</span>
        {limitError && <span class="small s-failed" role="alert">{limitError}</span>}
        <label class="row small" style={{ gap: '6px', alignItems: 'center' }}>
          <input type="checkbox" id="review-sync-rounds" aria-label="sync each review round" disabled={running} checked={syncRounds}
            onChange={e => { const on = (e.target as HTMLInputElement).checked; setEnvVar('SDLC_REVIEW_SYNC_ROUNDS', on === syncDefault ? '' : on ? '1' : '0'); }} />
          <span>Sync the branch with GitHub before each fix round{syncDefault ? ' (default)' : ''}</span>
        </label>
      </div>
    );
  };

  const rcState = states[STAGES.length - 1];
  const showResolve = !!v.pr && v.prState !== 'MERGED' && (v.prConflicts === 'conflicting' || rcState === 'active' || rcState === 'failed' || rcState === 'paused');
  const runOptionSummary = [
    envObj.SDLC_AUTO_ACCEPT === '1' && 'auto-accept',
    reviewLimitSummary,
    envObj.SDLC_FORCE_AGENT && `agent ${envObj.SDLC_FORCE_AGENT}`,
    envObj.SDLC_FORCE_MODEL && `model ${envObj.SDLC_FORCE_MODEL}`,
    envObj.SDLC_FORCE_EFFORT && `effort ${envObj.SDLC_FORCE_EFFORT}`,
  ].filter(Boolean).join(', ');
  const forceSummary = [
    envObj.SDLC_FORCE_AGENT && `agent ${envObj.SDLC_FORCE_AGENT}`,
    envObj.SDLC_FORCE_MODEL && `model ${envObj.SDLC_FORCE_MODEL}`,
    envObj.SDLC_FORCE_EFFORT && `effort ${envObj.SDLC_FORCE_EFFORT}`,
  ].filter(Boolean).join(', ');
  const forceModels = catalog?.models[envObj.SDLC_FORCE_AGENT || catalog?.config?.agent?.harness || 'claude'] || [];
  const forceModel = forceModels.find(m => m.id === envObj.SDLC_FORCE_MODEL || configValue(m, forceModels) === envObj.SDLC_FORCE_MODEL);
  const forceActive = !!(envObj.SDLC_FORCE_AGENT || envObj.SDLC_FORCE_MODEL || envObj.SDLC_FORCE_EFFORT);
  /** The "[override]" marker next to a stage's model: the run-level force, not the stage's own setting, decided it. */
  const overrideBadge = forceActive && (
    <span class="mono small" style={{ color: 'var(--wait, #e3b341)', fontWeight: 600 }} title="Run-level override (“This run, every stage”) decided this, not the stage's own setting">
      [override]
    </span>
  );
  /** What a stage will actually run, with every override applied (run-level first, then the stage's own, then the project's). */
  const effectiveOf = (key: string): string => {
    const st = catalog?.config?.agent?.stages?.[key] || {};
    const harness = envObj.SDLC_FORCE_AGENT || envObj[AGENT_ENV(key)] || st.harness || catalog?.config?.agent?.harness || 'claude';
    const model = envObj.SDLC_FORCE_MODEL || envObj[envKey('MODEL', key)] || st.model || '';
    const effort = envObj.SDLC_FORCE_EFFORT || envObj[envKey('EFFORT', key)] || st.effort || '';
    return [harness, model || `default ${harness} model`, effort].filter(Boolean).join(' · ');
  };
  const startArgs = ['start', slug, ...(v.resumeFrom && v.state !== 'not started' ? ['--from', v.resumeFrom] : [])];
  const editorLink = v.worktree ? `vscode://file${v.worktree.startsWith('/') ? '' : '/'}${v.worktree}` : '';
  const openFile = async (p: string) => { try { const text = (await api.file(project, slug, p)).text; setFileView('rendered'); setFile({ path: p, text }); } catch (e) { toast((e as Error).message); } };
  const docTree = useMemo(() => (v ? buildDocTree(v.docs) : []), [v?.docs.join('|')]);

  const stagePickers = ({ key, name, taken }: { key: string; name: string; /** "<agent>:<model>" choices other stages already hold: not offered again. */ taken?: string[] }) => {
    const inUse = v.models[key];
    const fileHarness = catalog?.config?.agent?.stages?.[key]?.harness || catalog?.config?.agent?.harness;
    const switched = agentChanged(envObj[AGENT_ENV(key)], fileHarness);
    const activeHarness = envObj[AGENT_ENV(key)] || catalog?.config?.agent?.stages?.[key]?.harness || catalog?.config?.agent?.harness || 'claude';
    const selectedModel = envObj[envKey('MODEL', key)] || '';
    const models: ModelInfo[] = catalog ? (catalog.models[activeHarness] || []) : MODELS.slice(1).map(id => ({ id, name: id, supportsEffort: false }));
    const effectiveModel = selectedModel || catalog?.config?.agent?.stages?.[key]?.model || catalog?.config?.agent?.model;
    const selectedInfo = models.find(m => m.id === effectiveModel || configValue(m, models) === effectiveModel);
    const efforts = selectedInfo?.supportedEfforts !== undefined ? ['', ...selectedInfo.supportedEfforts] : EFFORTS;
    const multipleProvider = !!catalog?.multipleProviderHarnesses?.includes(activeHarness);
    return (
      <div class="row" style={{ gap: '4px' }}>
        {catalog && (
          <select class="sel" aria-label={`${name} agent`} value={envObj[AGENT_ENV(key)] || ''} onChange={e => {
            setEnvVar(AGENT_ENV(key), (e.target as HTMLSelectElement).value);
            setEnvVar(envKey('MODEL', key), '');
            setEnvVar(envKey('EFFORT', key), '');
          }}>
            <option value="">{(() => { const h = catalog.config?.agent?.stages?.[key]?.harness || catalog.config?.agent?.harness; return h ? `default (${h})` : 'agent'; })()}</option>
            {unique(catalog.harnesses).map(h => <option value={h}>{h}</option>)}
          </select>
        )}
        <ModelSelect name={name} models={models} value={selectedModel} harness={activeHarness} taken={taken}
          multipleProvider={multipleProvider}
          defaultLabel={defaultChoiceLabel(inUse && inUse.model, switched)}
          onChange={model => { setEnvVar(envKey('MODEL', key), model); setEnvVar(envKey('EFFORT', key), ''); }} />
        <select class="sel" aria-label={`${name} effort`} value={envObj[envKey('EFFORT', key)] || ''} onChange={e => setEnvVar(envKey('EFFORT', key), (e.target as HTMLSelectElement).value)}>
          {unique(efforts).map(m => <option value={m}>{m || (selectedInfo?.supportsEffort === false ? 'not used' : defaultChoiceLabel(inUse && inUse.effort, switched))}</option>)}
        </select>
      </div>
    );
  };

  return (
    <div class="col">
      <a href="#/board" onClick={e => { e.preventDefault(); go('/board'); }} class="small">← Board</a>
      <div class="hero">
        <h1>{slug}</h1>
        <a class="btn btn-s" href={`#/edit/run/${slug}`} onClick={e => { e.preventDefault(); go(`/edit/run/${slug}`); }}>Edit</a>
        <span class={`chip chip-${v.state.replace(' ', '-')}`}>{v.state === 'running' ? <Spinner /> : GLYPH[v.state]} {v.state}{v.stage ? ` · ${v.stage}` : ''}</span>
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
        {v.ci && (
          <div class="row" style={{ gap: '6px', alignItems: 'center' }}>
            <span class="tag mono">CI</span>
            {v.ci.pr && <a href={v.ci.pr} target="_blank" rel="noreferrer" class="tag mono" style={{ textDecoration: 'underline' }}>PR ↗</a>}
            {v.ci.pr && <span class="tag mono">{v.ci.prDraft ? 'draft' : 'ready'}</span>}
            <span class={`tag mono ${v.ci.state.startsWith('green') ? 's-done' : v.ci.state.startsWith('red') ? 's-failed' : v.ci.state.startsWith('running') || v.ci.state === 'waiting' ? 's-running' : 's-paused'}`}>
              {v.ci.state}{v.ci.reason ? ` (${v.ci.reason})` : ''}
            </span>
            {v.ci.sha && <span class="tag mono" title={v.ci.sha}>commit {v.ci.sha.slice(0, 7)}</span>}
            {v.ci.state.startsWith('red') && v.ci.failingChecks.length > 0 && <span class="small mono s-failed">checks: {v.ci.failingChecks.join(', ')}</span>}
          </div>
        )}
        {v.ci && v.ci.warnings.length > 0 && (
          <ul class="small mono s-paused" style={{ margin: '2px 0', paddingLeft: '18px' }}>{v.ci.warnings.map(w => <li>{w}</li>)}</ul>
        )}
        {v.note && <span class="tag s-paused">{v.note}</span>}
      </div>
      <ErrorBox error={error} />
      {v.message && <div class="error">{v.message}</div>}
      <Guarantees v={v} />

      {v.recovery && ['paused', 'failed', 'refused'].includes(v.state) && (
        <RecoveryCard
          recovery={v.recovery}
          state={v.state}
          busy={busy}
          onAutoAction={() => {
            const auto = v.recovery!.autoAction;
            if (!auto) return;
            const customEnv = auto.env ? { ...envObj, ...auto.env } : envObj;
            if (auto.command.includes(' permit ')) {
              launch(auto.label, () => api.permit(project, slug, 'all', 'allow', envObj));
            } else if (auto.command.includes('--from spec')) {
              launch(auto.label, () => startRun('spec', customEnv));
            } else if (auto.command.includes('--from plan')) {
              launch(auto.label, () => startRun('plan', customEnv));
            } else if (auto.command.includes('--from red-tests')) {
              launch(auto.label, () => startRun('red-tests', customEnv));
            } else if (auto.command.includes('--from implement')) {
              launch(auto.label, () => startRun('implement', customEnv));
            } else if (auto.command.includes('--from test-repair')) {
              launch(auto.label, () => startRun('test-repair', customEnv));
            } else if (auto.command.includes('--from review')) {
              launch(auto.label, () => startRun('review', customEnv));
            } else if (auto.command.includes('--from resolve-conflicts')) {
              launch(auto.label, () => startRun('resolve-conflicts', customEnv));
            } else if (auto.command.includes('--from finalise')) {
              launch(auto.label, () => startRun('finalise', customEnv));
            } else {
              launch(auto.label, () => startRun(v.resumeFrom || undefined, customEnv));
            }
          }}
          onOpenFile={openFile}
          onEscapeHatch={() => {
            const esc = v.recovery!.escapeHatch;
            if (!esc) return;
            const fromMatch = esc.command.match(/--from (\S+)/);
            // A command without a stage (push the branch by hand) is not something to start: copy it for the terminal.
            if (!fromMatch) {
              navigator.clipboard.writeText(esc.command).then(() => toast(`Copied: ${esc.command}`), () => toast(`Run in a terminal: ${esc.command}`));
              return;
            }
            launch(esc.label, () => startRun(fromMatch[1], envObj));
          }}
        />
      )}

      <div class="col" style={{ gap: '10px' }}>
        <div class="row" style={{ alignItems: 'center' }}>
          {!primaryDuplicated && (
            <button class="btn btn-p" type="button" disabled={running || !!busy} onClick={() => launch(startLabel, () => startRun(v.state === 'not started' ? undefined : v.state === 'refused' ? v.resumeFrom || undefined : resumeKey, envObj))}>{busy === startLabel ? <><Spinner /> Starting…</> : startLabel}</button>
          )}
          <button class="btn" type="button" id="open-pick" aria-expanded={picking} aria-controls="resume-pick" disabled={v.state === 'not started' || !!busy} onClick={() => { setPick(defaultPick(options)); setPicking(!picking); }}>Resume at… {picking ? '▴' : '▾'}</button>
          {confirm === 'stop'
            ? <><button class="btn btn-d" type="button" disabled={!!busy} onClick={() => act('Stop', () => api.stop(project, slug))}>{busy === 'Stop' ? <><Spinner /> Stopping…</> : 'Confirm stop'}</button><button class="btn" type="button" disabled={!!busy} onClick={() => setConfirm('')}>Keep running</button></>
            : <button class="btn" type="button" disabled={!running || !!busy} onClick={() => setConfirm('stop')}>Stop</button>}
          {v.undo && (confirm === 'undo'
            ? <><button class="btn btn-d" type="button" disabled={!!busy} onClick={() => act('Undo', async () => { const o = await api.undo(project, slug); setConfirm(''); return o; })}>{busy === 'Undo' ? <><Spinner /> Undoing…</> : 'Confirm undo'}</button><button class="btn" type="button" disabled={!!busy} onClick={() => setConfirm('')}>Keep it</button></>
            : <button class="btn" type="button" disabled={!!busy} title={`Put the branch and files back as they were before the last start (${v.undo.from}, ${v.undo.at}). Stops the run if it is running; what is thrown away is saved in git.`} onClick={() => setConfirm('undo')}>Undo last start</button>)}
          {editorLink && <a class="btn" href={editorLink}>Open in editor</a>}
          {v.worktree && <CopyButton text={v.worktree} label="Copy path" />}
        </div>
        {picking && (
          <fieldset id="resume-pick" class="panel col" style={{ gap: '6px', margin: 0 }} onKeyDown={e => { if ((e as KeyboardEvent).key === 'Escape') setPicking(false); }}>
            <legend class="small muted">Resume the existing branch at</legend>
            {options.map(o => (
              <label style={{ display: 'flex', gap: '8px', alignItems: 'baseline', opacity: o.enabled ? 1 : 0.6, cursor: o.enabled ? 'pointer' : 'not-allowed' }}>
                <input type="radio" name="resume-stage" value={o.key} checked={pick === o.key} disabled={!o.enabled} onChange={() => setPick(o.key)} />
                <span>{o.name}</span>
                {o.note && <span class="small muted">{o.enabled ? o.note : o.note.startsWith('refused') ? `${o.name} ${o.note}` : o.note}</span>}
              </label>
            ))}
            {handoffBlocks(v).finding && <p class="small muted pb col" id="handoff-finding" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{handoffBlocks(v).finding}</p>}
            <label class="col small muted" style={{ gap: '4px' }}>
              {handoffBlocks(v).label(STAGES.find(s => s.key === pick)?.name || pick || 'resumed stage')}
              <textarea class="inp" id="resume-note" rows={3} value={note} onInput={e => setNote((e.target as HTMLTextAreaElement).value)} />
              {noteError(note) && <span class="s-failed">{noteError(note)}</span>}
            </label>
            <div class="row" style={{ alignItems: 'center' }}>
              <button class="btn btn-p" type="button" disabled={!pick || !!busy || running || !!noteError(note)} onClick={() => {
                const key = pick;
                const name = STAGES.find(s => s.key === key)?.name || key;
                if (needsResumeConfirm(key)) { setResumeAsk({ key, name }); return; }
                launch(`Resume at ${name}`, async () => { const o = await startRun(key, envObj, noteToSend(note)); setPicking(false); setNote(''); return o; });
              }}>{busy.startsWith('Resume at') ? <><Spinner /> Resuming…</> : 'Go'}</button>
              <button class="btn" type="button" onClick={() => { setPicking(false); document.getElementById('open-pick')?.focus(); }}>Cancel</button>
              {pick && <span class="mono small muted">{resumeCommand(slug, pick)}</span>}
            </div>
          </fieldset>
        )}
        <details class="small" open={forceActive || undefined}>
          <summary style={{ cursor: 'pointer' }}>Run options: {runOptionSummary || 'project defaults, no auto-accept'}</summary>
          <div class="col" style={{ gap: '6px', marginTop: '8px' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={envObj.SDLC_AUTO_ACCEPT === '1'}
                onChange={e => setEnvVar('SDLC_AUTO_ACCEPT', (e.target as HTMLInputElement).checked ? '1' : '')}
              />
              <span>Auto-accept suggested answers (Spec, Plan, Triage)</span>
            </label>
            {catalog && <details class="small"><summary style={{ cursor: 'pointer' }}>Review: {envObj.SDLC_REVIEW_MODE === 'multi' ? 'multi-model' : 'single'}</summary><div style={{ marginTop: '6px' }}>{reviewConfig()}</div></details>}
            {catalog && <details class="small"><summary style={{ cursor: 'pointer' }}>Resolve conflicts: reviewers when the agent is unsure</summary><div style={{ marginTop: '6px' }}>{reviewerConfig()}</div></details>}
            {catalog && !running && (
              <div class="col" style={{ gap: '8px' }}>
                {forceActive && (
                  <div class="row small" style={{ alignItems: 'center', gap: '8px', flexWrap: 'wrap', border: '1px solid var(--wait, #e3b341)', background: 'color-mix(in srgb, var(--wait, #e3b341) 14%, transparent)', borderRadius: '8px', padding: '6px 10px', color: 'var(--wait, #e3b341)' }}>
                    <strong class="mono">[override]</strong>
                    <span>This run, every stage: {forceSummary} — replaces the project's per-stage setup (sdlc.config.json) for every stage, and stays for future starts of this run until cleared.</span>
                  </div>
                )}
                <div class="row" style={{ alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <label class="row small" style={{ gap: '6px', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }} title="When checked, one agent, model and effort runs every stage of this run instead of the project's per-stage setup (sdlc.config.json). Unchecking it is the default way to remove the override.">
                    <input
                      type="checkbox"
                      checked={forceActive}
                      onChange={e => {
                        if (!(e.target as HTMLInputElement).checked) {
                          setEnvVar('SDLC_FORCE_AGENT', '');
                          setEnvVar('SDLC_FORCE_MODEL', '');
                          setEnvVar('SDLC_FORCE_EFFORT', '');
                        }
                      }}
                    />
                    <span>Override every stage</span>
                  </label>
                  <span class="small muted">This run, every stage:</span>
                <select class="sel" aria-label="run agent" value={envObj.SDLC_FORCE_AGENT || ''} onChange={e => askForce('SDLC_FORCE_AGENT', (e.target as HTMLSelectElement).value)}>
                  <option value="">agent: project's</option>
                  {unique(catalog.harnesses).map(h => <option value={h}>{h}</option>)}
                </select>
                <span style={{ display: 'inline-block', width: '220px', maxWidth: '100%' }}>
                  <ModelSelect name="run"
                    models={forceModels}
                    value={envObj.SDLC_FORCE_MODEL || ''}
                    harness={envObj.SDLC_FORCE_AGENT || catalog.config?.agent?.harness || 'claude'}
                    multipleProvider={!!catalog.multipleProviderHarnesses?.includes(envObj.SDLC_FORCE_AGENT || catalog.config?.agent?.harness || 'claude')}
                    defaultLabel="model: per stage" onChange={model => askForce('SDLC_FORCE_MODEL', model)} />
                </span>
                <select class="sel" aria-label="run effort" value={envObj.SDLC_FORCE_EFFORT || ''} onChange={e => askForce('SDLC_FORCE_EFFORT', (e.target as HTMLSelectElement).value)}>
                  <option value="">{forceModel?.supportsEffort === false ? 'not used' : 'effort: per stage'}</option>
                  {unique(forceModel?.supportedEfforts ?? catalog.efforts).map(x => <option value={x}>{x}</option>)}
                </select>
                </div>
              </div>
            )}
          </div>
        </details>
        <div class="row" style={{ alignItems: 'center' }}>
          <span class="small s-failed">Whole run</span>
          {confirm === 'restart'
            ? <><button class="btn btn-d" type="button" disabled={!!busy} onClick={() => launch('Restart', () => api.restart(project, slug, undefined, envObj))}>{busy === 'Restart' ? <><Spinner /> Restarting…</> : 'Confirm: discard and start again'}</button><button class="btn" type="button" disabled={!!busy} onClick={() => setConfirm('')}>Keep it</button></>
            : <button class="btn btn-d" type="button" disabled={v.state === 'not started' || !!busy} onClick={() => setConfirm('restart')}>Restart whole run from Spec…</button>}
          {confirm === 'discard'
            ? <><button class="btn btn-d" type="button" disabled={!!busy} onClick={() => act('Discard', () => api.discard(project, slug))}>{busy === 'Discard' ? <><Spinner /> Discarding…</> : 'Confirm discard'}</button><button class="btn" type="button" disabled={!!busy} onClick={() => setConfirm('')}>Keep it</button></>
            : <button class="btn btn-d" type="button" disabled={v.state === 'not started' || !!busy} onClick={() => setConfirm('discard')}>Discard entire run…</button>}
        </div>
        {confirm === 'restart' && <p class="small s-failed" style={{ margin: 0 }}>Deletes the worktree at {v.worktree || 'its folder'} and the branch {v.branch} (its tip is saved), then starts over from Spec.</p>}
        {confirm === 'discard' && <p class="small s-failed" style={{ margin: 0 }}>Deletes the worktree at {v.worktree || 'its folder'}, the branch {v.branch} (its tip is saved) and the run record.</p>}
        {confirm.startsWith('discard-stage:') && <p class="small s-failed" style={{ margin: 0 }}>Deletes only the files {STAGES.find(x => x.key === confirm.slice(14))?.name} made and have not been committed. The other stages, their files and the logs stay; start the run again from that stage afterwards.</p>}
      </div>
      <Cli args={startArgs} />
      {envArgs.length > 0 && <p class="mono small muted" style={{ margin: 0 }}>with {envArgs.join(' ')}</p>}
      {v.movedFrom && <p class="small muted" style={{ margin: 0 }}>moved from <span class="mono">{v.movedFrom.branch}</span>: {v.movedFrom.reasonText || v.movedFrom.reason}</p>}
      {v.discarded && <p class="small muted" style={{ margin: 0 }}>Discarded before. To get that branch back: <span class="mono">{v.discarded}</span></p>}

      <Panel title="Stages" extra={<span class="small muted">Pick a stage to see its steps and set its agent, model and effort (they apply when the run starts or resumes)</span>}>
        <StageRail
          stages={railStages} timeline={v.timeline} step={v.state === 'running' ? v.step : undefined} locked={!!lock} lockOpen={lockOpen}
          shown={shownKey} followed={followedKey} pr={prBadge(v)} phone={phone} phoneOpen={phoneIsOpen} onSelect={pickStage}
        >
          {paneStage && (() => {
              const s = paneStage;
              const i = STAGES.findIndex(x => x.key === s.key);
              const st = states[i];
              const inUse = s.key && v.models[s.key];
              const locked = running && st !== 'pending';
              const span = spanOf(s.name);
              const rounds = roundsOf(span);
              const roundNo = pickRound(rounds, pickedRound);
              const round = rounds[roundNo - 1];
              const latest = roundNo === rounds.length;
              const plan = st === 'pending' || (latest && (st === 'active' || st === 'paused')) ? v.stepPlan?.[s.name] : undefined;
              const bar = backBar(paneStages, followedKey, shownKey);
              const note = followNote(st, shownKey === followedKey);
              const waits = st === 'pending' ? waitsFor(s.name) : [];
              return (
                <div id="stage-detail" class="stage-detail" role="tabpanel" aria-label={s.name}>
                 {bar && <BackBar text={bar.text} back={bar.back} onBack={() => { setPicked({ key: '', at: '' }); setPickedRound(0); }} />}
                 {phoneAuto && !bar && <p class="pane-auto small muted">Opened by itself because the run stopped here</p>}
                 <div class="pane-grid">
                 <div class="rail-controls">
                  <h3>{s.name} · {s.key === 'finalise' ? 'options' : 'agent, model and effort'}</h3>
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
                      <label class="row small" style={{ gap: '6px', alignItems: 'center', cursor: running ? 'not-allowed' : 'pointer' }} title="After Finalise pushes, bring the branch up to date with the base; the agent only runs if they conflict. Conflicts found later wait for you in the Pull Request panel.">
                        <input type="checkbox" checked={envObj.SDLC_RESOLVE_CONFLICTS !== '0'} disabled={running}
                          onChange={e => setEnvVar('SDLC_RESOLVE_CONFLICTS', (e.target as HTMLInputElement).checked ? '' : '0')} />
                        <span>Resolve PR Conflicts</span>
                      </label>
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
                    ? <><span class="row small" style={{ gap: '4px', alignItems: 'center' }}>{overrideBadge}<span class="mono muted">{inUse ? `${inUse.model} · ${inUse.effort}` : 'default'}{st === 'active' ? ' · in use' : ''}</span></span>{st === 'active' && <span class="small muted">Locked while the stage runs. Changes apply when the run starts or resumes.</span>}</>
                    : (
                      <div class="col" style={{ gap: '2px' }}>
                        {stagePickers(s)}
                        {forceActive && <span class="mono small" style={{ color: 'var(--wait, #e3b341)' }}>[override] {effectiveOf(s.key)}</span>}
                        {st === 'pending' && <span class="small muted">You can change these now. {s.name} uses them when it starts.</span>}
                      </div>
                    ))}
                  {s.key === 'test-repair' && v.models['test-audit'] && <span class="row small" style={{ gap: '4px', alignItems: 'center' }}>{overrideBadge}<span class="mono small muted">audit: {v.models['test-audit'].model} · {v.models['test-audit'].effort}</span></span>}
                  {v.stageFiles[s.name] && <span class="small muted">{v.stageFiles[s.name].length} files</span>}
                  {s.key && s.key !== 'finalise' && s.name === (v.discardable ?? v.stage) && !running && v.state !== 'not started' && v.state !== 'done' && (v.stageFiles[s.name]?.length || st === 'paused' || st === 'failed') && (
                    confirm === `discard-stage:${s.key}`
                      ? <span class="row" style={{ gap: '4px' }}><button class="btn btn-d" type="button" disabled={!!busy} onClick={() => act(`Discard ${s.name}`, () => api.discardStage(project, slug, s.key))}>{busy === `Discard ${s.name}` ? <><Spinner /> Discarding…</> : `Confirm: discard ${s.name}`}</button><button class="btn" type="button" disabled={!!busy} onClick={() => setConfirm('')}>Keep it</button></span>
                      : <button class="btn btn-s" type="button" disabled={!!busy} onClick={() => setConfirm(`discard-stage:${s.key}`)}>Discard {s.name}…</button>
                  )}
                  {s.name === 'Finalise' && v.deniedPermissions && v.deniedPermissions.length > 0 && <span class="small s-failed">{v.deniedPermissions.length} denied</span>}
                 </div>
                 <div class="pane-steps">
                  <h3>{st === 'pending' ? 'Steps · not started' : `Steps · round ${roundNo}`}{round?.started ? ` · started ${round.started.slice(11, 16)}` : ''}{note && <span class="pane-follow"> · {note}</span>}</h3>
                  {waits.length > 0 && <p class="small muted pane-waits">Starts after {waits.join(' and ')}</p>}
                  <RoundChips count={rounds.length} picked={roundNo} onPick={setPickedRound} />
                  <StepList steps={round?.steps || []} running={st === 'active' && latest} plan={plan} />
                  {plan && <p class="small muted pane-foot">A pill appears when its step starts. The running one counts up; the others keep their final time.</p>}
                  {s.key === 'red-tests' && <><h3 class="eyebrow test-lock-eyebrow" style={{ marginTop: '14px' }}>TEST LOCK</h3><LockDetail lock={lock} open={lockOpen} /></>}
                 </div>
                 </div>
                </div>
              );
          })()}
        </StageRail>
      </Panel>
      <StepBar v={v} />

      <div class="split">
        <div class="wide col">
          {v.questions.length > 0 && (
            <Panel title={<span class="s-paused">The agent has {v.questions.length} question{v.questions.length > 1 ? 's' : ''}</span>} extra={<button class="btn btn-s" type="button" onClick={() => openFile('questions.md')}>Open raw</button>}>
              <div class="pb col">
                {v.questions.map(q => (
                  <div class="col" style={{ gap: '6px' }}>
                    <strong>Q{q.n} · {q.title}</strong>
                    {q.body && <span class="small muted">{linkPaths(q.body, v.docs, slug).map(x => typeof x === 'string' ? x : <a href={`#${x.path}`} class="mono" onClick={e => { e.preventDefault(); openFile(x.path); }}>{x.path}</a>)}</span>}
                    {q.suggested && <span class="small">Suggested: <span class="s-done">{q.suggested}</span></span>}
                    <div class="row" style={{ alignItems: 'flex-start' }}>
                      <button class="btn btn-s" type="button" onClick={() => setAnswers(a => ({ ...a, [q.n]: 'accept' }))}>Use suggested</button>
                      <label class="sr" for={`q${q.n}`}>Answer to Q{q.n}</label>
                      <textarea id={`q${q.n}`} class="inp" rows={2} style={{ flex: '1 1 320px', width: 'auto' }} placeholder="Your answer ('accept' takes the suggestion)" value={answers[q.n] !== undefined ? answers[q.n] : q.answer} onInput={e => setAnswers(a => ({ ...a, [q.n]: (e.target as HTMLTextAreaElement).value }))} />
                    </div>
                  </div>
                ))}
                <div class="row">
                  <button class="btn btn-p" type="button" disabled={!!busy} onClick={() => launch('Answers', async () => {
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
                  <button class="btn" type="button" disabled={!!busy} onClick={() => launch('Auto-accept', async () => {
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
                      <button class="btn btn-s btn-p" type="button" disabled={!!busy} onClick={() => launch('Allow', () => api.permit(project, slug, String(i), 'allow', envObj))}>{busy === 'Allow' ? <><Spinner /> Allowing…</> : (a.protected ? 'Allow (stage runs unchecked)' : `Allow this run (${a.rule})`)}</button>
                      {!a.protected && <button class="btn btn-s" type="button" disabled={!!busy} onClick={() => launch('Allow always', () => api.permit(project, slug, String(i), 'always', envObj))}>{busy === 'Allow always' ? <><Spinner /> Allowing…</> : 'Allow always'}</button>}
                      <button class="btn btn-s btn-d" type="button" disabled={!!busy} onClick={() => launch('Deny', () => api.permit(project, slug, String(i), 'deny', envObj))}>{busy === 'Deny' ? <><Spinner /> Denying…</> : 'Deny'}</button>
                    </div>
                  </div>
                ))}
                <div class="row" style={{ borderTop: '1px solid var(--ln)', paddingTop: '12px' }}>
                  <button class="btn btn-s" type="button" disabled={!!busy} onClick={() => launch('Allow all', () => api.permit(project, slug, 'all', 'allow', envObj))}>{busy === 'Allow all' ? <><Spinner /> Allowing all…</> : 'Allow all'}</button>
                  <button class="btn btn-s btn-d" type="button" disabled={!!busy} onClick={() => launch('Deny all', () => api.permit(project, slug, 'all', 'deny', envObj))}>{busy === 'Deny all' ? <><Spinner /> Denying all…</> : 'Deny all'}</button>
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
                      <button class="btn btn-s btn-p" type="button" disabled={!!busy} onClick={() => launch('Allow', () => api.permit(project, slug, `denied:${i}`, 'allow', envObj))}>{busy === 'Allow' ? <><Spinner /> Allowing…</> : (a.protected ? 'Allow (stage runs unchecked)' : `Allow this run (${a.rule})`)}</button>
                      {!a.protected && <button class="btn btn-s" type="button" disabled={!!busy} onClick={() => launch('Allow always', () => api.permit(project, slug, `denied:${i}`, 'always', envObj))}>{busy === 'Allow always' ? <><Spinner /> Allowing…</> : 'Allow always'}</button>}
                      <button class="btn btn-s btn-d" type="button" disabled={!!busy} onClick={() => launch('Deny', () => api.permit(project, slug, `denied:${i}`, 'deny', envObj))}>{busy === 'Deny' ? <><Spinner /> Denying…</> : 'Keep denied'}</button>
                    </div>
                  </div>
                ))}
                <div class="row" style={{ borderTop: '1px solid var(--ln)', paddingTop: '12px' }}>
                  <button class="btn btn-s" type="button" disabled={!!busy} onClick={() => launch('Allow all', () => api.permit(project, slug, 'denied:all', 'allow', envObj))}>{busy === 'Allow all' ? <><Spinner /> Allowing all…</> : 'Allow all'}</button>
                  <button class="btn btn-s btn-d" type="button" disabled={!!busy} onClick={() => launch('Deny all', () => api.permit(project, slug, 'denied:all', 'deny', envObj))}>{busy === 'Deny all' ? <><Spinner /> Denying all…</> : 'Keep all denied'}</button>
                  <span class="mono small muted" style={{ marginLeft: 'auto' }}>$ ai-sdlc-helper permit {slug} denied:all allow</span>
                </div>
              </div>
            </Panel>
          )}

          {v.state === 'paused' && !v.questions.length && !v.permissions.length && (
            <div class="banner">Paused at {v.stage || 'the start'} with nothing left to answer or decide: press {startLabel} to continue.</div>
          )}

          {showTestIssues(v) && (
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
                    onClick={() => launch('Save & Resume Test repair', async () => {
                      const text = issuesDraft !== null ? issuesDraft : (v.testIssues || '');
                      const r = await api.saveTestIssues(project, slug, text, true, envObj);
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
                    onClick={() => launch('Resume at Test repair', () => startRun('test-repair', envObj))}
                  >
                    {busy === 'Resume at Test repair' ? <><Spinner /> Resuming…</> : 'Resume at Test repair'}
                  </button>
                </div>
              </div>
            </Panel>
          )}

          {v.state === 'ready' && (
            <Panel title={<span class="s-ready">Ready to retry</span>}>
              <p class="pb" id="discarded-stage" style={{ margin: 0 }}>
                {v.discardedStage?.stage || STAGES.find(s => s.key === v.resumeFrom)?.name || 'The last stage'} was discarded{v.discardedStage?.at ? ` at ${v.discardedStage.at.replace('T', ' ')}` : ''}. Its files are gone; the stages before it are kept. {startLabel} to run it again.
              </p>
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
                  {v.prDraft === true && v.prState !== 'MERGED' && (
                    <span class="tag small mono s-running" title="This pull request is still a draft; it can be marked ready for review">Draft PR</span>
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
                      title="Ask GitHub now for the PR's state, its CI status and its review comments"
                      onClick={() => act('Sync PR', async () => {
                        const r = await api.syncPr(project, slug);
                        toast(r.ok ? `PR ${r.pr.isDraft ? 'is a draft' : r.pr.state ? `is ${r.pr.state.toLowerCase()}` : 'status unknown'}${r.pr.ci && r.pr.ci !== 'none' ? `, CI ${r.pr.ci}` : ''}${r.pr.conflicts === 'conflicting' ? ', conflicts with the base' : ''}; ${r.count} comment(s)${r.notes?.length ? `; ${r.notes.join('; ')}` : ''}${r.err?.length ? `; ${r.err.join(' ')}` : ''}` : `Sync failed: ${(r.err || []).join(' ')}`);
                        return {};
                      })}
                    >
                      {busy === 'Sync PR' ? <><Spinner /> {syncLabel || 'Syncing'}…</> : 'Sync PR'}
                    </button>
                    {v.prDraft === true && v.prState !== 'MERGED' && (
                      <button
                        class="btn btn-s btn-p"
                        type="button"
                        disabled={running || !!busy}
                        title="Turn this draft pull request into one that is ready for review"
                        onClick={() => act('Mark PR ready for review', async () => {
                          const r = await api.markPrReady(project, slug);
                          if (r.ok) toast(`Pull request${r.pr.number ? ` #${r.pr.number}` : ''} is ready for review${r.count ? `; ${r.count} comment(s)` : ''}${r.err?.length ? `; ${r.err.join(' ')}` : ''}`);
                          return { ok: r.ok, err: r.err };
                        })}
                      >
                        {busy === 'Mark PR ready for review' ? <><Spinner /> Marking…</> : 'Mark as Ready for review'}
                      </button>
                    )}
                    <a href={v.pr} target="_blank" rel="noreferrer" class="btn btn-s" style={{ textDecoration: 'none' }}>
                      Open on GitHub ↗
                    </a>
                  </div>
                ) : null
              }
            >
              <div class="pb col" style={{ gap: '10px' }}>
                {v.pr ? (
                  <div class={showResolve ? 'pr-split' : ''}>
                  <div class="col" style={{ gap: '6px' }}>
                    <div class="row" style={{ gap: '8px', alignItems: 'center' }}>
                      <span class="muted small">Link:</span>
                      <a href={v.pr} target="_blank" rel="noreferrer" class="mono s-done" style={{ textDecoration: 'underline' }}>
                        {v.pr}
                      </a>
                    </div>
                    {v.prState === 'OPEN' && (
                      <PrCi
                        ci={v.prCi}
                        failing={v.prFailing || []}
                        summary={v.ciSummary || []}
                        conflicts={v.prConflicts}
                        busy={busy === 'Restart Implement with the CI failure'}
                        disabled={running}
                        onFix={() => launch('Restart Implement with the CI failure', async () => {
                          const f = await api.ciFix(project, slug, envObj);
                          toast(`${f.resumed.ok ? 'Implement restarted with the CI failure' : (f.resumed.err.join(' ') || 'Could not start Implement')}${f.err?.length ? `; ${f.err.join(' ')}` : ''}`);
                          return {};
                        })}
                      />
                    )}
                    {v.prState === 'OPEN' && v.prDraft === true && (
                      <div class="banner">
                        This pull request is a <strong>Draft PR</strong>: it is not ready for review yet. Use <strong>Mark as Ready for review</strong> above when it is.
                      </div>
                    )}
                    {v.prState === 'OPEN' && v.prDraft !== true && (
                      <div class="banner">
                        Pull Request is open. Task will automatically move to <strong>Completed</strong> once this PR is merged on GitHub.
                      </div>
                    )}
                    {v.prState === 'MERGED' && (
                      <div class="banner banner-ok s-done">
                        ✔ Pull Request is merged into base!
                      </div>
                    )}
                    {v.prState !== 'MERGED' && v.hasPrComments && (
                      <div class="row" style={{ gap: '8px', alignItems: 'center', marginTop: '4px', flexWrap: 'wrap' }}>
                        {v.hasPrComments && (
                          <>
                            <button class="btn btn-s" type="button" onClick={() => openFile('pr-comments.md')}>
                              View PR Comments (pr-comments.md)
                            </button>
                            <button
                              class="btn btn-s btn-p"
                              type="button"
                              disabled={running || !!busy}
                              onClick={() => launch('Resume to fix PR comments', () => startRun('implement', envObj))}
                            >
                              {busy === 'Resume to fix PR comments' ? <><Spinner /> Resuming…</> : 'Resume at Implement to fix PR comments'}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {showResolve && (
                    <section class="col resolve-block" aria-label="Resolve conflicts" style={{ gap: '8px' }}>
                      <strong class={STAGE_CLASS[rcState]}>{rcState === 'active' ? <Spinner /> : STAGE_GLYPH[rcState]} Resolve conflicts</strong>
                      <span class="small muted">
                        {v.prConflicts === 'conflicting' ? 'This PR conflicts with the base.' : 'Brings the branch up to date with the base.'} The agent rebases the branch, resolves the conflicts, runs the checks and pushes with --force-with-lease.
                      </span>
                      <div class="col" style={{ gap: '4px' }}>
                        <span class="small muted">Agent · model · effort</span>
                        {running ? <span class="row small" style={{ gap: '4px', alignItems: 'center' }}>{overrideBadge}<span class="mono small muted">{v.models['resolve-conflicts'] ? `${v.models['resolve-conflicts'].model} · ${v.models['resolve-conflicts'].effort}` : 'default'}{rcState === 'active' ? ' · in use' : ''}</span></span> : stagePickers({ key: 'resolve-conflicts', name: 'Resolve conflicts' })}
                      </div>
                      <details class="small"><summary style={{ cursor: 'pointer' }}>Reviewers when the agent is unsure</summary><div style={{ marginTop: '6px' }}>{reviewerConfig()}</div></details>
                      <div class="row" style={{ gap: '8px', alignItems: 'center' }}>
                        <button
                          class="btn btn-s btn-p"
                          type="button"
                          disabled={running || !!busy}
                          title="Fetch the base, rebase this run's branch onto it, resolve the conflicts and push with --force-with-lease"
                          onClick={() => launch('Resolve conflicts', () => startRun('resolve-conflicts', envObj))}
                        >
                          {busy === 'Resolve conflicts' ? <><Spinner /> Starting…</> : rcState === 'failed' || rcState === 'paused' ? 'Resolve conflicts again' : 'Resolve conflicts'}
                        </button>
                        {rcState === 'active' && <span class="small s-running"><Spinner /> Resolving…</span>}
                        {v.mergeFix && !running && (
                          <button
                            class="btn btn-s btn-p"
                            type="button"
                            disabled={!!busy}
                            title="The merge was fixed but its tests fail. The agent repairs the merged result with the failing tests as context; Test repair and Review still apply, and the result is checked and pushed with the lease at the end."
                            onClick={() => launch('Fix merged result', () => startRun('implement', { ...envObj, SDLC_ON_ATTEMPT: '1' }))}
                          >
                            {busy === 'Fix merged result' ? <><Spinner /> Starting…</> : 'Fix with Implement'}
                          </button>
                        )}
                        {v.docs.includes('logs/resolve-conflicts.md') && <button class="btn btn-s" type="button" onClick={() => openFile('logs/resolve-conflicts.md')} title="What the last attempt did, in plain words">Open last report</button>}
                      </div>
                    </section>
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

          {v.ci && ciRounds(v.tail).length > 0 && (
            <Panel title="Implement rounds (full suite in CI)">
              <div class="pb col" style={{ gap: '8px' }}>
                {ciRounds(v.tail).map(block => (
                  <pre class="code mono" style={{ borderRadius: '6px', margin: 0 }}>{block.join('\n')}</pre>
                ))}
              </div>
            </Panel>
          )}

          {v.state !== 'not started' && (
            <OutputPanel tail={v.tail} extra={<div class="row"><span class="mono small muted">logs/run.out</span><CopyButton text={v.tail.join('\n')} /><button class="btn btn-s" type="button" onClick={() => openFile('logs/run.out')}>Whole file</button></div>} />
          )}
        </div>

        <div class="side col">
          <Panel title="This run">
            <dl class="facts pb">
              <dt class="muted">State</dt><dd class={stateClass(v.state)}>{v.state === 'running' ? <Spinner /> : GLYPH[v.state]} {v.state}</dd>
              {v.agent && <><dt class="muted">Agent</dt><dd class="mono">{v.agent} {v.model && `· ${v.model} · ${v.effort}`}</dd></>}
              <dt class="muted">Files</dt><dd>{v.changes ? `${v.changes.changed} changed · ${v.changes.uncommitted} uncommitted` : '—'}{staleLabel(v.gitAgeMs) && <span class="muted small" title="Counted from git when the stage last changed; the server re-reads it at each stage change"> · may be stale, {staleLabel(v.gitAgeMs)} <a href="#" onClick={(e: Event) => { e.preventDefault(); load(true); }}>refresh</a></span>}</dd>
              <dt class="muted">Tests</dt><dd>{v.tests ? `${v.tests.passed} passed · ${v.tests.failed} failing · ${v.tests.total} total` : 'not run yet'}</dd>
              {v.worktree && <><dt class="muted">Worktree</dt><dd class="mono">{v.worktree}</dd></>}
              {v.updated && <><dt class="muted">Updated</dt><dd>{v.updated}</dd></>}
              {hasUsage(v.timeline?.usage) && <><dt class="muted">Cost</dt><dd>{usageText(v.timeline!.usage)} · {v.timeline!.usage.rounds} agent round{v.timeline!.usage.rounds === 1 ? '' : 's'}</dd></>}
            </dl>
          </Panel>

          <UsagePanel timeline={v.timeline} />

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
              {limitError && <span class="small s-failed" role="alert">{REVIEW_LIMIT_ENV} {REVIEW_LIMIT_REQUIREMENT}</span>}
              {env.map(([k, val], i) => (
                <div class="row" style={{ flexWrap: 'nowrap' }}>
                  <input class="inp mono" aria-label="Name" value={k} placeholder="NAME" onInput={e => setEnv(rows => rows.map((r, j) => (j === i ? [(e.target as HTMLInputElement).value, r[1]] : r)))} />
                  <input class="inp mono" aria-label="Value" value={val} placeholder="value" onInput={e => setEnv(rows => rows.map((r, j) => (j === i ? [r[0], (e.target as HTMLInputElement).value] : r)))} />
                  <button class="btn btn-s" type="button" aria-label={`Remove ${k}`} onClick={() => setEnv(rows => rows.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <div class="row">
                <button class="btn btn-s" type="button" onClick={() => setEnv(rows => [...rows, ['', '']])}>Add variable</button>
                {quickKeys(env, ['SDLC_AUTO_ACCEPT', 'SDLC_BASE', 'SDLC_LIMIT_RETRY', 'SDLC_LIMIT_MAX_WAIT', 'SDLC_DEP_SCRIPTS', 'SDLC_ALLOW_MERGED']).map(k => <button class="btn btn-s" type="button" onClick={() => setEnv(rows => addEnvKey(rows, k, k === 'SDLC_AUTO_ACCEPT' ? '1' : ''))}>{k}</button>)}
              </div>
            </div>
          </Panel>

          {(v.reviewRounds?.length || 0) > 0 && (
            <Panel title="Review rounds" extra={<span class="mono small muted">logs/review-rounds.json</span>}>
              <div class="pb col" style={{ gap: '8px' }}>
                {v.reviewRounds!.map(r => (
                  <details open={r.verdict === 'changes'}>
                    <summary>
                      Round {r.round}: <strong class={r.verdict === 'pass' ? 's-done' : 's-failed'}>{r.verdict === 'pass' ? 'pass' : `${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}`}</strong> <span class="small muted">{r.outcome}</span>
                    </summary>
                    <ul class="small" style={{ margin: '4px 0', paddingLeft: '18px' }}>
                      {r.findings.map(f => <li><span class="mono">{f.file}</span> {f.kind === 'missing-test' ? '(missing test) ' : ''}{f.criterion}: {f.reason} <span class="muted">[{f.status}]</span></li>)}
                    </ul>
                  </details>
                ))}
              </div>
            </Panel>
          )}

          {(v.attempts?.length || 0) > 0 && (
            <Panel title="Agent rounds" extra={<span class="mono small muted">logs/attempts.jsonl</span>}>
              <div class="pb col" style={{ gap: '8px' }}>
                {v.attempts!.map(r => {
                  const warnings = [...r.warnings, ...(r.gate?.warnings || [])];
                  return (
                    <details open={warnings.length > 0}>
                      <summary>
                        <span class="mono">{r.agent}</span> <span class="muted">{r.stage}</span>
                        {r.running && <span class="small"> <Spinner /> running since {r.at.slice(11)}</span>}
                        {!r.running && <>{' '}<span class="small muted">{r.durationSec === null ? '?' : Math.round(r.durationSec)}s · {r.turns ?? '?'} turns · {r.filesChanged.length} files{r.gate ? ` · ${r.gate.failing.length} failing` : ''}</span></>}
                        {warnings.length > 0 && <span class="small" style={{ color: 'var(--bad, #d33)' }}> · {warnings.length} warning{warnings.length > 1 ? 's' : ''}</span>}
                      </summary>
                      {warnings.length > 0 && <ul class="small" style={{ margin: '4px 0', paddingLeft: '18px' }}>{warnings.map(w => <li>{w}</li>)}</ul>}
                      {r.filesChanged.length > 0 && <div class="mono small muted">changed: {r.filesChanged.join(', ')}</div>}
                    </details>
                  );
                })}
              </div>
            </Panel>
          )}

          {Object.keys(v.stageFiles).length > 0 && (
            <Panel title="Files changed per stage">
              <div class="pb col" style={{ gap: '8px' }}>
                {Object.entries(v.stageFiles).map(([name, files]) => {
                  const tree = buildDocTree(files);
                  return (
                    <details key={name}>
                      <summary>{name} <span class="muted">({files.length})</span></summary>
                      <div style={{ paddingTop: '4px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        {tree.map(node => (
                          <DocTreeNodeView
                            key={node.path}
                            node={node}
                            isDirOpen={dir => isStageDirOpen(stageDirs, name, dir)}
                            onToggleDir={(dir, open) => setStageDirs(prev => (open === isStageDirOpen(prev, name, dir) ? prev : recordStageDir(prev, name, dir.path, open)))}
                          />
                        ))}
                        {!tree.length && <span class="muted small">No files changed.</span>}
                      </div>
                    </details>
                  );
                })}
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
                  isDirOpen={dir => openDirs[dir.path] ?? defaultDirOpen(dir)}
                  onToggleDir={(dir, open) => setOpenDirs(prev => (prev[dir.path] === open ? prev : { ...prev, [dir.path]: open }))}
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
            <div class="ph">
              <span class="mono">{file.path}</span>
              <div class="row">
                {isMarkdownPath(file.path) && (
                  <div class="segs" role="group" aria-label="File view">
                    <button class={`seg${fileView === 'rendered' ? ' seg-on' : ''}`} type="button" aria-pressed={fileView === 'rendered'} onClick={() => setFileView('rendered')}>Rendered</button>
                    <button class={`seg${fileView === 'source' ? ' seg-on' : ''}`} type="button" aria-pressed={fileView === 'source'} onClick={() => setFileView('source')}>Source</button>
                  </div>
                )}
                <CopyButton text={file.text} /><button class="btn btn-s" type="button" onClick={() => setFile(null)}>Close</button>
              </div>
            </div>
            {isMarkdownPath(file.path) && fileView === 'rendered'
              ? <div class="file-md"><Markdown text={file.text} /></div>
              : <pre class="code mono">{file.text}</pre>}
            <p class="small muted pb" style={{ margin: 0 }}>Read-only here; editing files in place comes with phase 2. Edit it in the worktree meanwhile.</p>
          </div>
        </div>
      )}

      {forceAsk && (() => {
        const after = forceAfter(forceAsk);
        const part = (label: string, value: string, fallback: string) => value ? `${label} ${value}` : `${label}: ${fallback}`;
        const combo = [
          part('agent', after.SDLC_FORCE_AGENT || '', "project's"),
          part('model', after.SDLC_FORCE_MODEL || '', 'per stage'),
          part('effort', after.SDLC_FORCE_EFFORT || '', 'per stage'),
        ].join(', ');
        const pendingLabel = forceAsk.key === 'SDLC_FORCE_AGENT' ? 'agent' : forceAsk.key === 'SDLC_FORCE_MODEL' ? 'model' : 'effort';
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setForceAsk(null)}>
            <div role="dialog" aria-modal="true" aria-label="Confirm run-level override" class="col" onClick={e => e.stopPropagation()}
              style={{ background: 'var(--bg, #17181c)', border: '1px solid var(--ln, #262d36)', borderRadius: '10px', padding: '18px', maxWidth: '480px', width: '92%', gap: '10px' }}>
              <strong>Override every stage of this run?</strong>
              <p class="small" style={{ margin: 0 }}>
                You picked {pendingLabel} <span class="mono">{forceAsk.value}</span> for <strong>“This run, every stage”</strong>.
                With it, the run becomes: <span class="mono">{combo}</span>.
              </p>
              <p class="small s-failed" style={{ margin: 0 }}>
                This replaces the project's per-stage setup (sdlc.config.json) for every stage — Spec, Plan, Red tests,
                Implement, Test repair, Review, Finalise, and the conflict reviewers and judge. A model your provider
                account cannot serve (for example a paid model without credits) fails the run. The setting stays for
                future starts of this run until you clear it.
              </p>
              <div class="row" style={{ gap: '8px', justifyContent: 'flex-end' }}>
                <button class="btn" type="button" onClick={() => setForceAsk(null)}>Cancel</button>
                <button class="btn btn-d" type="button" onClick={() => applyForce(forceAsk.key, forceAsk.value)}>Apply to every stage</button>
              </div>
            </div>
          </div>
        );
      })()}

      {resumeAsk && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setResumeAsk(null)}>
          <div role="dialog" aria-modal="true" aria-label="Confirm resume stage" class="col" onClick={e => e.stopPropagation()}
            style={{ background: 'var(--bg, #17181c)', border: '1px solid var(--ln, #262d36)', borderRadius: '10px', padding: '18px', maxWidth: '480px', width: '92%', gap: '10px' }}>
            <strong>Resume at {resumeAsk.name}?</strong>
            <p class="small" style={{ margin: 0 }}>
              This will resume the run on branch <span class="mono">{v.branch}</span> starting from <strong>{resumeAsk.name}</strong> (<span class="mono">{resumeCommand(slug, resumeAsk.key)}</span>).
            </p>
            <p class="small" style={{ margin: 0 }}>
              Existing red tests{v.redCommit ? <> (<span class="mono">{v.redCommit}</span>)</> : ''} and commits are kept. The <strong>Red tests</strong> stage will analyse existing red tests against the current spec and plan, keep valid tests, or add new failing tests to expand coverage.
            </p>
            <div class="row" style={{ gap: '8px', justifyContent: 'flex-end' }}>
              <button class="btn" type="button" onClick={() => setResumeAsk(null)}>Cancel</button>
              <button class="btn btn-p" type="button" id="confirm-resume-go" disabled={!!busy || running} onClick={() => {
                const { key, name } = resumeAsk;
                setResumeAsk(null);
                launch(`Resume at ${name}`, async () => { const o = await startRun(key, envObj, noteToSend(note)); setPicking(false); setNote(''); return o; });
              }}>Confirm resume at {resumeAsk.name}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
