// The board: the backlog and one column per stage, live from the server's event stream; tick items and run them.
import { useEffect, useState } from 'preact/hooks';
import { api, type Board as BoardData, type RunCard, type RunView } from './api';
import { Cli, ErrorBox, GLYPH, Panel, Spinner, stateClass, useApp } from './ui';

export const COLUMNS = ['Backlog', 'Spec', 'Plan', 'Red tests', 'Implement', 'Test repair', 'Review', 'Ship'];

/** The column a run's card sits in: its stage; Ship when done or committing; Backlog before any stage. */
export function columnOf(r: RunCard): string {
  if (r.state === 'done' || r.stage === 'Commit') return 'Ship';
  return COLUMNS.includes(r.stage) ? r.stage : 'Backlog';
}

export const needsYou = (r: RunCard) => r.state === 'paused' || r.questions > 0 || r.permissions > 0;

function RunCardView({ r, on, select }: { r: RunCard; on: boolean; select(): void }) {
  const { go } = useApp();
  const what = r.questions ? `${r.questions} question${r.questions > 1 ? 's' : ''} to answer`
    : r.permissions ? `${r.permissions} refused action${r.permissions > 1 ? 's' : ''}`
      : r.deniedPermissions ? `${r.deniedPermissions} denied permission${r.deniedPermissions > 1 ? 's' : ''}`
        : r.note || r.message || (r.tests ? `tests ${r.tests.passed} / ${r.tests.total}` : r.state);
  return (
    <div class={`card card-${r.state.replace(' ', '-')} ${on ? 'card-on' : ''}`}>
      <button type="button" class="mono" onClick={select} style={{ all: 'unset', cursor: 'pointer' }} aria-pressed={on}>
        <span class={stateClass(r.state)}>{r.state === 'running' ? <Spinner /> : GLYPH[r.state]} {r.slug}</span>
      </button>
      <span class="small">{what}</span>
      <span class="mono muted small">{[r.model && `${r.model} · ${r.effort}`, r.changes && `${r.changes.changed} files`].filter(Boolean).join(' · ') || r.state}</span>
      <a href={`#/run/${r.slug}`} onClick={e => { e.preventDefault(); go(`/run/${r.slug}`); }} class="small">Open</a>
    </div>
  );
}

function Drawer({ slug }: { slug: string }) {
  const { project, go } = useApp();
  const [v, setV] = useState<RunView | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.run(project, slug).then(x => { if (live) setV(x); }).catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => { live = false; clearInterval(t); };
  }, [project, slug]);
  if (!v) return null;
  return (
    <Panel
      title={<span class="mono"><span class={stateClass(v.state)}>{v.state === 'running' ? <Spinner /> : GLYPH[v.state]}</span> {v.slug} <span class="muted small">{[v.stage, v.model && `${v.model} · ${v.effort}`, v.note].filter(Boolean).join(' · ')}</span></span>}
      extra={<a class="btn btn-s" href={`#/run/${slug}`} onClick={e => { e.preventDefault(); go(`/run/${slug}`); }}>Open run</a>}
    >
      <pre class="code mono" style={{ borderRadius: '0 0 8px 8px', maxHeight: '220px', overflowY: 'auto' }}>{v.tail.slice(-12).join('\n') || 'No output yet.'}</pre>
    </Panel>
  );
}

