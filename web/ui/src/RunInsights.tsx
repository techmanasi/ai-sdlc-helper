// What a run did, drawn: the stage rail with each stage's steps, the test lock, the cost per stage, and the four
// promises of the pipeline as they stand for this run. The wording and the decisions are in insights.ts.
import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { LockView, RunView, StageSpan, Timeline, UsageTotals } from './api';
import { cacheShare, costText, durationText, guarantees, hasUsage, lockSentence, spanSeconds, tileLine, tokensText, type TileState } from './insights';
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

const ICON: Record<TileState, string> = { done: '✓', active: '', paused: '⏸', failed: '✕', pending: '', skipped: '–' };

export interface RailStage { name: string; key: string; state: TileState; model: string; files: number; afterPr?: boolean }

/**
 * The stages in one row. Each tile shows a progress bar, the state, the model, and one line (the live step and time, the
 * files and time, or "Not started"). Picking a tile opens its details under the row: the steps it went through and
 * whatever the caller renders for it (its agent, model and effort).
 */
export function StageRail({ stages, timeline, step, selected, onSelect, children }: {
  stages: RailStage[];
  timeline?: Timeline;
  step?: RunView['step'];
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
          const cost = sp && sp.usage.costUsd !== null ? costText(sp.usage.costUsd) : sp && sp.usage.tokens ? `${tokensText(sp.usage.tokens)} tok` : '';
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
                {s.name === 'Red tests' && s.state === 'done' && <span class="tile-lock" title="The tests are locked from here on">🔒</span>}
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

/** The four promises, each with what this run's records show for it. */
export function Guarantees({ v }: { v: Parameters<typeof guarantees>[0] }) {
  return (
    <ul class="guar" aria-label="What protects this run">
      {guarantees(v).map(g => (
        <li class={`guar-item guar-${g.state}`}>
          <span class="guar-mark" aria-hidden="true">{g.key === 'lock' ? '🔒' : g.key === 'gates' ? '⛩' : g.key === 'isolated' ? '⑂' : '✓'}</span>
          <span class="guar-text"><strong>{g.title}</strong><span class="small muted">{g.detail}</span></span>
        </li>
      ))}
    </ul>
  );
}

/** The test lock: what was locked and when, and every time a stage was stopped for changing a locked test. */
export const LockPanel = memo(function LockPanel({ lock, redCommit, stage }: { lock: LockView | null | undefined; redCommit: string; stage: string }) {
  if (!lock && !redCommit) {
    return (
      <Panel title="Test lock" extra={<span class="chip chip-pending">not locked yet</span>}>
        <div class="pb small muted">Red tests writes the tests first and proves they fail. From that commit on, Implement and Review cannot change them{stage ? '' : ' once the run starts'}.</div>
      </Panel>
    );
  }
  const sha = (lock?.sha || redCommit).slice(0, 7);
  return (
    <Panel title={<span>🔒 Test lock</span>} extra={<span class="chip chip-done">locked at <span class="mono">{sha}</span></span>}>
      <div class="pb col" style={{ gap: '10px' }}>
        <p style={{ margin: 0 }}>{lock ? lockSentence(lock) : 'The tests were locked when Red tests finished. Implement and Review cannot change them.'}</p>
        <ol class="locklog">
          <li><span class="locklog-dot dot-done" /><span><strong>Red tests</strong> wrote the tests and saw them fail{lock?.origRedSha ? <> · <span class="mono small">{lock.origRedSha.slice(0, 7)}</span></> : null}</span></li>
          {(lock?.guards || []).map(g => (
            <li>
              <span class="locklog-dot dot-wait" />
              <span><strong>{g.stage}</strong> changed {g.restored.length || 'some'} locked test file{g.restored.length === 1 ? '' : 's'}; the run stopped there instead of going on
                {g.restored.length > 0 && <span class="mono small muted" style={{ display: 'block' }}>{g.restored.slice(0, 4).join(', ')}{g.restored.length > 4 ? ` +${g.restored.length - 4} more` : ''}</span>}
              </span>
            </li>
          ))}
          {lock && lock.relocks > 0 && <li><span class="locklog-dot dot-run" /><span><strong>Test repair</strong> changed claimed tests {lock.relocks} time{lock.relocks > 1 ? 's' : ''}; each claim was checked and audited, then the lock was set again</span></li>}
          {lock && !lock.guards.length && !lock.relocks && <li><span class="locklog-dot dot-done" /><span>No agent has touched them since</span></li>}
        </ol>
      </div>
    </Panel>
  );
});

const UsageRow = ({ name, u, total }: { name: string; u: UsageTotals; total?: boolean }) => (
  <tr class={total ? 'usage-total' : ''}>
    <th scope="row">{name}</th>
    <td>{durationText(u.durationSec) || '—'}</td>
    <td>{u.turns || '—'}</td>
    <td title={`${u.input.toLocaleString()} in · ${u.output.toLocaleString()} out · ${u.cacheRead.toLocaleString()} cache read · ${u.cacheWrite.toLocaleString()} cache write`}>{tokensText(u.tokens || u.input + u.output)}</td>
    <td>{cacheShare(u) === null ? '—' : `${cacheShare(u)}%`}</td>
    <td>{costText(u.costUsd)}</td>
  </tr>
);

/** Time, turns, tokens and cost per stage, with the run's totals. A harness that reports no cost shows a dash. */
export const UsagePanel = memo(function UsagePanel({ timeline }: { timeline?: Timeline }) {
  if (!timeline || !hasUsage(timeline.usage)) return null;
  const rows = timeline.stages.filter(s => hasUsage(s.usage));
  const max = Math.max(1, ...rows.map(s => s.usage.tokens));
  return (
    <Panel title="Cost and tokens" extra={<span class="chip">{costText(timeline.usage.costUsd)} · {tokensText(timeline.usage.tokens)} tokens</span>}>
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
        {timeline.usage.costUsd === null && <p class="small muted" style={{ margin: 0 }}>The agents used on this run do not report a cost; tokens are counted where they report them.</p>}
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
