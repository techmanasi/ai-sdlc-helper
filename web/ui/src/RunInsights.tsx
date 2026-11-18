// What a run did, drawn: the stage rail with each stage's steps and the test lock on Red tests, the cost per stage,
// and what the run's records show about its worktree and pull request. The wording and the decisions are in insights.ts.
import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { LockOpen, LockView, RunView, StageRound, Timeline, UsageTotals } from './api';
import { cacheShare, costCell, costNotes, durationText, guarantees, hasUsage, lockSentence, openSentence, spanSeconds, tileLine, tokensText, usageText, type TileState, totalCells } from './insights';
import { hiddenCounts, mayAutoScroll, paneTone, prBadge, roundLabel, scrollTarget } from './stagePane';
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

/** True on a phone-width window; the rail is then a column and a stage's details open under it. */
export function usePhone(): boolean {
  const q = '(max-width: 640px)';
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const m = matchMedia(q);
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return on;
}

/**
 * The stages in one row. Each tile shows a progress bar, the state, a Round pill, the model, and one line (the live step
 * and time, the files and time, or "Not started"). The shown tile is joined to the pane under the row like a tab. A row
 * wider than the window scrolls sideways, with the count of hidden stages at each edge; on a phone it is a column and
 * the pane opens under the tile.
 */
export function StageRail({ stages, timeline, step, locked, lockOpen, shown, followed, pr, phone, phoneOpen, onSelect, children }: {
  stages: RailStage[];
  timeline?: Timeline;
  step?: RunView['step'];
  /** The test lock is recorded and confirmed (see verifiedLock): only then does Red tests carry the lock mark. */
  locked: boolean;
  /** Tests that were locked are being changed on purpose: Red tests carries an open lock instead. */
  lockOpen?: LockOpen | null;
  shown: string;
  /** The stage the run is at; the rail scrolls it into view when it starts. */
  followed: string;
  pr?: ReturnType<typeof prBadge>;
  phone: boolean;
  phoneOpen: boolean;
  onSelect(key: string): void;
  /** The pane for the shown stage. */
  children?: ComponentChildren;
}) {
  const live = stages.some(s => s.state === 'active');
  const now = useNow(live);
  const span = (name: string) => timeline?.stages.find(s => s.stage === name);
  const track = useRef<HTMLDivElement>(null);
  const lastHand = useRef(0);
  const [hidden, setHidden] = useState({ left: 0, right: 0 });
  const measure = () => {
    const el = track.current;
    if (!el) return;
    const tiles = Array.from(el.children).map(c => ({ left: (c as HTMLElement).offsetLeft, width: (c as HTMLElement).offsetWidth }));
    const h = hiddenCounts(tiles, el.scrollLeft, el.clientWidth);
    setHidden(o => (o.left === h.left && o.right === h.right ? o : h));
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [stages.length, phone]);
  // The running stage is scrolled into view when it starts, unless the user has just scrolled the rail themselves.
  useEffect(() => {
    const el = track.current;
    if (!el || phone || !followed) return;
    const tile = Array.from(el.children).find(c => (c as HTMLElement).dataset.key === followed) as HTMLElement | undefined;
    if (!tile || !mayAutoScroll(lastHand.current, Date.now())) return;
    const to = scrollTarget({ left: tile.offsetLeft, width: tile.offsetWidth }, el.scrollLeft, el.clientWidth);
    if (to !== null) el.scrollTo({ left: to, behavior: 'smooth' });
  }, [followed, phone]);
  const hand = () => { lastHand.current = Date.now(); };
  const nudge = (dir: number) => { hand(); track.current?.scrollBy({ left: dir * 240, behavior: 'smooth' }); };
  const shownState = stages.find(s => s.key === shown)?.state;
  return (
    <div class={`rail2-wrap ${phone ? 'rail2-phone' : ''}`}>
      <div class="rail2-frame">
        <div class="rail2" role="tablist" aria-label="Stages" ref={track} onScroll={measure} onWheel={hand} onTouchStart={hand} onPointerDown={hand}>
          {stages.flatMap(s => {
            const sp = span(s.name);
            const fill = s.state === 'active' && step && step.n > 0 ? Math.max(8, Math.round(((step.i - 0.5) / step.n) * 100)) : s.state === 'pending' ? 0 : 100;
            const cost = usageText(sp?.usage);
            const on = shown === s.key;
            const round = roundLabel(sp?.passes);
            const tile = (
              <button
                type="button" role="tab" aria-selected={on} aria-controls="stage-detail" data-key={s.key}
                class={`tile tile-${s.state} tone-${paneTone(s.state)} ${on ? 'tile-on' : ''} ${s.afterPr ? 'tile-after' : ''}`}
                onClick={() => onSelect(s.key)}
              >
                <span class="tile-bar" aria-hidden="true"><span class="tile-fill" style={{ width: `${fill}%` }} /></span>
                <span class="tile-head">
                  <span class="tile-icon" aria-hidden="true">{s.state === 'active' ? <Spinner /> : ICON[s.state]}</span>
                  <span class="tile-name">{s.name}</span>
                  {round && <span class="tile-round">{round}</span>}
                  {s.name === 'Red tests' && lockOpen && <span class="tile-lock tile-lock-open" role="img" aria-label="Test lock open" title={openSentence(lockOpen)}><LockIcon open /> unlocked</span>}
                  {s.name === 'Red tests' && locked && !lockOpen && <span class="tile-lock" role="img" aria-label="Tests locked" title="The tests are committed and locked: a later stage that changes them is stopped"><LockIcon /> locked</span>}
                  {s.key === 'finalise' && pr && <span class={`tile-pr tile-pr-${pr.tone}`} title={pr.title}>{pr.text}</span>}
                </span>
                <span class="tile-model mono">{s.model || (s.key === 'finalise' ? 'no agent' : 'default')}</span>
                <span class="tile-line">{tileLine(s.state, sp, s.files, s.state === 'active' ? step?.label || '' : '', now)}</span>
                {cost && <span class="tile-cost mono">{cost}</span>}
                <span class="sr">{s.state}</span>
              </button>
            );
            return phone && on && phoneOpen ? [tile, <div class="phone-pane" key={`${s.key}-pane`}>{children}</div>] : [tile];
          })}
        </div>
        {!phone && hidden.left > 0 && <button type="button" class="rail2-edge rail2-edge-l" onClick={() => nudge(-1)} aria-label={`${hidden.left} stage${hidden.left > 1 ? 's' : ''} hidden on the left; scroll left`}>‹ {hidden.left}</button>}
        {!phone && hidden.right > 0 && <button type="button" class="rail2-edge rail2-edge-r" onClick={() => nudge(1)} aria-label={`${hidden.right} stage${hidden.right > 1 ? 's' : ''} hidden on the right; scroll right`}>{hidden.right} ›</button>}
      </div>
      {!phone && shownState && <div class={`stage-pane tone-${paneTone(shownState)}`}>{children}</div>}
    </div>
  );
}