export function Board({ board, error }: { board: BoardData | null; error: string }) {
  const { project, go, toast } = useApp();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  if (!board) return <div class="col"><h1>Board</h1>{error ? <ErrorBox error={error} /> : <p class="muted">Loading…</p>}</div>;

  const f = filter.trim().toLowerCase();
  const match = (...s: (string | null)[]) => !f || s.some(x => x && x.toLowerCase().includes(f));
  const runSlugs = new Set(board.runs.map(r => r.slug));
  const items = (board.items || []).filter(i => !runSlugs.has(i.slug) && (showDone || i.status !== 'completed') && match(i.slug, i.title, i.type));
  const runs = board.runs.filter(r => (showDone || r.state !== 'done') && match(r.slug, r.stage, r.state, r.model));
  const chosen = Object.keys(picked).filter(k => picked[k]);
  const waiting = board.runs.filter(needsYou);

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
              <span class="row">
                <span><span class="mono">{r.slug}</span> · {r.stage || 'start'} · {r.questions ? `${r.questions} questions` : r.permissions ? `${r.permissions} refused actions` : 'paused'}</span>
                <a class="btn btn-s" href={`#/run/${r.slug}`} onClick={e => { e.preventDefault(); go(`/run/${r.slug}`); }}>{r.questions ? 'Answer' : r.permissions ? 'Decide' : 'Open'}</a>
              </span>
            ))}
          </div>
        </section>
      )}
      <div class="row">
        <h1 class="grow">Board</h1>
        <label class="sr" for="flt">Filter</label>
        <input id="flt" class="inp" style={{ width: '300px', maxWidth: '100%' }} placeholder="Filter by slug, stage, state, model…" value={filter} onInput={e => setFilter((e.target as HTMLInputElement).value)} />
        <label class="row small"><input type="checkbox" checked={showDone} onChange={e => setShowDone((e.target as HTMLInputElement).checked)} /> Show done</label>
        <span class="tag">{board.running} / {board.maxParallel} running</span>
        <a class="btn" href="#/new" onClick={e => { e.preventDefault(); go('/new'); }}>New item</a>
        <button class="btn btn-p" type="button" disabled={!chosen.length || busy} onClick={runSelected}>{busy ? <><Spinner /> Starting…</> : `Run selected (${chosen.length})`}</button>
      </div>
      <ErrorBox error={error} />
      {board.items === null && <div class="banner">This project has no backlog index yet. <a href="#/new" onClick={e => { e.preventDefault(); go('/new'); }}>Write the first item</a>; it creates the index.</div>}
      {chosen.length > 0 && <Cli commands={chosen.map(s => ['start', s])} />}
      <div class="board-scroll">
        <div class="board">
          {COLUMNS.map(col => {
            const cards = runs.filter(r => columnOf(r) === col);
            const backlog = col === 'Backlog' ? items : [];
            return (
              <section class="column" aria-label={col}>
                <div class="row" style={{ justifyContent: 'space-between' }}><span class="lbl">{col}</span><span class="tag">{cards.length + backlog.length}</span></div>
                {backlog.map(i => (
                  <div class={`card ${picked[i.slug] ? 'card-on' : ''}`}>
                    <label class="row mono" style={{ cursor: 'pointer' }}>
                      <input type="checkbox" checked={!!picked[i.slug]} disabled={i.status === 'completed' || !i.hasBrief} onChange={e => setPicked(m => ({ ...m, [i.slug]: (e.target as HTMLInputElement).checked }))} />
                      {i.slug}
                    </label>
                    <span class="small muted">{[i.type, i.priority, i.title].filter(Boolean).join(' · ')}</span>
                    {i.note && <span class="small s-paused">{i.note}</span>}
                    <a href={`#/run/${i.slug}`} onClick={e => { e.preventDefault(); go(`/run/${i.slug}`); }} class="small">Open</a>
                  </div>
                ))}
                {cards.map(r => <RunCardView r={r} on={selected === r.slug} select={() => setSelected(s => (s === r.slug ? '' : r.slug))} />)}
                {!cards.length && !backlog.length && <span class="small muted">Nothing here</span>}
              </section>
            );
          })}
        </div>
      </div>
      {selected && runSlugs.has(selected) && <Drawer slug={selected} />}
      <p class="mono muted small" style={{ margin: 0 }}>reads {'<backlog>'}/index.md · .git/sdlc-runs/*.json · each run's logs/status.json, live</p>
    </div>
  );
}
