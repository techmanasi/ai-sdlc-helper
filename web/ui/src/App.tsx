// The frame: top bar (project, command palette, run summary, theme), side menu, the screen for the URL hash, toasts.
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, splitArgs, type Board as BoardData, type Project, type ViewState } from './api';
import { Board, needsYou } from './Board';
import { Completed } from './Completed';
import { NewItem } from './NewItem';
import { Projects } from './Projects';
import { Run } from './Run';
import { Settings } from './Settings';
import { Ctx, ErrorBox, Future } from './ui';

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
  }).catch(e => setFatal((e as Error).message));

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

  // The live board: the server pushes it whenever something changes.
  useEffect(() => {
    if (!project) return;
    setBoard(null); setBoardError(''); previous.current = null;
    const es = new EventSource(`/api/events?project=${encodeURIComponent(project)}`);
    es.addEventListener('board', e => {
      const b = JSON.parse((e as MessageEvent).data) as BoardData;
      const was = previous.current;
      if (was) {
        for (const r of b.runs) {
          if (!was[r.slug] || was[r.slug] === r.state) continue;
          if (r.state === 'paused') toast(`${r.slug} is paused at ${r.stage || 'the start'}${r.questions ? `: ${r.questions} questions` : r.permissions ? `: ${r.permissions} refused actions` : ''}`);
          else if (r.state === 'failed' || r.state === 'stopped') toast(`${r.slug} failed at ${r.stage || 'the start'}`);
          else if (r.state === 'done') toast(`${r.slug} is done`);
        }
      }
      previous.current = Object.fromEntries(b.runs.map(r => [r.slug, r.state]));
      setBoard(b); setBoardError('');
    });
    es.addEventListener('problem', e => setBoardError(JSON.parse((e as MessageEvent).data).message));
    es.onerror = () => setBoardError('Lost the connection to the server; retrying…');
    return () => es.close();
  }, [project]);

  const waiting = board ? board.runs.filter(needsYou).length : 0;
  const running = board ? board.running : 0;
  const failed = board ? board.runs.filter(r => r.state === 'failed' || r.state === 'stopped').length : 0;
  useEffect(() => { document.title = `${waiting ? `(${waiting}) ` : ''}${project || 'ai-sdlc-helper'} · ai-sdlc-helper`; }, [waiting, project]);

  const nav = (r: string, label: string, extra?: string | number) => (
    <a class={`navi ${route === r || (r === '/run' && route.startsWith('/run/')) ? 'navi-on' : ''}`} href={`#${r}`}>{label}{extra !== undefined && <span class="tag">{extra}</span>}</a>
  );
  let screen;
  if (fatal) screen = <ErrorBox error={`${fatal}\n\nOpen the URL that ai-sdlc-helper ui printed (it signs this browser in).`} />;
  else if (!project) screen = <Projects projects={projects} reload={loadProjects} />;
  else if (route.startsWith('/run/')) screen = <Run slug={decodeURIComponent(route.slice(5))} key={route} />;
  else if (route === '/completed') screen = <Completed />;
  else if (route === '/new') screen = <NewItem taken={(board?.items || []).map(i => i.slug)} />;
  else if (route === '/projects') screen = <Projects projects={projects} reload={loadProjects} />;
  else if (route === '/settings') screen = <Settings />;
  else screen = <Board board={board} error={boardError} />;

  return (
    <Ctx.Provider value={{ project, go, toast }}>
      <header class="top">
        <a href="#/board" class="brand mono">◆ ai-sdlc-helper <span class="muted">{version}</span></a>
        <label class="sr" for="proj">Project</label>
        <select id="proj" class="sel" style={{ minHeight: '32px' }} value={project} onChange={e => go(`/board?project=${encodeURIComponent((e.target as HTMLSelectElement).value)}`)}>
          {projects.map(p => <option value={p.name}>{p.name}{p.registered ? '' : ' (not registered)'}</option>)}
        </select>
        <button class="btn btn-s" type="button" style={{ flex: '1 1 240px', justifyContent: 'space-between', color: 'var(--mu)', maxWidth: '520px' }} onClick={() => setPalette(true)}>Run any command… <span class="mono">⌘K</span></button>
        <div class="row" style={{ gap: '6px' }}>
          <span class="tag s-running">● {running} running</span>
          <span class="tag s-paused">⏸ {waiting} need you</span>
          <span class="tag s-failed">✘ {failed} failed</span>
        </div>
        <div class="segs" role="group" aria-label="Theme">
          {(['light', 'dark', 'system'] as Theme[]).map(t => <button type="button" class={`seg ${theme === t ? 'seg-on' : ''}`} aria-pressed={theme === t} onClick={() => { applyTheme(t); setTheme(t); }}>{t[0].toUpperCase() + t.slice(1)}</button>)}
        </div>
        <span class="tag">{location.host}</span>
      </header>
      <div class="frame">
        <nav class="nav" aria-label="Main">
          <div class="lbl" style={{ padding: '4px 10px' }}>Workspace</div>
          {nav('/board', 'Board', board?.runs.length)}
          {nav('/completed', 'Completed', board?.items ? board.items.filter(i => i.status === 'completed').length : undefined)}
          {nav('/new', 'New item')}
          <div class="lbl" style={{ padding: '12px 10px 4px' }}>Configure</div>
          {nav('/settings', 'Settings')}
          <span class="navi muted" title="Waits on engine request E-1">Prompts <Future id="E-1" /></span>
          <span class="navi muted" title="Phase 2">Models <Future id="phase 2" /></span>
          <div class="lbl" style={{ padding: '12px 10px 4px' }}>System</div>
          {nav('/projects', 'Projects', projects.length)}
        </nav>
        <main class="main">{screen}</main>
      </div>
      {palette && project && <Palette project={project} close={() => setPalette(false)} />}
      <div class="toasts" aria-live="polite">{toasts.map(t => <div class="toast" role="status">{t.text}</div>)}</div>
    </Ctx.Provider>
  );
}
