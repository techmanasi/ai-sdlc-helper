// The Completed Tasks view: lists finished tasks from backlog and git, displays commits and files changed
// directly from git (resilient across machines), PR link or "Create PR" button, and task archiving controls.
import { useEffect, useState } from 'preact/hooks';
import { api, type CompletedTask, type CompletedTaskDetail } from './api';
import { ErrorBox, Markdown, Panel, Spinner, useApp } from './ui';

export function Completed() {
  const { project, toast, go } = useApp();
  const [tasks, setTasks] = useState<CompletedTask[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<CompletedTaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'archived'>('all');
  const [query, setQuery] = useState('');

  const loadTasks = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.completed(project);
      setTasks(res.completed);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (slug: string) => {
    setSelectedSlug(slug);
    setLoadingDetail(true);
    try {
      const res = await api.completedTask(project, slug);
      setDetail(res);
    } catch (e) {
      toast(`Failed to load task details: ${(e as Error).message}`);
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    loadTasks();
  }, [project]);

  const handleArchive = async (slug: string) => {
    setBusyAction(`archive-${slug}`);
    try {
      await api.archiveTask(project, slug);
      toast(`Archived ${slug}`);
      await loadTasks();
      if (selectedSlug === slug && detail) {
        setDetail({ ...detail, archived: true });
      }
    } catch (e) {
      toast(`Archive failed: ${(e as Error).message}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleArchiveAll = async () => {
    setBusyAction('archive-all');
    try {
      const res = await api.archiveAll(project, { olderThanDays: undefined });
      toast(`Archived ${res.count} task(s)`);
      await loadTasks();
      if (detail) {
        setDetail({ ...detail, archived: true });
      }
    } catch (e) {
      toast(`Archive failed: ${(e as Error).message}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreatePr = async (slug: string) => {
    setBusyAction(`pr-${slug}`);
    try {
      const res = await api.createCompletedPr(project, slug);
      if (res.ok && res.pr) {
        toast(`PR created: ${res.pr}`);
        await loadTasks();
        if (selectedSlug === slug) {
          await loadDetail(slug);
        }
      } else {
        toast(`Create PR failed: ${(res.err || []).join(' ')}`);
      }
    } catch (e) {
      toast(`Create PR error: ${(e as Error).message}`);
    } finally {
      setBusyAction(null);
    }
  };

  const filteredTasks = tasks.filter(t => {
    if (filter === 'active' && t.archived) return false;
    if (filter === 'archived' && !t.archived) return false;
    if (query) {
      const q = query.toLowerCase();
      return t.slug.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div class="col" style={{ gap: '16px' }}>
      <div class="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div class="row" style={{ gap: '12px', alignItems: 'center' }}>
          <h1 style={{ margin: 0 }}>Completed Tasks</h1>
          <span class="tag s-done">✔ {tasks.length} total</span>
        </div>
        <div class="row" style={{ gap: '8px' }}>
          <button
            class="btn btn-s"
            type="button"
            disabled={busyAction === 'archive-all' || !tasks.some(t => !t.archived)}
            onClick={handleArchiveAll}
          >
            {busyAction === 'archive-all' ? <><Spinner /> Archiving…</> : 'Archive all active'}
          </button>
          <button class="btn btn-s" type="button" onClick={loadTasks}>
            Refresh
          </button>
        </div>
      </div>

      <ErrorBox error={error} />

      <div class="row" style={{ gap: '10px', alignItems: 'center' }}>
        <input
          class="inp"
          style={{ maxWidth: '300px' }}
          placeholder="Filter by slug or title…"
          value={query}
          onInput={e => setQuery((e.target as HTMLInputElement).value)}
        />
        <div class="segs" role="group" aria-label="Filter status">
          {(['all', 'active', 'archived'] as const).map(f => (
            <button
              type="button"
              class={`seg ${filter === f ? 'seg-on' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? `All (${tasks.length})` : f === 'active' ? `Active (${tasks.filter(t => !t.archived).length})` : `Archived (${tasks.filter(t => t.archived).length})`}
            </button>
          ))}
        </div>
      </div>

      <div class="split" style={{ alignItems: 'flex-start' }}>
        <div class="col" style={{ flex: '1 1 360px', minWidth: '320px' }}>
          {loading && <p class="muted">Loading completed tasks…</p>}
          {!loading && filteredTasks.length === 0 && (
            <p class="muted">No completed tasks match your criteria.</p>
          )}
          {filteredTasks.map(t => (
            <div
              class={`card ${selectedSlug === t.slug ? 'selected' : ''}`}
              style={{
                cursor: 'pointer',
                padding: '12px',
                border: selectedSlug === t.slug ? '1px solid var(--ac)' : '1px solid var(--bd)',
                borderRadius: '8px',
                backgroundColor: selectedSlug === t.slug ? 'var(--bg-card-selected, var(--sub))' : 'var(--bg-card)',
              }}
              onClick={() => loadDetail(t.slug)}
            >
              <div class="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <strong class="mono" style={{ fontSize: '1.05em' }}>{t.slug}</strong>
                <div class="row" style={{ gap: '4px' }}>
                  {t.archived && <span class="tag muted">Archived</span>}
                  {t.pr ? (
                    <a
                      href={t.pr}
                      target="_blank"
                      rel="noreferrer"
                      class="tag s-done mono"
                      onClick={e => e.stopPropagation()}
                    >
                      PR ↗
                    </a>
                  ) : (
                    <button
                      class="btn btn-xs"
                      type="button"
                      disabled={busyAction === `pr-${t.slug}`}
                      onClick={e => { e.stopPropagation(); handleCreatePr(t.slug); }}
                    >
                      {busyAction === `pr-${t.slug}` ? 'Creating…' : 'Create PR'}
                    </button>
                  )}
                </div>
              </div>
              <p style={{ margin: '6px 0', fontSize: '0.9em' }}>{t.title}</p>
              <div class="row" style={{ gap: '8px', fontSize: '0.8em', color: 'var(--mu)' }}>
                <span>branch: <span class="mono">{t.branch}</span></span>
                {t.date && <span>• {t.date.split('T')[0]}</span>}
              </div>
            </div>
          ))}
        </div>

        <div class="col" style={{ flex: '2 1 500px', minWidth: '340px' }}>
          {!selectedSlug && (
            <Panel title="Task Details">
              <p class="muted" style={{ margin: '14px' }}>Select a completed task from the left to view git commits, changed files, and pull request information.</p>
            </Panel>
          )}

          {loadingDetail && (
            <Panel title="Loading…">
              <p class="muted" style={{ margin: '14px' }}><Spinner /> Loading details directly from git…</p>
            </Panel>
          )}

          {detail && !loadingDetail && selectedSlug === detail.slug && (
            <div class="col" style={{ gap: '14px' }}>
              <Panel
                title={<span class="mono">{detail.slug}</span>}
                extra={
                  <div class="row" style={{ gap: '6px' }}>
                    {!detail.archived && (
                      <button
                        class="btn btn-s"
                        type="button"
                        disabled={busyAction === `archive-${detail.slug}`}
                        onClick={() => handleArchive(detail.slug)}
                      >
                        {busyAction === `archive-${detail.slug}` ? 'Archiving…' : 'Archive Task'}
                      </button>
                    )}
                    <button
                      class="btn btn-s"
                      type="button"
                      onClick={() => go(`/run/${encodeURIComponent(detail.slug)}`)}
                    >
                      Open in Run View
                    </button>
                  </div>
                }
              >
                <div class="pb col" style={{ gap: '10px' }}>
                  <h3 style={{ margin: 0 }}>{detail.title}</h3>
                  <div class="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
                    <span class="tag s-done">Completed</span>
                    {detail.archived && <span class="tag muted">Archived</span>}
                    <span class="tag mono">Branch: {detail.branch}</span>
                    <span class="tag mono">Base: {detail.base}</span>
                    {detail.date && <span class="tag">{detail.date}</span>}
                  </div>

                  <div class="row" style={{ gap: '10px', alignItems: 'center', marginTop: '6px' }}>
                    <strong>Pull Request:</strong>
                    {detail.pr ? (
                      <a href={detail.pr} target="_blank" rel="noreferrer" class="mono s-done" style={{ textDecoration: 'underline' }}>
                        {detail.pr} ↗
                      </a>
                    ) : (
                      <div class="row" style={{ gap: '8px', alignItems: 'center' }}>
                        <span class="muted small">No PR linked</span>
                        <button
                          class="btn btn-s btn-p"
                          type="button"
                          disabled={busyAction === `pr-${detail.slug}`}
                          onClick={() => handleCreatePr(detail.slug)}
                        >
                          {busyAction === `pr-${detail.slug}` ? <><Spinner /> Creating PR…</> : 'Create PR Now'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>

              {detail.commits && detail.commits.length > 0 && (
                <Panel title={`Commits (${detail.commits.length})`}>
                  <div class="pb col" style={{ gap: '6px' }}>
                    {detail.commits.map(c => (
                      <div class="row" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--bd)', paddingBottom: '6px' }}>
                        <div class="col" style={{ gap: '2px' }}>
                          <span class="mono small" style={{ fontWeight: 600 }}>{c.message}</span>
                          <span class="small muted">{c.author} · {c.date ? c.date.split('T')[0] : ''}</span>
                        </div>
                        <span class="mono small muted">{c.sha.slice(0, 8)}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}

              {detail.files && detail.files.length > 0 && (
                <Panel
                  title={`Files Changed (${detail.files.length})`}
                  extra={detail.diffStat && <span class="mono small muted">{detail.diffStat.split('\n').pop()}</span>}
                >
                  <div class="pb col" style={{ gap: '4px' }}>
                    {detail.files.map(f => (
                      <div class="row" style={{ justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--bd)' }}>
                        <div class="row" style={{ gap: '8px', alignItems: 'center' }}>
                          <span class={`tag ${f.status === 'A' ? 's-done' : f.status === 'D' ? 's-failed' : ''}`}>{f.status}</span>
                          <span class="mono small">{f.path}</span>
                        </div>
                        <div class="row small mono" style={{ gap: '6px' }}>
                          {(f.additions ?? 0) > 0 && <span class="s-done">+{f.additions}</span>}
                          {(f.deletions ?? 0) > 0 && <span class="s-failed">-{f.deletions}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}

              {detail.brief && (
                <Panel title="Task Brief (brief.md)">
                  <div class="pb">
                    <Markdown text={detail.brief} />
                  </div>
                </Panel>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
