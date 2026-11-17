// What a run did, drawn: the stage rail with each stage's steps and the test lock on Red tests, the cost per stage,
// and what the run's records show about its worktree and pull request. The wording and the decisions are in insights.ts.
import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { LockOpen, LockView, RunView, StageSpan, Timeline, UsageTotals } from './api';
import { cacheShare, costCell, costNotes, durationText, guarantees, hasUsage, lockSentence, openSentence, spanSeconds, tileLine, tokensText, usageText, type TileState } from './insights';
import { Panel, Spinner } from './ui';

/** The time now, refreshed every second while `on` (a running stage shows its elapsed time). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** A padlock: closed, or with its shackle swung up and out so open and closed differ at a glance (the emoji pair do not). */
export function LockIcon({ open }: { open?: boolean }) {
  return (
    <svg class="lock-svg" width={open ? 17 : 12} height="14" viewBox={open ? '0 0 17 14' : '0 0 12 14'} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      {/* Open: the shackle hangs off the body's right edge, swung up and out, its free end well clear of the body. */}
      {open ? <path d="M9.5 7.5V4a3 3 0 0 1 6 0v1.5" /> : <path d="M3 7.5V4.5a3 3 0 0 1 6 0v3" />}
      <rect x="1" y="7.5" width="10" height="6" rx="1.5" fill={open ? 'none' : 'currentColor'} />
    </svg>
  );
}

const ICON: Record<TileState, string> = { done: '✓', active: '', paused: '⏸', failed: '✕', pending: '', skipped: '–' };

export interface RailStage { name: string; key: string; state: TileState; model: string; files: number; afterPr?: boolean }

/**
 * The stages in one row. Each tile shows a progress bar, the state, the model, and one line (the live step and time, the
 * files and time, or "Not started"). Picking a tile opens its details under the row: the steps it went through and
 * whatever the caller renders for it (its agent, model and effort).
 */
