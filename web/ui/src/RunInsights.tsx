// What a run did, drawn: the stage rail with each stage's steps and the test lock on Red tests, the cost per stage,
// and what the run's records show about its worktree and pull request. The wording and the decisions are in insights.ts.
import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { AttemptRound, LockOpen, LockView, RunView, StageRound, Timeline, UsageTotals } from './api';
import { cacheShare, costCell, costModeShown, costNotes, durationText, guarantees, hasUsage, lockSentence, openSentence, readCostMode, saveCostMode, tileCostText, tileLine, tokensText, usageText, type CostMode, type TileState, totalCells } from './insights';
import { attemptMarks, attemptMarksLabel, backToImplementText, doneFoldLabel, edgeScrollTarget, foldDone, hiddenCounts, mayAutoScroll, paneTone, prBadge, roundLabel, roundMarks, roundMarksLabel, scrollTarget, stepPills, type AttemptMark } from './stagePane';
import { CopyButton, Panel, Spinner } from './ui';

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
const MARK_GLYPH: Record<'done' | 'stop' | 'run' | 'idle', string> = { done: '✓', stop: '■', run: '●', idle: '○' };
const ATTEMPT_GLYPH: Record<AttemptMark['tone'], string> = { done: '✓', stop: '✕', run: '●', idle: '○' };

/** A small row of recorded round marks on a tile; the accessible name carries the whole story. */
function RoundMarks({ rounds, label }: { rounds: readonly StageRound[]; label: string }) {
  return (
    <span class="tile-marks" role="img" aria-label={label} title={label}>
      {roundMarks(rounds).map(m => <span class={`tile-mark mark-${m.tone}`} aria-hidden="true">{MARK_GLYPH[m.tone]}</span>)}
    </span>
  );
}

/** The Implement tile's attempt marks, in the same pattern as a stage's round marks. */
function AttemptMarks({ attempts, max, label }: { attempts: readonly AttemptRound[]; max?: number; label: string }) {
  return (
    <span class="tile-marks" role="img" aria-label={label} title={label}>
      {attemptMarks(attempts, max).map(m => <span class={`tile-mark mark-${m.tone}`} aria-hidden="true">{ATTEMPT_GLYPH[m.tone]}</span>)}
    </span>
  );
}

const firstLine = (text: string): string => text.split('\n').map(l => l.trim()).find(Boolean) || '';

/**
 * One row per recorded Implement attempt: what its record says about the agent and exit code, why it went back, and
 * its recorded error behind Show error. No row claims an error the run did not write.
 */
