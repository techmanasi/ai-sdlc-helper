// The board: the backlog and one column per stage, live from the server's event stream; tick items and run them.
import { useEffect, useState } from 'preact/hooks';
import { api, type Board as BoardData, type RunCard, type RunView } from './api';
import { usePoll } from './usePoll';
import { useSyncLabel } from './useSyncLabel';
import { useStream } from './useStream';
import { applyRunEvent } from './stream';
import { awaitsMerge } from './stages';
import { PIPELINE, boardCost, stageName, stripStates } from './insights';
import { PrCi } from './PrCi';
import { Cli, ErrorBox, GLYPH, Notices, Panel, PrIcon, Spinner, stateClass, useApp } from './ui';

export const COLUMNS = ['Backlog', 'Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Finalise'];

/** The column a run's card sits in: its stage; Finalise when done, committing, finalising or resolving conflicts; Backlog before any stage. */
export function columnOf(r: RunCard): string {
  if (r.state === 'done' || r.stage === 'Finalise' || r.stage === '6/6 Finalise' || r.stage === 'Resolve conflicts') return 'Finalise';
  return COLUMNS.includes(r.stage) ? r.stage : 'Backlog';
}

const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null);

export const needsYou = (r: RunCard) => r.state === 'paused' || r.state === 'ready' || r.questions > 0 || r.permissions > 0;