/**
 * The steps of one round of a stage, oldest first, each with how long it took; the open one spins, one cut off by a
 * stop is red. Steps the stage has yet to run (<plan>) follow as dashed pills with no time.
 */
export function StepList({ steps, running, plan }: { steps: StageStepLike[]; running: boolean; plan?: string[] }) {
  const now = useNow(running);
  const planned = (plan || []).slice(steps.length);
  if (!steps.length && !planned.length) return <p class="small muted" style={{ margin: 0 }}>No steps were recorded for this stage.</p>;
  return (
    <ol class="steps">
      {steps.map(st => {
        const open = !st.ended;
        const sec = spanSeconds(st.started, st.ended, now);
        return (
          <li class={`step ${open && running ? 'step-open' : open ? 'step-cut' : 'step-done'}`}>
            <span class="step-dot" aria-hidden="true">{open && running ? <Spinner /> : open ? <span class="step-stop" /> : '✓'}</span>
            <span class="step-label">{st.label}</span>
            <span class="step-time mono">{open && !running ? `failed at ${durationText(sec)}` : durationText(sec)}</span>
          </li>
        );
      })}
      {planned.map(label => (
        <li class="step step-plan"><span class="step-dot" aria-hidden="true" /><span class="step-label">{label}</span></li>
      ))}
    </ol>
  );
}
type StageStepLike = StageRound['steps'][number];

/** The pane's back bar: shown when the user picked a stage other than the followed one. */
export function BackBar({ text, back, onBack }: { text: string; back: string; onBack(): void }) {
  return (
    <div class="pane-back" role="status">
      <span>{text}</span>
      <button type="button" class="btn btn-s" onClick={onBack}>{back}</button>
    </div>
  );
}

/** Round chips: "Round 1" to "Round N" for a stage that ran more than once, the picked one inverted. */
export function RoundChips({ count, picked, onPick }: { count: number; picked: number; onPick(n: number): void }) {
  if (count < 2) return null;
  return (
    <div class="rchips" role="group" aria-label="Rounds">
      {Array.from({ length: count }, (_, i) => i + 1).map(n => (
        <button type="button" class={`rchip ${n === picked ? 'rchip-on' : ''}`} aria-pressed={n === picked} onClick={() => onPick(n)}>Round {n}</button>
      ))}
    </div>
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
  if (open) return <p class="lock-detail" style={{ margin: 0 }}><span class="lock-badge lock-badge-open"><LockIcon open /> OPEN</span><span class="s-paused">{openSentence(open)}</span></p>;
  if (!lock) return <p class="small muted" style={{ margin: 0 }}>No test lock is recorded for this run. It is set when Red tests commits the tests, and removed if a stage at or before Red tests is run again.</p>;
  return (
    <div class="col" style={{ gap: '8px' }}>
      <p class="lock-detail" style={{ margin: 0 }}><span class="lock-badge lock-badge-closed"><LockIcon /> CLOSED</span><span>{lockSentence(lock)}</span></p>
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
        <dl class="totals" aria-label="Whole run">
          {totalCells(timeline.usage).map(c => <div class="total" title={c.title}><dt>{c.label}</dt><dd>{c.value}</dd></div>)}
        </dl>
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
