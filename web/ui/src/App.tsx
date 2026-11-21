// The frame: top bar (project, command palette, run summary, theme), side menu, the screen for the URL hash, toasts.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, splitArgs, type Board as BoardData, type Project, type ViewState } from './api';
import { Board, needsYou } from './Board';
import { Completed } from './Completed';
import { useStream } from './useStream';
import { NewItem } from './NewItem';
import { Projects } from './Projects';
import { Run } from './Run';
import { Settings } from './Settings';
import { Ctx, ErrorBox, Future } from './ui';
import { attentionFrom, channelsFor, readPrefs, titleFor, writePrefs, type NotifyMode, type NotifyPrefs } from './notify';
import { permissionState, playChime, requestPermission, setFaviconBadge, showDesktop } from './notify-dom';

type Theme = 'light' | 'dark' | 'system';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};

function applyTheme(t: Theme): void {
  const light = t === 'light' || (t === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}

const routeOf = () => (location.hash.replace(/^#/, '') || '/board').split('?')[0];

function Palette({ project, close }: { project: string; close(): void }) {
  const [line, setLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ code: number | null; stdout: string; stderr: string; timedOut: boolean } | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const run = async () => {
    const args = splitArgs(line.replace(/^\s*(ai-sdlc-helper|\$)\s*/, ''));
    if (!args.length) return;
    setBusy(true); setError(''); setResult(null);
    try { setResult(await api.command(project, args)); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };
  return (
    <div class="overlay" role="dialog" aria-modal="true" aria-label="Run a command" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div class="pn dialog">
        <form class="pb row" onSubmit={e => { e.preventDefault(); run(); }}>
          <label class="sr" for="cmd">Command</label>
          <span class="mono muted">$ ai-sdlc-helper</span>
          <input id="cmd" ref={input} class="inp mono grow" style={{ width: 'auto', flex: '1 1 260px' }} placeholder="status --json · doctor · backlog · code-search --list · init-tests --dry-run · help" value={line} onInput={e => setLine((e.target as HTMLInputElement).value)} />
          <button class="btn btn-p" type="submit" disabled={busy}>{busy ? 'Running…' : 'Run'}</button>
        </form>
        <p class="small muted" style={{ margin: '0 14px 10px' }}>Runs any command of the tool in the project folder, as a separate process (stopped after 2 minutes, so use the screens for <span class="mono">watch --follow</span> and <span class="mono">pipeline</span>).</p>
        <ErrorBox error={error} />
        {result && (
          <div class="col" style={{ gap: '0' }}>
            <div class="ph"><span class="mono small">exit {result.code ?? '—'}{result.timedOut ? ' · stopped after 2 minutes' : ''}</span></div>
            <pre class="code mono" style={{ borderRadius: '0 0 8px 8px' }}>{result.stdout}{result.stderr && <span class="s-failed">{result.stderr}</span>}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

/** The bell in the top bar: whether a run that pauses, fails or finishes tells you on the desktop, with a sound, or both. */
function NotifyControl({ prefs, set }: { prefs: NotifyPrefs; set(p: NotifyPrefs): void }) {
  const [open, setOpen] = useState(false);
  const [perm, setPerm] = useState(permissionState());
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: Event) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', away); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc); };
  }, [open]);
  const desktop = prefs.mode === 'browser' || prefs.mode === 'both';
  const sound = prefs.mode === 'sound' || prefs.mode === 'both';
  const mode = (d: boolean, sn: boolean): NotifyMode => (d && sn ? 'both' : d ? 'browser' : sn ? 'sound' : 'off');
  // The browser only asks for permission from a click, so it is asked here, when the box is ticked.
  const setDesktop = async (on: boolean) => {
    if (on && perm !== 'granted') { const got = await requestPermission(); setPerm(got); if (got !== 'granted') { set({ ...prefs, mode: mode(false, sound) }); return; } }
    set({ ...prefs, mode: mode(on, sound) });
  };
  const event = (k: 'paused' | 'failed' | 'done', label: string) => (
    <label class="row small"><input type="checkbox" checked={prefs.events[k]} onChange={e => set({ ...prefs, events: { ...prefs.events, [k]: (e.target as HTMLInputElement).checked } })} /> {label}</label>
  );
  return (
    <div class="pop-wrap" ref={box}>
      <button type="button" class={`btn btn-s ${prefs.mode !== 'off' ? 'bell-on' : ''}`} aria-expanded={open} aria-haspopup="dialog" title="Notifications" onClick={() => setOpen(o => !o)}>
        <span aria-hidden="true">{prefs.mode === 'off' ? '🔕' : '🔔'}</span><span class="sr">Notifications: {prefs.mode === 'off' ? 'off' : 'on'}</span>
      </button>
      {open && (
        <div class="pn pop" role="dialog" aria-label="Notifications">
          <strong>Tell me when a run needs me</strong>
          <label class="row small"><input type="checkbox" checked={desktop} onChange={e => setDesktop((e.target as HTMLInputElement).checked)} /> Desktop notification</label>
          {perm === 'denied' && <span class="small s-failed">This browser blocks notifications for this page; allow them in the site settings.</span>}
          {perm === 'unsupported' && <span class="small muted">This browser has no desktop notifications.</span>}
          <label class="row small"><input type="checkbox" checked={sound} onChange={e => { const on = (e.target as HTMLInputElement).checked; set({ ...prefs, mode: mode(desktop, on) }); if (on) playChime('paused', prefs.volume); }} /> Sound</label>
          {sound && (
            <label class="row small" style={{ flexWrap: 'nowrap' }}>Volume
              <input type="range" class="grow" min="0" max="1" step="0.05" value={prefs.volume} onChange={e => { const v = Number((e.target as HTMLInputElement).value); set({ ...prefs, volume: v }); playChime('done', v); }} />
            </label>
          )}
          <div class="col" style={{ gap: '6px' }}>
            <span class="lbl">For</span>
            {event('paused', 'A run pauses for an answer or a decision')}
            {event('failed', 'A run fails or stops')}
            {event('done', 'A run finishes')}
          </div>
          <label class="row small"><input type="checkbox" checked={prefs.onlyWhenHidden} onChange={e => set({ ...prefs, onlyWhenHidden: (e.target as HTMLInputElement).checked })} /> Desktop notification only when this tab is in the background</label>
          <span class="small muted">Kept in this browser. The tab title and icon always show how many runs wait.</span>
        </div>
      )}
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState(routeOf());
  const [projects, setProjects] = useState<Project[]>([]);
  const [version, setVersion] = useState('');
  const [project, setProject] = useState(store.get('sdlc-project') || '');
  const [board, setBoard] = useState<BoardData | null>(null);
  const [boardError, setBoardError] = useState('');
  const [fatal, setFatal] = useState('');
  const [theme, setTheme] = useState<Theme>(() => (store.get('sdlc-theme') as Theme) || 'system');
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const [palette, setPalette] = useState(false);
  const [notify, setNotifyState] = useState<NotifyPrefs>(() => readPrefs(store.get));
  const notifyRef = useRef(notify);
  const setNotify = (p: NotifyPrefs) => { notifyRef.current = p; setNotifyState(p); writePrefs(store.set, p); };
  const [loaded, setLoaded] = useState(false);
  const previous = useRef<Record<string, ViewState> | null>(null);

  const toast = (text: string) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t.slice(-3), { id, text }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 6000);
  };
  const go = (r: string) => {
    const [path, query] = r.split('?');
    const p = new URLSearchParams(query || '').get('project');
    if (p) { setProject(p); store.set('sdlc-project', p); }
    location.hash = path;
  };
  const loadProjects = () => api.session().then(s => {
    setVersion(s.version);
    setProjects(s.projects);
    setProject(cur => (s.projects.some(p => p.name === cur) ? cur : s.projects[0]?.name || ''));
    setFatal(''); setLoaded(true);
  }).catch(e => { setFatal((e as Error).message); setLoaded(true); });

  useEffect(() => { loadProjects(); const h = () => { setRoute(routeOf()); setPalette(false); }; addEventListener('hashchange', h); return () => removeEventListener('hashchange', h); }, []);
  useEffect(() => {
    applyTheme(theme); store.set('sdlc-theme', theme);
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const h = () => applyTheme(theme);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, [theme]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); }
      if (e.key === 'Escape') setPalette(false);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);

  // The live board: the server pushes it whenever something changes. The stream is watched (60 s of silence reconnects;
  // a silent reconnect starts backup polling, see stream.ts).
  useEffect(() => { setBoard(null); setBoardError(''); previous.current = null; }, [project]);
  const applyBoard = (b: BoardData) => {
    const was = previous.current;
    if (was) {
      const prefs = notifyRef.current;
      for (const a of attentionFrom(was, b.runs)) {
        toast(`${a.title} · ${a.body}`);
        const to = channelsFor(prefs, a, document.hidden, permissionState());
        if (to.desktop) showDesktop(a, () => go(`/run/${a.slug}`));
        if (to.sound) playChime(a.kind, prefs.volume);
      }
    }
    previous.current = Object.fromEntries(b.runs.map(r => [r.slug, r.state]));
    setBoard(b); setBoardError('');
  };
  useStream({
    url: project ? api.eventsUrl(project) : null,
    on: {
      board: applyBoard,
      problem: (d: { message: string }) => setBoardError(d.message),
    },
    poll: () => api.board(project).then(applyBoard).catch(() => {}),
    banner: on => setBoardError(on ? 'Lost the connection to the server; retrying…' : ''),
  });

  const waiting = board ? board.runs.filter(needsYou).length : 0;
  const running = board ? board.running : 0;
  const failed = board ? board.runs.filter(r => r.state === 'failed' || r.state === 'stopped').length : 0;
  useEffect(() => { document.title = titleFor(waiting, `${project || 'ai-sdlc-helper'} · ai-sdlc-helper`); setFaviconBadge(waiting, failed); }, [waiting, failed, project]);

  const nav = (r: string, icon: string, label: string, extra?: string | number) => {
    const on = route === r || (r === '/board' && route.startsWith('/run/'));
    return <a class={`navi ${on ? 'navi-on' : ''}`} aria-current={on ? 'page' : undefined} href={`#${r}`}><span class="navi-ico" aria-hidden="true">{icon}</span>{label}{extra !== undefined && <span class="tag">{extra}</span>}</a>;
  };
  let screen;
  if (!loaded) screen = <div class="col"><div class="skel" style={{ height: '44px' }} /><div class="skel" style={{ height: '260px' }} /><span class="sr" role="status">Loading</span></div>;
  else if (fatal && /not signed in/i.test(fatal)) {
    screen = (
      <section class="pn welcome">
        <h1>Sign this browser in</h1>
        <p style={{ margin: 0 }}>The app answers only the browser that opened its sign-in link, so other pages on this computer cannot use it.</p>
        <p style={{ margin: 0 }}>The link is printed in the terminal where <span class="mono">ai-sdlc-helper ui</span> is running, on the line that starts with <span class="mono">Open</span>. To get a new one, stop it and run:</p>
        <pre class="code mono">ai-sdlc-helper ui</pre>
        <div class="row"><button class="btn btn-p" type="button" onClick={() => { setLoaded(false); loadProjects(); }}>Try again</button></div>
      </section>
    );
  } else if (fatal) screen = <ErrorBox error={fatal} />;
  else if (!project) screen = <Projects projects={projects} reload={loadProjects} />;
  else if (route.startsWith('/run/')) screen = <Run slug={decodeURIComponent(route.slice(5))} key={route} />;
  else if (route === '/completed') screen = <Completed />;
  else if (route.startsWith('/edit/')) {
    const [, , from, s] = route.split('/');
    screen = <NewItem key={route} taken={[]} edit={{ slug: decodeURIComponent(s), back: from === 'run' ? `/run/${s}` : '/board' }} />;
  } else if (route === '/new') screen = <NewItem taken={(board?.items || []).map(i => i.slug)} />;
  else if (route === '/projects') screen = <Projects projects={projects} reload={loadProjects} />;
  else if (route === '/settings') screen = <Settings />;
  else screen = <Board board={board} error={boardError} onRefresh={() => { api.board(project).then(applyBoard).catch(() => {}); }} />;

  return (
    <Ctx.Provider value={{ project, go, toast }}>
      <header class="top">
        <a href="#/board" class="brand mono"><span class="brand-mark" aria-hidden="true">◆</span>ai-sdlc-helper <span class="muted small">{version}</span></a>
        <label class="sr" for="proj">Project</label>
        <select id="proj" class="sel" style={{ minHeight: '32px' }} value={project} onChange={e => go(`/board?project=${encodeURIComponent((e.target as HTMLSelectElement).value)}`)}>
          {projects.map(p => <option value={p.name}>{p.name}{p.registered ? '' : ' (not registered)'}</option>)}
        </select>
        <button class="btn btn-s" type="button" style={{ flex: '1 1 240px', justifyContent: 'space-between', color: 'var(--mu)', maxWidth: '520px' }} onClick={() => setPalette(true)}>Run any command… <span class="mono">⌘K</span></button>
        <div class="counts" role="status" aria-label="Runs">
          <span class={`chip ${running ? 'chip-running' : 'chip-pending'}`}>● {running} running</span>
          <a href="#/board" class={`chip ${waiting ? 'chip-paused' : 'chip-pending'}`} style={{ textDecoration: 'none' }}>⏸ {waiting} need you</a>
          <span class={`chip ${failed ? 'chip-failed' : 'chip-pending'}`}>✘ {failed} failed</span>
        </div>
        <NotifyControl prefs={notify} set={setNotify} />
        <div class="segs" role="group" aria-label="Theme">
          {(['light', 'dark', 'system'] as Theme[]).map(t => <button type="button" class={`seg ${theme === t ? 'seg-on' : ''}`} aria-pressed={theme === t} onClick={() => { applyTheme(t); setTheme(t); }}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
      </header>
      <div class="frame">
        <nav class="nav" aria-label="Main">
          <div class="lbl" style={{ padding: '4px 10px' }}>Workspace</div>
          {nav('/board', '▦', 'Board', board?.runs.length)}
          {nav('/completed', '✓', 'Completed', board?.items ? board.items.filter(i => i.status === 'completed').length : undefined)}
          {nav('/new', '＋', 'New item')}
          <div class="lbl" style={{ padding: '12px 10px 4px' }}>Configure</div>
          {nav('/settings', '⚙', 'Settings')}
          <span class="navi muted" title="Not built yet"><span class="navi-ico" aria-hidden="true">✎</span>Prompts <Future id="E-1" /></span>
          <span class="navi muted" title="Not built yet"><span class="navi-ico" aria-hidden="true">◈</span>Models <Future id="phase 2" /></span>
          <div class="lbl" style={{ padding: '12px 10px 4px' }}>System</div>
          {nav('/projects', '▤', 'Projects', projects.length)}
        </nav>
        <main class="main">{screen}</main>
      </div>
      {palette && project && <Palette project={project} close={() => setPalette(false)} />}
      <div class="toasts" aria-live="polite">{toasts.map(t => <div class="toast" role="status">{t.text}</div>)}</div>
    </Ctx.Provider>
  );
}