/** One run on the board: its name, the stages as a strip, where it is, its state, its pull request. */
function RunCardView({ r, on, select, onRefresh }: { r: RunCard; on: boolean; select(): void; onRefresh(): void }) {
  const { go, project, toast } = useApp();
  const [syncing, setSyncing] = useState(false);
  const syncLabel = useSyncLabel(syncing, project, r.slug);
  const [marking, setMarking] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const resolve = async () => {
    setResolving(true);
    try {
      const o = await api.start(project, r.slug, 'resolve-conflicts');
      toast(o.ok ? `${r.slug}: resolving conflicts` : `${r.slug}: ${o.err.join(' ') || 'could not start'}`);
    } catch (e) { toast(`${r.slug}: ${e instanceof Error ? e.message : String(e)}`); } finally { setResolving(false); }
  };
  const [summary, setSummary] = useState<string[]>([]);
  const fix = async () => {
    setFixing(true);
    try {
      const f = await api.ciFix(project, r.slug);
      toast(f.resumed.ok ? `${r.slug}: Implement restarted with the CI failure` : `${r.slug}: ${f.resumed.err.join(' ') || 'could not start'}`);
    } catch (e) { toast(`${r.slug}: ${e instanceof Error ? e.message : String(e)}`); } finally { setFixing(false); }
  };
  const sync = async () => {
    setSyncing(true);
    try {
      const sync = await api.syncPr(project, r.slug);
      setSummary(sync.summary);
      const { pr } = sync;
      toast(pr.state ? `${r.slug}: PR ${pr.number ? `#${pr.number} ` : ''}is ${pr.isDraft ? 'a draft' : pr.state.toLowerCase()}${pr.ci && pr.ci !== 'none' ? `, CI ${pr.ci}` : ''}${pr.conflicts === 'conflicting' ? ', conflicts with the base' : ''}; ${sync.count} comment(s)${sync.notes?.length ? `; ${sync.notes.join('; ')}` : ''}${sync.err?.length ? `; ${sync.err.join(' ')}` : ''}` : `${r.slug}: no PR status (GitHub did not answer)${sync.err?.length ? `; ${sync.err.join(' ')}` : ''}`);
      onRefresh();
    } catch (e) { toast(`${r.slug}: ${e instanceof Error ? e.message : String(e)}`); } finally { setSyncing(false); }
  };
  const markReady = async () => {
    setMarking(true);
    try {
      const m = await api.markPrReady(project, r.slug);
      toast(m.ok ? `${r.slug}: PR ready for review${m.err?.length ? `; ${m.err.join(' ')}` : ''}` : `${r.slug}: could not mark the PR ready: ${(m.err || []).join(' ')}`);
      onRefresh();
    } catch (e) { toast(`${r.slug}: ${e instanceof Error ? e.message : String(e)}`); } finally { setMarking(false); }
  };
  const waiting = awaitsMerge(r);
  const what = r.questions ? `${r.questions} question${r.questions > 1 ? 's' : ''} to answer`
    : r.permissions ? `${r.permissions} refused action${r.permissions > 1 ? 's' : ''} to decide`
      : r.deniedPermissions ? `${r.deniedPermissions} denied permission${r.deniedPermissions > 1 ? 's' : ''}`
        : r.note || r.message || '';
  const stage = stageName(r.stage);
  const where = waiting ? (r.pullRequest?.state === 'CLOSED' ? 'PR closed without merging' : r.pullRequest?.state === 'OPEN' ? 'Waiting for the PR to be merged' : r.pullRequest?.url ? 'Checking the PR…' : 'All stages done · no pull request yet')
    : r.state === 'running' ? [stage || 'Starting', r.attempt && `iteration ${r.attempt}`].filter(Boolean).join(' · ')
      : r.state === 'paused' ? `Paused at ${stage || 'the start'}` : r.state === 'done' ? 'All stages done' : r.state === 'not started' ? 'Not started' : `${r.state[0].toUpperCase()}${r.state.slice(1)} at ${stage || 'the start'}`;
  // A finished run whose pull request is not known to be open says "done", not "PR open".
  const prOpen = waiting && r.pullRequest?.state === 'OPEN';
  const label = prOpen ? 'PR open' : waiting && r.pullRequest?.state === 'CLOSED' ? 'PR closed' : needsYou(r) ? 'Needs you' : r.state;
  const chip = prOpen || (waiting && r.pullRequest?.state === 'CLOSED') ? 'paused' : r.state.replace(' ', '-');
  const open = (e: Event) => { e.preventDefault(); go(`/run/${r.slug}`); };
  return (
    <div class={`brow ${on ? 'brow-on' : ''} ${needsYou(r) ? 'brow-need' : ['failed', 'stopped', 'refused'].includes(r.state) ? 'brow-bad' : ''}`}>
      <span aria-hidden="true" class={waiting ? 's-pr' : stateClass(r.state)}>{r.state === 'running' ? <Spinner /> : waiting ? <PrIcon title="Pull request not merged yet" /> : GLYPH[r.state]}</span>
      <button type="button" class="brow-open" onClick={select} aria-pressed={on} title="Show the latest output here">
        <span class="brow-slug">{r.slug}</span>
        <span class="brow-sub mono">{[r.branch, r.model && `${r.model} · ${r.effort}`].filter(Boolean).join(' · ') || '—'}</span>
      </button>
      <div class="b-stages col" style={{ gap: '5px', minWidth: 0 }}>
        <span class="strip" role="img" aria-label={`${stripStates(r).filter(x => x === 'done').length} of ${PIPELINE.length} stages done`}>{stripStates(r).map(x => <i class={`st-${x}`} />)}</span>
        <span class="brow-sub" title={what || where}>{where}{what ? ` · ${what}` : r.tests ? ` · tests ${r.tests.passed}/${r.tests.total}` : ''}</span>
      </div>
      <span><span class={`chip chip-${chip}`}>{label}</span></span>
      <div class="b-pr col small" style={{ gap: '4px', minWidth: 0 }}>
        {r.pullRequest?.url
          ? <span class="mono"><a href={r.pullRequest.url} target="_blank" rel="noreferrer">{r.pullRequest.number ? `#${r.pullRequest.number}` : 'PR'}</a>{r.pullRequest.state ? ` ${r.pullRequest.isDraft ? 'draft PR' : r.pullRequest.state.toLowerCase()}` : ''}{r.pullRequest.failed ? ' · last check failed' : ''}</span>
          : <span class="muted">{r.state === 'done' ? 'no PR' : r.changes ? `${r.changes.changed} files` : '—'}</span>}
        {r.state === 'done' && r.pullRequest?.isDraft === true && r.pullRequest.state !== 'MERGED' && (
          <button type="button" class="btn btn-xs btn-p" disabled={marking} onClick={markReady} title="Mark this draft pull request as ready for review">{marking ? 'Marking…' : 'Mark ready'}</button>
        )}
        {r.state === 'done' && r.pullRequest?.state === 'OPEN' && <PrCi ci={r.pullRequest.ci} failing={r.pullRequest.failing} summary={summary} busy={fixing} onFix={fix} conflicts={r.pullRequest.conflicts} resolveBusy={resolving} onResolve={resolve} />}
      </div>
      <RunCost r={r} />
      <div class="brow-acts">
        {r.state === 'done' && <button type="button" class="btn btn-xs" disabled={syncing} onClick={sync} title={`Ask GitHub now for this PR's state, CI status and review comments (checked once an hour otherwise)${r.pullRequest?.checkedAt ? `; last checked ${clock(r.pullRequest.checkedAt)}` : ''}`}>{syncing ? <><Spinner /> {syncLabel || 'Syncing'}…</> : 'Sync PR'}</button>}
        <a class={`btn btn-xs ${needsYou(r) ? 'btn-p' : ''}`} href={`#/run/${r.slug}`} onClick={open}>{r.questions ? 'Answer' : r.permissions ? 'Decide' : 'Open'}</a>
      </div>
    </div>
  );
}

/** The Cost column: the run's cost so far (≈ for an estimate) over its tokens. */
function RunCost({ r }: { r: RunCard }) {
  const c = boardCost(r.usage);
  if (!c) return <span class="b-cost muted small">—</span>;
  return (
    <span class="b-cost col" title="Cost and tokens of every start of this item so far (the run page's Cost and tokens panel)">
      <span class="b-cost-usd">{c.cost}</span>
      {c.tokens && <span class="brow-sub">{c.tokens}</span>}
    </span>
  );
}

function Drawer({ slug }: { slug: string }) {
  const { project, go } = useApp();
  const [v, setV] = useState<RunView | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.run(project, slug, { parts: 'live,tail' }).then(x => { if (live) setV(x); }).catch(() => {});
    load();
    return () => { live = false; };
  }, [project, slug]);
  const streaming = v?.state === 'running' || v?.state === 'paused';
  const reload = () => api.run(project, slug, { parts: 'live,tail' }).then(x => setV(x)).catch(() => {});
  usePoll(reload, v?.state, `${project}/${slug}`, streaming);
  useStream({
    url: streaming ? api.runEventsUrl(project, slug) : null,
    on: { snapshot: d => setV(p => applyRunEvent(p, 'snapshot', d)), run: d => setV(p => applyRunEvent(p, 'run', d)), tail: d => setV(p => applyRunEvent(p, 'tail', d)) },
    poll: reload,
  });
  if (!v) return null;
  return (
    <Panel
      title={<span class="mono"><span class={stateClass(v.state)}>{v.state === 'running' ? <Spinner /> : GLYPH[v.state]}</span> {v.slug} <span class="muted small">{[v.stage, v.attempt && (v.state === 'running' ? `running iteration ${v.attempt}` : `iteration ${v.attempt}`), v.model && `${v.model} · ${v.effort}`, v.note].filter(Boolean).join(' · ')}</span></span>}
      extra={<a class="btn btn-s" href={`#/run/${slug}`} onClick={e => { e.preventDefault(); go(`/run/${slug}`); }}>Open run</a>}
    >
      <pre class="code mono" style={{ borderRadius: '0 0 8px 8px', maxHeight: '220px', overflowY: 'auto' }}>{v.tail.slice(-12).join('\n') || 'No output yet.'}</pre>
    </Panel>
  );
}