export function AttemptRows({ attempts, max, onOpenLog }: { attempts: readonly AttemptRound[]; max?: number; onOpenLog(path: string): void }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <ol class="attempt-list" aria-label="Implement attempts">
      {attempts.map((a, i) => {
        const open = expanded === i;
        const back = backToImplementText(a);
        const failed = !a.running && (a.exitCode !== 0 || (a.gate?.failing?.length ?? 0) > 0);
        const tone = a.running ? 'running' : failed ? 'failed' : 'done';
        const errId = `attempt-error-${i}`;
        const log = a.log;
        return (
          <li class={`attempt-row attempt-${tone}`} key={`${i}-${a.at}`}>
            <div class="attempt-head">
              <div class="attempt-id">
                <strong>Attempt {i + 1}{max ? ` of ${max}` : ''}</strong>
                <span class="small muted">{a.at.slice(11, 16)}</span>
              </div>
              <div class="attempt-meta">
                <span class="mono small">{[a.agent, a.model].filter(Boolean).join(' · ')}</span>
                <span class={`attempt-status small attempt-status-${tone}`}>{a.running ? 'running' : `exit ${a.exitCode}`}</span>
                {back && <span class="attempt-back small">{back}</span>}
              </div>
              {a.error && (
                <button type="button" class="btn btn-s attempt-toggle" aria-expanded={open} aria-controls={errId}
                  onClick={() => setExpanded(open ? null : i)}>
                  {open ? 'Hide error' : 'Show error'}
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={open ? { transform: 'rotate(180deg)' } : undefined}><path d="M4 6l4 4 4-4" /></svg>
                </button>
              )}
            </div>
            {a.error && open && (
              <div class="attempt-error" id={errId}>
                <div class="attempt-error-head">
                  <span class="small s-failed"><strong>{firstLine(a.error)}</strong>{log && <> · <span class="mono">{log}</span></>}</span>
                  <span class="row">
                    <CopyButton text={a.error} />
                    {log && <button type="button" class="btn btn-s" onClick={() => onOpenLog(log)}>Open full log</button>}
                  </span>
                </div>
                <pre class="attempt-error-text mono">{a.error}</pre>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export interface RailStage { name: string; key: string; state: TileState; model: string; files: number; afterPr?: boolean }

/** The tiles inside the scrollable rail (not the pane that a phone inserts between them). */
function railTiles(el: HTMLElement): Array<{ left: number; width: number }> {
  return Array.from(el.children).filter(c => !!(c as HTMLElement).dataset.key).map(c => ({
    left: (c as HTMLElement).offsetLeft,
    width: (c as HTMLElement).offsetWidth,
  }));
}

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

const COST_MODES: readonly CostMode[] = ['cost', 'tokens', 'off'];
const COST_MODE_LABELS: Record<CostMode, string> = { cost: 'Cost', tokens: 'Tokens', off: 'Off' };

/** The viewer's choice of what the tiles show. Only drawn when a round recorded a dollar cost. */
export function CostModeToggle({ mode, onPick }: { mode: CostMode; onPick(m: CostMode): void }) {
  return (
    <div class="rail2-head">
      <span class="lbl">Show cost</span>
      <span class="segs cost-modes" role="group" aria-label="Show cost">
        {COST_MODES.map(m => (
          <button
            type="button" class={`seg ${mode === m ? 'seg-on' : ''}`}
            aria-pressed={mode === m ? 'true' : 'false'} onClick={() => onPick(m)}
          >{COST_MODE_LABELS[m]}</button>
        ))}
      </span>
    </div>
  );
}

/**
 * The stages in one row. Each tile shows a progress bar, the state, a Round pill, the model, and one line (the live step
 * and time, the files and time, or "Not started"). The shown tile is joined to the pane under the row like a tab. A row
 * wider than the window folds leading done stages and scrolls sideways, with an arrow at an edge that hides tiles;
 * on a phone it is a column and the pane opens under the tile.
 */
export function StageRail({ stages, timeline, step, attempts, attemptMax, locked, lockOpen, shown, followed, pr, phone, phoneOpen, onSelect, children }: {
  stages: RailStage[];
  timeline?: Timeline;
  step?: RunView['step'];
  /** Recorded Implement attempts; only the Implement tile draws their marks. */
  attempts?: readonly AttemptRound[];
  /** The iteration limit from the run's status, when it recorded one. */
  attemptMax?: number;
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
  const costShown = costModeShown(timeline?.usage);
  const [costMode, setCostMode] = useState<CostMode>(() => readCostMode(timeline?.usage));
  // The timeline arrives after the first render: read the saved choice (or the cost default) once dollars appear.
  useEffect(() => { setCostMode(readCostMode(timeline?.usage)); }, [costShown]);
  const tileMode: CostMode = costShown ? costMode : 'tokens';
  const pickCostMode = (m: CostMode) => { saveCostMode(m); setCostMode(m); };
  const span = (name: string) => timeline?.stages.find(s => s.stage === name);
  const track = useRef<HTMLDivElement>(null);
  const lastHand = useRef(0);
  // Measure the un-folded rail once. Keeping that width prevents a fold that fits from immediately unfolding again.
  const fullWidth = useRef(0);
  const [widthFits, setWidthFits] = useState(true);
  const [showDone, setShowDone] = useState(false);
  const [hidden, setHidden] = useState({ left: 0, right: 0 });
  const fold = foldDone(stages, phone || widthFits || showDone, shown);
  const measure = () => {
    const el = track.current;
    if (!el) return;
    if (!fold.folded.length) fullWidth.current = el.scrollWidth;
    // Above the fixed-tile breakpoint the tiles flex to fit, so the saved narrow measurement no longer applies.
    const flexible = typeof matchMedia === 'function' && !matchMedia('(max-width: 1100px)').matches;
    const fits = flexible || (fullWidth.current || el.scrollWidth) <= el.clientWidth + 1;
    setWidthFits(o => (o === fits ? o : fits));
    const h = hiddenCounts(railTiles(el), el.scrollLeft, el.clientWidth);
    setHidden(o => (o.left === h.left && o.right === h.right ? o : h));
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [stages.length, phone, fold.folded.length, showDone]);
  // The running stage is scrolled into view when it starts or the fold changes, unless the user just scrolled themselves.
  useEffect(() => {
    const el = track.current;
    if (!el || phone || !followed) return;
    const tile = Array.from(el.children).find(c => (c as HTMLElement).dataset.key === followed) as HTMLElement | undefined;
    if (!tile || !mayAutoScroll(lastHand.current, Date.now())) return;
    const to = scrollTarget({ left: tile.offsetLeft, width: tile.offsetWidth }, el.scrollLeft, el.clientWidth);
    if (to !== null) el.scrollTo({ left: to, behavior: 'smooth' });
  }, [followed, phone, fold.folded.length, showDone]);
  const hand = () => { lastHand.current = Date.now(); };
  const nudge = (direction: 'left' | 'right') => {
    hand();
    const el = track.current;
    if (!el) return;
    const to = edgeScrollTarget(railTiles(el), el.scrollLeft, el.clientWidth, direction);
    if (to !== null) el.scrollTo({ left: to, behavior: 'smooth' });
  };
  const unfold = () => {
    hand();
    setShowDone(true);
    requestAnimationFrame(() => track.current?.scrollTo({ left: 0, behavior: 'smooth' }));
  };
  const shownState = stages.find(s => s.key === shown)?.state;
  return (
    <div class={`rail2-wrap ${phone ? 'rail2-phone' : ''}`}>
      {costShown && <CostModeToggle mode={costMode} onPick={pickCostMode} />}
      <div class="rail2-frame">
        <div class="rail2" role="tablist" aria-label="Stages" ref={track} onScroll={measure} onWheel={hand} onTouchStart={hand} onPointerDown={hand}>
          {fold.folded.length > 0 && (
            <button
              type="button" class="tile tile-done rail2-fold tone-done" data-key="done-fold"
              aria-label={doneFoldLabel(fold.folded)} onClick={unfold}
            >
              <span class="tile-bar" aria-hidden="true"><span class="tile-fill" style={{ width: '100%' }} /></span>
              <span class="tile-head"><span class="tile-icon" aria-hidden="true">✓</span><span class="tile-name">{fold.folded.length} done</span></span>
            </button>
          )}
          {fold.shown.flatMap(s => {
            const sp = span(s.name);
            const fill = s.state === 'active' && step && step.n > 0 ? Math.max(8, Math.round(((step.i - 0.5) / step.n) * 100)) : s.state === 'pending' ? 0 : 100;
            const cost = tileCostText(tileMode, sp?.usage);
            const on = shown === s.key;
            const round = roundLabel(sp?.passes);
            // Only recorded rounds: a stage with one pass and no recorded cause has nothing to mark on the tile.
            const recorded = sp?.rounds ?? [];
            const marks = recorded.length >= 2 || recorded.some(r => r.cause) ? roundMarksLabel(recorded) : '';
            // Implement's tile shows attempts instead of stage rounds: both are recorded in logs/attempts.jsonl.
            const shownAttempts = s.key === 'implement' ? attempts || [] : [];
            const attemptLabel = shownAttempts.length ? attemptMarksLabel(shownAttempts, attemptMax) : '';
            const tile = (
              <button
                type="button" role="tab" aria-selected={on} aria-pressed={on} aria-controls="stage-detail" data-key={s.key}
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
                {attemptLabel ? <AttemptMarks attempts={shownAttempts} max={attemptMax} label={attemptLabel} /> : marks && <RoundMarks rounds={recorded} label={marks} />}
                <span class="tile-line">{tileLine(s.state, sp, s.files, s.state === 'active' ? step?.label || '' : '', now)}</span>
                {cost && <span class="tile-cost mono">{cost}</span>}
                <span class="sr">{s.state}</span>
              </button>
            );
            return phone && on && phoneOpen ? [tile, <div class="phone-pane" key={`${s.key}-pane`}>{children}</div>] : [tile];
          })}
        </div>
        {!phone && hidden.left > 0 && <>
          <span class="rail2-fade rail2-fade-l" aria-hidden="true" />
          <button type="button" class="rail2-scroll rail2-scroll-l" onClick={() => nudge('left')} aria-label="Scroll stages left">‹</button>
        </>}
        {!phone && hidden.right > 0 && <>
          <span class="rail2-fade rail2-fade-r" aria-hidden="true" />
          <button type="button" class="rail2-scroll rail2-scroll-r" onClick={() => nudge('right')} aria-label="Scroll stages right">›</button>
        </>}
      </div>
      {!phone && shownState && <div class={`stage-pane tone-${paneTone(shownState)}`}>{children}</div>}
    </div>
  );
}

/**
 * The steps of one round of a stage, oldest first, each with how long it took; the open one spins, one cut off by a
 * stop is red. Steps the stage has yet to run (<plan>) follow as dashed pills with no time.
 */
export function StepList({ round, state, plan = [], updated }: { round?: StageRound; state: TileState; plan?: string[]; updated: string }) {
  const now = useNow(state === 'active');
  const pills = stepPills(round, state, plan, updated, now);
  if (!pills.length) return <p class="small muted" style={{ margin: 0 }}>No steps were recorded for this stage.</p>;
  return (
    <ol class="steps">
      {pills.map(pill => (
        <li class={`step step-${pill.state}`}>
          <span class="step-dot" aria-hidden="true">{pill.state === 'open' ? <Spinner /> : pill.state === 'cut' ? <span class="step-stop" /> : pill.state === 'done' ? '✓' : null}</span>
          <span class="step-label">{pill.label}</span>
          {pill.time && <span class="step-time mono">{pill.time}</span>}
        </li>
      ))}
    </ol>
  );
}

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
        ref={pre} id="run-output" class="code mono out" tabIndex={0} aria-label="Run output"
        onScroll={e => { const el = e.currentTarget as HTMLPreElement; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      >{text || 'No output yet.'}</pre>
    </Panel>
  );
}, (a, b) => a.tail === b.tail || a.tail.join('\n') === b.tail.join('\n'));