export function StageRail({ stages, timeline, step, locked, lockOpen, selected, onSelect, children }: {
  stages: RailStage[];
  timeline?: Timeline;
  step?: RunView['step'];
  /** The test lock is recorded and confirmed (see verifiedLock): only then does Red tests carry the lock mark. */
  locked: boolean;
  /** Tests that were locked are being changed on purpose: Red tests carries an open lock instead. */
  lockOpen?: LockOpen | null;
  selected: string;
  onSelect(key: string): void;
  children?: ComponentChildren;
}) {
  const live = stages.some(s => s.state === 'active');
  const now = useNow(live);
  const span = (name: string) => timeline?.stages.find(s => s.stage === name);
  return (
    <div class="rail2-wrap">
      <div class="rail2" role="tablist" aria-label="Stages">
        {stages.map(s => {
          const sp = span(s.name);
          const fill = s.state === 'active' && step && step.n > 0 ? Math.max(8, Math.round(((step.i - 0.5) / step.n) * 100)) : s.state === 'pending' ? 0 : 100;
          const cost = usageText(sp?.usage);
          return (
            <button
              type="button" role="tab" aria-selected={selected === s.key} aria-controls="stage-detail"
              class={`tile tile-${s.state} ${selected === s.key ? 'tile-on' : ''} ${s.afterPr ? 'tile-after' : ''}`}
              onClick={() => onSelect(selected === s.key ? '' : s.key)}
            >
              <span class="tile-bar" aria-hidden="true"><span class="tile-fill" style={{ width: `${fill}%` }} /></span>
              <span class="tile-head">
                <span class="tile-icon" aria-hidden="true">{s.state === 'active' ? <Spinner /> : ICON[s.state]}</span>
                <span class="tile-name">{s.name}</span>
                {s.name === 'Red tests' && lockOpen && <span class="tile-lock tile-lock-open" role="img" aria-label="Test lock open" title={openSentence(lockOpen)}><LockIcon open /> unlocked</span>}
                {s.name === 'Red tests' && locked && !lockOpen && <span class="tile-lock" role="img" aria-label="Tests locked" title="The tests are committed and locked: a later stage that changes them is stopped"><LockIcon /> locked</span>}
              </span>
              <span class="tile-model mono">{s.model || (s.key === 'finalise' ? 'no agent' : 'default')}</span>
              <span class="tile-line">{tileLine(s.state, sp, s.files, s.state === 'active' ? step?.label || '' : '', now)}</span>
              {cost && <span class="tile-cost mono">{cost}</span>}
              <span class="sr">{s.state}</span>
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
}

/** The steps a stage went through, oldest first, each with how long it took; the open one spins. */
export function StepList({ span, running }: { span?: StageSpan; running: boolean }) {
  const now = useNow(running);
  if (!span || !span.steps.length) return <p class="small muted" style={{ margin: 0 }}>{span ? 'No steps were recorded for this stage.' : 'This stage has not run yet.'}</p>;
  return (
    <ol class="steps">
      {span.steps.map(st => {
        const open = !st.ended;
        const sec = spanSeconds(st.started, st.ended, now);
        return (
          <li class={`step ${open && running ? 'step-open' : open ? 'step-cut' : 'step-done'}`}>
            <span class="step-dot" aria-hidden="true">{open && running ? <Spinner /> : open ? '■' : '✓'}</span>
            <span class="step-label">{st.label}</span>
            <span class="step-time mono">{durationText(sec)}</span>
          </li>
        );
      })}
      {span.passes > 1 && <li class="small muted" style={{ listStyle: 'none' }}>Pass {span.passes} of this stage; the steps above are the latest pass.</li>}
    </ol>
  );
}

/** How the pipeline protects a run, and what this run's records show of its worktree and pull request. */
export function Guarantees({ v }: { v: Parameters<typeof guarantees>[0] }) {
  return (
    <ul class="guar" aria-label="What protects this run">
      {guarantees(v).map(g => (
        <li class={`guar-item guar-${g.state}`}>
          <span class="guar-mark" aria-hidden="true">{g.key === 'gates' ? '⛩' : g.key === 'isolated' ? '⑂' : '✓'}</span>
          <span class="guar-text"><strong>{g.title}</strong><span class="small muted">{g.detail}</span></span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The test lock, inside the Red tests stage. It is drawn only from a recorded and confirmed lock, or as open while the
 * engine records that locked tests are being changed; without either it says when the lock is set and claims nothing.
 */
export function LockDetail({ lock, open }: { lock: LockView | null; open?: LockOpen | null }) {
  if (open) return <p class="s-paused" style={{ margin: 0 }}><LockIcon open /> {openSentence(open)}</p>;
  if (!lock) return <p class="small muted" style={{ margin: 0 }}>No test lock is recorded for this run. It is set when Red tests commits the tests, and removed if a stage at or before Red tests is run again.</p>;
  return (
    <div class="col" style={{ gap: '8px' }}>
      <p style={{ margin: 0 }}><LockIcon /> {lockSentence(lock)}</p>
      {(lock.guards.length > 0 || lock.relocks > 0) && (
        <ol class="locklog">
          {lock.guards.map(g => (
            <li>
              <span class="locklog-dot dot-wait" />
              <span><strong>{g.stage}</strong> changed {g.restored.length || 'some'} locked test file{g.restored.length === 1 ? '' : 's'}; the run stopped there
                {g.restored.length > 0 && <span class="mono small muted" style={{ display: 'block' }}>{g.restored.slice(0, 4).join(', ')}{g.restored.length > 4 ? ` +${g.restored.length - 4} more` : ''}</span>}
              </span>
            </li>
          ))}
          {lock.relocks > 0 && <li><span class="locklog-dot dot-run" /><span><strong>Test repair</strong> changed claimed tests {lock.relocks} time{lock.relocks > 1 ? 's' : ''}; the lock was set again each time</span></li>}
        </ol>
      )}
    </div>
  );
}

const UsageRow = ({ name, u, total }: { name: string; u: UsageTotals; total?: boolean }) => (
  <tr class={total ? 'usage-total' : ''}>
    <th scope="row">{name}</th>
    <td>{durationText(u.durationSec) || '—'}</td>
    <td>{u.turns || '—'}</td>
    <td title={`${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out · ${u.cacheRead.toLocaleString()} cache read · ${u.cacheWrite.toLocaleString()} cache write`}>{tokensText(u.tokens || u.input + u.output)}</td>
    <td>{cacheShare(u) === null ? '—' : `${cacheShare(u)}%`}</td>
    <td>{costCell(u)}</td>
  </tr>
);

/** Time, turns, tokens and cost per stage, with the run's totals. A cost with no figure and no known price shows a dash. */
export const UsagePanel = memo(function UsagePanel({ timeline }: { timeline?: Timeline }) {
  if (!timeline || !hasUsage(timeline.usage)) return null;
  const rows = timeline.stages.filter(s => hasUsage(s.usage));
  const max = Math.max(1, ...rows.map(s => s.usage.tokens));
  return (
    <Panel title="Cost and tokens" extra={<span class="chip">{usageText(timeline.usage)}</span>}>
      <div class="pb col" style={{ gap: '10px' }}>
        <div class="usage-bars" aria-hidden="true">
          {rows.map(s => <span class="usage-bar" style={{ flexGrow: Math.max(0.04, s.usage.tokens / max) }} title={`${s.stage}: ${tokensText(s.usage.tokens)} tokens`}><span>{s.stage}</span></span>)}
        </div>
        <div class="usage-scroll">
          <table class="usage">
            <thead><tr><th scope="col">Stage</th><th scope="col">Agent time</th><th scope="col">Turns</th><th scope="col">Tokens</th><th scope="col">Cached</th><th scope="col">Cost</th></tr></thead>
            <tbody>
              {rows.map(s => <UsageRow name={s.passes > 1 ? `${s.stage} ×${s.passes}` : s.stage} u={s.usage} />)}
              <UsageRow name="Whole run" u={timeline.usage} total />
            </tbody>
          </table>
        </div>
        {costNotes(timeline.usage).map(n => <p class="small muted" style={{ margin: 0 }}>{n}</p>)}
      </div>
    </Panel>
  );
});

/**
 * The end of run.out. It is its own component so a new line redraws only this panel, and it follows the output down
 * unless the reader has scrolled up.
 */
export const OutputPanel = memo(function OutputPanel({ tail, extra }: { tail: string[]; extra?: ComponentChildren }) {
  const pre = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const text = tail.join('\n');
  useEffect(() => { const el = pre.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [text]);
  return (
    <Panel title="Output" extra={extra}>
      <pre
        ref={pre} class="code mono out" tabIndex={0} aria-label="Run output"
        onScroll={e => { const el = e.currentTarget as HTMLPreElement; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      >{text || 'No output yet.'}</pre>
    </Panel>
  );
}, (a, b) => a.tail === b.tail || a.tail.join('\n') === b.tail.join('\n'));