export function Board({ board, error, onRefresh }: { board: BoardData | null; error: string; onRefresh(): void }) {
  const { project, go, toast } = useApp();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState<'all' | 'running' | 'needs' | 'failed'>('all');
  if (!board) {
    return (
      <div class="col">
        <h1>Board</h1>
        {error ? <ErrorBox error={error} /> : <><div class="skel" style={{ height: '44px' }} /><div class="skel" style={{ height: '260px' }} /><span class="sr" role="status">Loading the board</span></>}
      </div>
    );
  }

  const f = filter.trim().toLowerCase();
  const match = (...s: (string | null)[]) => !f || s.some(x => x && x.toLowerCase().includes(f));
  const runSlugs = new Set(board.runs.map(r => r.slug));
  const isFailed = (r: RunCard) => ['failed', 'stopped', 'refused', 'interrupted'].includes(r.state);
  const shown = (r: RunCard) => show === 'all' || (show === 'running' && r.state === 'running') || (show === 'needs' && needsYou(r)) || (show === 'failed' && isFailed(r));
  const items = show === 'all' ? (board.items || []).filter(i => !runSlugs.has(i.slug) && (showDone || i.status !== 'completed') && match(i.slug, i.title, i.type)) : [];
  const live = board.runs.filter(r => showDone || r.state !== 'done' || awaitsMerge(r));
  const rank = (r: RunCard) => (needsYou(r) ? 0 : isFailed(r) ? 1 : r.state === 'running' ? 2 : 3);
  const runs = live.filter(r => shown(r) && match(r.slug, r.stage, r.state, r.model)).sort((a, b) => rank(a) - rank(b));
  const chosen = Object.keys(picked).filter(k => picked[k]);
  const waiting = board.runs.filter(needsYou);
  const count = { all: live.length + (board.items || []).filter(i => !runSlugs.has(i.slug) && i.status !== 'completed').length, running: live.filter(r => r.state === 'running').length, needs: waiting.length, failed: live.filter(isFailed).length };

  const runSelected = async () => {
    setBusy(true);
    for (const slug of chosen) {
      try {
        const o = await api.start(project, slug);
        toast(o.ok ? `Started ${slug}` : `${slug}: ${o.err.join(' ')}`);
      } catch (e) { toast(`${slug}: ${(e as Error).message}`); }
    }
    setPicked({});
    setBusy(false);
  };

  return (
    <div class="col">
      {waiting.length > 0 && (
        <section class="banner" aria-label="Action needed">
          <strong class="s-paused">⏸ Action needed · {waiting.length} run{waiting.length > 1 ? 's' : ''} waiting for you</strong>
          <div class="row" style={{ gap: '8px 20px' }}>
            {waiting.map(r => (
              <span class="row" key={r.slug}>
                <span><span class="mono">{r.slug}</span> · {r.stage || 'start'} · {r.questions ? `${r.questions} questions` : r.permissions ? `${r.permissions} refused actions` : 'paused'}</span>
                <a class="btn btn-s" href={`#/run/${r.slug}`} onClick={e => { e.preventDefault(); go(`/run/${r.slug}`); }}>{r.questions ? 'Answer' : r.permissions ? 'Decide' : 'Open'}</a>
              </span>
            ))}
          </div>
        </section>
      )}
      <div class="row">
        <div class="grow">
          <h1>Board</h1>
          <span class="small muted">How it works: tests are written first and locked, each stage is checked before the next, each item gets its own worktree and ends as a pull request</span>
        </div>
        <div class="segs" role="group" aria-label="Show">
          {([['all', 'All'], ['running', 'Running'], ['needs', 'Needs you'], ['failed', 'Failed']] as const).map(([k, l]) => (
            <button type="button" class={`seg ${show === k ? 'seg-on' : ''}`} aria-pressed={show === k} onClick={() => setShow(k)}>{l} {count[k]}</button>
          ))}
        </div>
        <a class="btn" href="#/new" onClick={e => { e.preventDefault(); go('/new'); }}>New item</a>
        <button class="btn btn-p" type="button" disabled={!chosen.length || busy} onClick={runSelected}>{busy ? <><Spinner /> Starting…</> : `Run selected (${chosen.length})`}</button>
      </div>
      <div class="row">
        <label class="sr" for="flt">Filter</label>
        <input id="flt" class="inp" style={{ width: '320px', maxWidth: '100%' }} placeholder="Filter by name, stage, state, model…" value={filter} onInput={e => setFilter((e.target as HTMLInputElement).value)} />
        <label class="row small"><input type="checkbox" checked={showDone} onChange={e => setShowDone((e.target as HTMLInputElement).checked)} /> Show done</label>
        <span class="tag">{board.running} / {board.maxParallel} running</span>
      </div>
      <ErrorBox error={error} />
      <Notices project={project} notices={board.notices} />
      {board.items === null && <div class="banner">This project has no backlog index yet. <a href="#/new" onClick={e => { e.preventDefault(); go('/new'); }}>Write the first item</a>; it creates the index.</div>}
      {chosen.length > 0 && <Cli commands={chosen.map(s => ['start', s])} />}
      <section class="pn blist" aria-label="Items">
        <div class="bhead lbl"><span /><span>Item</span><span>Stages</span><span>Status</span><span>Pull request</span><span>Cost</span><span /></div>
        {runs.map(r => <RunCardView key={r.slug} r={r} on={selected === r.slug} select={() => setSelected(s => (s === r.slug ? '' : r.slug))} onRefresh={onRefresh} />)}
        {items.map(i => (
          <div class={`brow ${picked[i.slug] ? 'brow-on' : ''}`} key={i.slug}>
            <input type="checkbox" aria-label={`Select ${i.slug}`} checked={!!picked[i.slug]} disabled={i.status === 'completed' || !i.hasBrief} title={i.hasBrief ? undefined : 'This item has no brief.md yet'} onChange={e => setPicked(m => ({ ...m, [i.slug]: (e.target as HTMLInputElement).checked }))} />
            <a class="brow-open" href={`#/run/${i.slug}`} onClick={e => { e.preventDefault(); go(`/run/${i.slug}`); }}>
              <span class="brow-slug">{i.slug}</span>
              <span class="brow-sub">{[i.type, i.priority, i.title].filter(Boolean).join(' · ')}</span>
            </a>
            <div class="b-stages col" style={{ gap: '5px', minWidth: 0 }}>
              <span class="strip" aria-hidden="true">{PIPELINE.map(() => <i />)}</span>
              <span class={`brow-sub ${i.note ? 's-paused' : ''}`}>{i.note || (i.status === 'completed' ? 'Completed' : 'In the backlog')}</span>
            </div>
            <span><span class="chip chip-pending">{i.status === 'completed' ? 'completed' : 'not started'}</span></span>
            <span class="b-pr muted small">—</span>
            <span class="b-cost muted small">—</span>
            <div class="brow-acts">
              <a class="btn btn-xs" href={`#/edit/board/${i.slug}`} onClick={e => { e.preventDefault(); go(`/edit/board/${i.slug}`); }}>Edit</a>
            </div>
          </div>
        ))}
        {!runs.length && !items.length && (
          <div class="empty">
            <strong>{f || show !== 'all' ? 'Nothing matches' : 'Nothing on the board yet'}</strong>
            <span class="small">{f || show !== 'all' ? 'Clear the filter to see every item.' : 'Write a backlog item, tick it, and run it: the pipeline writes the tests first, then the code.'}</span>
            {!f && show === 'all' && <a class="btn btn-p" href="#/new" onClick={e => { e.preventDefault(); go('/new'); }}>New item</a>}
          </div>
        )}
      </section>
      {selected && runSlugs.has(selected) && <Drawer slug={selected} />}
      <p class="mono muted small" style={{ margin: 0 }}>reads {'<backlog>'}/index.md · .git/sdlc-runs/*.json · each run's logs/status.json, live</p>
    </div>
  );
}
