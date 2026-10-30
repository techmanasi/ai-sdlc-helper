// A new backlog item: slug, type, title and the brief (the triage skill's sections as a template), with a preview.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type DraftStatus, type TriageDraft, type TriageEvent, type TriageItem, type TriageQuestion, type TriageRun, type TriageState } from './api';
import { ErrorBox, Future, Markdown, useApp } from './ui';

const template = (slug: string, type: string, priority: string) => `# ${slug || '<slug>'}

Type: ${type}
Priority: ${priority}

## Problem


## Expected behaviour


## Decisions
-

## Scope
- In:
- Out:

## Tests
-

## Docs
-

## Open questions
- none
`;

const PRIORITIES = ['P0 (security or data loss)', 'P1 (high)', 'P2 (normal)', 'P3 (low)'];

/** The priority option a draft's `Priority:` line stands for (by its P0–P3 prefix); P2 with a note when it is none of them. */
export function mapPriority(v: string): { value: string; note: string } {
  const prefix = /^P\d/.exec(v.trim())?.[0];
  const hit = prefix ? PRIORITIES.find(o => o.startsWith(prefix)) : undefined;
  return hit ? { value: hit, note: '' } : { value: 'P2 (normal)', note: `Priority '${v || 'none'}' is not an option; set to P2 (normal).` };
}

type Draft = TriageDraft & { status: DraftStatus };

/** The drawer of the triage agent: a report goes in; drafts come out, to load into the form one at a time. */
function TriageDrawer({ known, onLoad, onClose, onRun }: { known: TriageRun | null; onLoad: (d: Draft) => void; onClose: () => void; onRun: (run: TriageRun | null) => void }) {
  const { project, toast } = useApp();
  const [run, setRun] = useState<TriageRun | null>(null);
  const [state, setState] = useState<TriageState | ''>('');
  const [report, setReport] = useState('');
  const [quick, setQuick] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [items, setItems] = useState<TriageItem[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [questions, setQuestions] = useState<{ slug: string; list: TriageQuestion[] } | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const streams = useRef<AbortController[]>([]);

  const refresh = async () => {
    try {
      const r = (await api.triage(project)).run;
      setRun(r); setState(r ? r.state : ''); onRun(r);
      if (r) setDrafts(d => d.map(x => ({ ...x, status: r.drafts.find(y => y.slug === x.slug)?.status ?? x.status })));
    } catch (e) { setError((e as Error).message); }
  };

  /** One reducer for live and replayed events. */
  const apply = (ev: TriageEvent) => {
    const d = ev.data;
    if (ev.event === 'started') setRun(r => ({ runId: d.runId, state: 'running', worktree: '', slugs: [], drafts: [], ...r }));
    else if (ev.event === 'text') setLog(l => [...l, d.text]);
    else if (ev.event === 'tool') setLog(l => [...l, `▸ ${d.summary}`]);
    // items, question and draft change the run's state (choosing, waiting, running) without a done; the server has it.
    else if (ev.event === 'items') { setItems(d.items); setPicked(new Set(d.items.map((i: TriageItem) => i.slug))); setQuestions(null); void refresh(); }
    else if (ev.event === 'question') { setQuestions({ slug: d.slug, list: d.questions }); setAnswers({}); void refresh(); }
    else if (ev.event === 'draft') { setQuestions(null); setDrafts(l => [...l, ...d.drafts.filter((x: TriageDraft) => !l.some(y => y.slug === x.slug)).map((x: TriageDraft) => ({ ...x, status: 'pending' as const }))]); void refresh(); }
    else if (ev.event === 'marked') setDrafts(l => l.map(x => (x.slug === d.slug ? { ...x, status: d.status } : x)));
    else if (ev.event === 'error') setError(d.message);
    else if (ev.event === 'done') void refresh();
  };

  // Draft statuses the form changed (a Save marks its draft) reach the drawer even when its stream has closed.
  useEffect(() => {
    if (known) setDrafts(l => l.map(x => ({ ...x, status: known.drafts.find(y => y.slug === x.slug)?.status ?? x.status })));
  }, [known]);

  const attach = (fn: (signal: AbortSignal) => Promise<void>) => {
    const ac = new AbortController();
    streams.current.push(ac);
    fn(ac.signal).catch(e => { if (!ac.signal.aborted) setError((e as Error).message); });
  };

  useEffect(() => {
    api.triage(project).then(({ run: r }) => {
      if (!r) return;
      setRun(r); setState(r.state); onRun(r);
      attach(signal => api.triageEvents(project, r.runId, apply, signal));
    }).catch(e => setError((e as Error).message));
    // Closing the drawer only closes the connections; the run goes on.
    return () => { streams.current.forEach(a => a.abort()); };
  }, [project]);

  const start = () => {
    setError(''); setLog([]); setItems([]); setDrafts([]); setQuestions(null); setState('running');
    attach(signal => api.triageStart(project, { report, quick }, apply, signal).catch(e => { setState(''); throw e; }));
  };

  const act = async (fn: () => Promise<unknown>, then?: () => void) => {
    setBusy(true); setError('');
    try { await fn(); then?.(); await refresh(); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const id = run?.runId || '';
  const resumable = state === 'stopped' || state === 'interrupted' || state === 'failed';
  const pending = drafts.filter(d => d.status === 'pending');

  return (
    <section class="pn">
      <div class="ph">
        <h2>Triage agent</h2>
        <span class="mono small muted grow">{state ? `run ${id} · ${state}` : 'no run'}</span>
        <button class="btn btn-s" type="button" onClick={onClose}>Close</button>
      </div>
      <div class="pb col" style={{ gap: '10px' }}>
        {!run && (
          <>
            <label class="lbl" for="triage-report">Report</label>
            <textarea id="triage-report" class="inp" rows={5} value={report} placeholder="Paste a bug report, a request or a list of both" onInput={e => setReport((e.target as HTMLTextAreaElement).value)} />
            <label class="small"><input type="checkbox" checked={quick} onChange={e => setQuick((e.target as HTMLInputElement).checked)} /> Quick: draft every item without asking questions</label>
            <div class="row"><button class="btn btn-p" type="button" disabled={!report.trim()} onClick={start}>Start triage</button></div>
          </>
        )}
        {log.length > 0 && <pre class="mono small" style={{ maxHeight: '160px', overflow: 'auto', margin: 0 }}>{log.slice(-40).join('\n')}</pre>}
        {state === 'choosing' && (
          <div class="col" style={{ gap: '6px' }}>
            <strong>The agent proposes {items.length} item{items.length === 1 ? '' : 's'}</strong>
            {items.map(i => (
              <label class="small">
                <input type="checkbox" checked={picked.has(i.slug)} onChange={() => setPicked(s => { const n = new Set(s); if (n.has(i.slug)) n.delete(i.slug); else n.add(i.slug); return n; })} />{' '}
                <span class="mono">{i.slug}</span> · {i.type} · {i.priority} · {i.title} <span class="muted">{i.summary}</span>
              </label>
            ))}
            <div class="row"><button class="btn btn-p" type="button" disabled={busy} onClick={() => act(() => api.triageItems(project, id, [...picked]))}>Draft the selected items</button></div>
          </div>
        )}
        {state === 'waiting' && questions && (
          <div class="col" style={{ gap: '8px' }}>
            <strong>Questions for {questions.slug}</strong>
            {questions.list.map(q => (
              <div class="col" style={{ gap: '4px' }}>
                <span class="small" style={{ whiteSpace: 'pre-wrap' }}>{q.id}: {q.text}</span>
                <span class="small muted">Suggested: {q.suggested}</span>
                <textarea class="inp" rows={2} aria-label={`Answer to ${q.id}`} value={answers[q.id] || ''} onInput={e => setAnswers(a => ({ ...a, [q.id]: (e.target as HTMLTextAreaElement).value }))} />
                <div><button class="btn btn-s" type="button" onClick={() => setAnswers(a => ({ ...a, [q.id]: 'accept' }))}>Use suggested</button></div>
              </div>
            ))}
            <div class="row"><button class="btn btn-p" type="button" disabled={busy || questions.list.some(q => !(answers[q.id] || '').trim())} onClick={() => act(() => api.triageAnswer(project, id, questions.slug, answers))}>Send answers</button></div>
          </div>
        )}
        {drafts.length > 0 && (
          <div class="col" style={{ gap: '6px' }}>
            <strong>Drafts</strong>
            {drafts.map(d => (
              <div class="row">
                <span class="mono grow">{d.slug}</span>
                <span class="small muted">{d.status}</span>
                <button class="btn btn-s" type="button" disabled={d.status !== 'pending'} onClick={() => onLoad(d)}>Load into form</button>
                <button class="btn btn-s" type="button" disabled={busy || d.status !== 'pending'} onClick={() => act(() => api.triageSkip(project, id, d.slug), () => toast(`Skipped ${d.slug}`))}>Skip</button>
              </div>
            ))}
            {!pending.length && state === 'ready' && <span class="small muted">Every draft is saved or skipped.</span>}
          </div>
        )}
        <ErrorBox error={error} />
        {run && (
          <div class="row">
            {state === 'running' && <button class="btn" type="button" disabled={busy} onClick={() => act(() => api.triageStop(project, id))}>Stop</button>}
            {resumable && <button class="btn btn-p" type="button" disabled={busy} onClick={() => act(() => api.triageResume(project, id), () => {
              // The new stream replays every event, so the old one is closed and the log rebuilt rather than doubled.
              streams.current.forEach(a => a.abort()); streams.current = []; setLog([]);
              attach(signal => api.triageEvents(project, id, apply, signal));
            })}>Resume</button>}
            {confirmDiscard ? (
              <>
                <span class="small">Delete the run, its worktree and its drafts?</span>
                <button class="btn" type="button" disabled={busy} onClick={() => act(() => api.triageDiscard(project, id), () => { setConfirmDiscard(false); setRun(null); setState(''); setDrafts([]); setItems([]); setQuestions(null); setLog([]); })}>Yes, discard</button>
                <button class="btn" type="button" onClick={() => setConfirmDiscard(false)}>No</button>
              </>
            ) : <button class="btn" type="button" disabled={busy} onClick={() => setConfirmDiscard(true)}>Discard</button>}
          </div>
        )}
      </div>
    </section>
  );
}

export function NewItem({ taken }: { taken: string[] }) {
  const { project, go, toast } = useApp();
  const [slug, setSlug] = useState('');
  const [type, setType] = useState('feature');
  const [priority, setPriority] = useState('P2 (normal)');
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState(() => template('', 'feature', 'P2 (normal)'));
  const [view, setView] = useState<'write' | 'split' | 'preview'>('split');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [triageRun, setTriageRun] = useState<TriageRun | null>(null);
  const [priorityNote, setPriorityNote] = useState('');

  // A run that is still active when the page loads reopens the drawer.
  useEffect(() => {
    api.triage(project).then(({ run }) => { setTriageRun(run); if (run) setDrawer(true); }).catch(() => { /* the drawer reports it when opened */ });
  }, [project]);

  const edited = Boolean(slug || title || type !== 'feature' || priority !== 'P2 (normal)' || brief !== template('', 'feature', 'P2 (normal)'));
  const onLoad = (d: Draft) => {
    if (edited && !window.confirm('Replace the current form with the draft?')) return;
    const mapped = mapPriority(d.priority);
    setSlug(d.slug); setType(d.type); setPriority(mapped.value); setPriorityNote(mapped.note); setTitle(d.title); setBrief(d.brief);
  };

  const slugOk = /^[a-z0-9][a-z0-9-]*$/.test(slug);
  const slugFree = !taken.includes(slug);
  const empty = ['## Problem', '## Expected behaviour'].filter(h => { const m = brief.split(h)[1]; return m !== undefined && !m.split('\n## ')[0].trim(); });

  const save = async (start: boolean) => {
    setBusy(true); setError('');
    try {
      const r = await api.addItem(project, { slug, type, title, brief: brief.replace(/^# <slug>/, `# ${slug}`), start });
      if (r.started && !r.started.ok) toast(`Saved ${slug}; start refused: ${r.started.err.join(' ')}`);
      else toast(start ? `Saved and started ${slug}` : `Saved ${slug}`);
      // A draft of the triage run that was saved is marked, so the run can finish.
      let more = false;
      try {
        const cur = (await api.triage(project)).run;
        if (cur && cur.drafts.some(d => d.slug === slug && d.status === 'pending')) {
          const after = (await api.triageSaved(project, cur.runId, slug)).run;
          setTriageRun(after);
          more = after.drafts.some(d => d.status === 'pending');
        }
      } catch (e) { toast(`Saved ${slug}, but the triage run was not told: ${(e as Error).message}`); }
      if (more && !start) {
        setSlug(''); setType('feature'); setPriority('P2 (normal)'); setPriorityNote(''); setTitle(''); setBrief(template('', 'feature', 'P2 (normal)'));
        setDrawer(true);
      } else go(start ? `/run/${slug}` : '/board');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  return (
    <div class="col">
      <div class="row">
        <h1 class="grow">New backlog item</h1>
        <button class="btn" type="button" onClick={() => setDrawer(true)}>Draft with the triage agent</button>
        <button class="btn" type="button" disabled title="Waits on engine request E-14">Import from issue URL <Future id="E-14" /></button>
      </div>
      {drawer && <TriageDrawer known={triageRun} onLoad={onLoad} onClose={() => setDrawer(false)} onRun={setTriageRun} />}
      <section class="pn">
        <div class="pb" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
          <div class="col" style={{ gap: '6px' }}>
            <label class="lbl" for="slug">Slug</label>
            <input id="slug" class="inp mono" value={slug} placeholder="add-rate-limit" onInput={e => setSlug((e.target as HTMLInputElement).value.trim())} />
            <span class={`small ${slug && (!slugOk || !slugFree) ? 's-failed' : 'muted'}`}>{!slug ? 'lowercase letters, digits and dashes' : !slugOk ? 'only lowercase letters, digits and dashes' : !slugFree ? 'already in the backlog' : '✔ free'}</span>
          </div>
          <div class="col" style={{ gap: '6px' }}>
            <label class="lbl" for="type">Type</label>
            <select id="type" class="inp" value={type} onChange={e => setType((e.target as HTMLSelectElement).value)}><option>feature</option><option>bug</option></select>
          </div>
          <div class="col" style={{ gap: '6px' }}>
            <label class="lbl" for="prio">Priority</label>
            <select id="prio" class="inp" value={priority} onChange={e => { setPriority((e.target as HTMLSelectElement).value); setPriorityNote(''); }}>{PRIORITIES.map(p => <option>{p}</option>)}</select>
            {priorityNote && <span class="small muted">{priorityNote}</span>}
          </div>
          <div class="col" style={{ gap: '6px', gridColumn: '1 / -1' }}>
            <label class="lbl" for="title">Title (the index line)</label>
            <input id="title" class="inp" value={title} onInput={e => setTitle((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <div class="mono small muted" style={{ padding: '0 14px 12px' }}>index.md ← - [ ] `{slug || '<slug>'}` - {type === 'bug' ? 'Bug' : 'Feature'}: {title || '<title>'}</div>
      </section>
      <section class="pn">
        <div class="ph">
          <h2 class="mono">brief.md</h2>
          <div class="segs" role="tablist" aria-label="Editor view">
            {(['write', 'split', 'preview'] as const).map(m => <button class={`seg ${view === m ? 'seg-on' : ''}`} type="button" role="tab" aria-selected={view === m} onClick={() => setView(m)}>{m[0].toUpperCase() + m.slice(1)}</button>)}
          </div>
          <button class="btn btn-s" type="button" onClick={() => setBrief(template(slug, type, priority))}>Insert template</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          {view !== 'preview' && (
            <>
              <label class="sr" for="brief">Brief, Markdown</label>
              <textarea id="brief" class="mono" value={brief} onInput={e => setBrief((e.target as HTMLTextAreaElement).value)}
                style={{ flex: '1 1 420px', minWidth: 0, minHeight: '480px', border: 0, borderRight: '1px solid var(--ln)', background: 'var(--code)', color: 'var(--tx)', padding: '14px', fontSize: '12.5px', lineHeight: 1.7, resize: 'vertical' }} />
            </>
          )}
          {view !== 'write' && (
            <div style={{ flex: '1 1 420px', minWidth: 0, padding: '14px 18px' }}>
              <Markdown text={brief} />
              <div class="small muted" style={{ border: '1px solid var(--ln)', borderRadius: '6px', padding: '10px 12px', marginTop: '10px' }}>
                {empty.length ? `Still empty: ${empty.map(h => h.slice(3)).join(', ')}. ` : 'Every main section has text. '}
                The fewer gaps here, the fewer Spec question rounds.
              </div>
            </div>
          )}
        </div>
      </section>
      <ErrorBox error={error} />
      <div class="row">
        <button class="btn btn-p" type="button" disabled={busy || !slugOk || !slugFree || !title.trim()} onClick={() => save(true)}>Save and start</button>
        <button class="btn" type="button" disabled={busy || !slugOk || !slugFree || !title.trim()} onClick={() => save(false)}>Save</button>
        <a class="btn" href="#/board" onClick={e => { e.preventDefault(); go('/board'); }}>Cancel</a>
        <span class="mono small muted" style={{ marginLeft: 'auto' }}>writes in the main working tree · not committed</span>
      </div>
    </div>
  );
}
