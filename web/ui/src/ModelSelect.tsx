// One searchable model dropdown: a compact trigger that opens a panel with a filter box and the model list.
// A native <select> cannot be filtered while it is open, and the stage rail is 150px wide, so a long
// `provider/model` id overflows the card. The panel is fixed-positioned because the rail scrolls and would clip
// an absolutely positioned popup.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { configValue, filterModels, nextIndex } from './modelFilter';

export interface ModelChoice {
  id: string;
  name: string;
  displayName?: string;
  providerId?: string;
  providerName?: string;
}

interface ModelSelectProps {
  /** What this control picks for ("Implement", "Reviewer 1"): used in every aria-label. */
  name: string;
  models: readonly ModelChoice[];
  value: string;
  defaultLabel: string;
  /** The harness the models belong to, for the "<harness>:<model>" keys in `taken`. */
  harness: string;
  /** "<harness>:<model>" choices other stages already hold: still offered, but disabled. */
  taken?: string[];
  /** Whether this harness runs one model through several providers: only then is a provider filter offered. */
  multipleProvider?: boolean;
  onChange: (value: string) => void;
}

interface Panel {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MIN_WIDTH = 260;
const MAX_HEIGHT = 300;
const MIN_HEIGHT = 120;
const GAP = 4;
const EDGE = 8;

export function ModelSelect({ name, models, value, defaultLabel, harness, taken, multipleProvider, onChange }: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [active, setActive] = useState(0);
  const [panel, setPanel] = useState<Panel | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const providers = useMemo(() => Array.from(new Map(models.filter(m => m.providerId).map(m => [m.providerId, m.providerName || m.providerId!])).entries()).sort((a, b) => (a[1] || '').localeCompare(b[1] || '')), [models]);
  const providerModels = useMemo(() => provider ? models.filter(m => m.providerId === provider) : models, [models, provider]);
  const matching = useMemo(() => filterModels(providerModels, query), [providerModels, query]);
  // A row's value is what the stage config stores: the display name, or the provider-routed id when providers share it.
  const rows = useMemo(() => [
    { choice: '', label: defaultLabel, detail: '', disabled: false },
    ...matching.map(model => {
      const choice = configValue(model, models);
      const providerLabel = model.providerName || model.providerId || '';
      const detail = [model.name === choice ? '' : model.name, multipleProvider && !provider ? providerLabel : ''].filter(Boolean).join(' · ');
      return { choice, label: choice, detail, disabled: choice !== value && !!taken?.includes(`${harness}:${choice}`) };
    }),
  ], [matching, models, defaultLabel, harness, taken, value, multipleProvider, provider]);

  const show = () => {
    const el = trigger.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, MIN_WIDTH), window.innerWidth - 2 * EDGE);
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE));
    const below = window.innerHeight - rect.bottom - GAP - EDGE;
    const above = rect.top - GAP - EDGE;
    const up = below < MIN_HEIGHT && above > below;
    const height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, up ? above : below));
    setPanel({ left, top: up ? rect.top - GAP - height : rect.bottom + GAP, width, height });
    setQuery('');
    setProvider('');
    const at = value ? models.findIndex(model => model.id === value || configValue(model, models) === value) : -1;
    setActive(at >= 0 ? at + 1 : 0);
    setOpen(true);
  };

  const close = (focusTrigger = false) => {
    setOpen(false);
    setQuery('');
    if (focusTrigger) trigger.current?.focus();
  };

  const choose = (id: string) => {
    onChange(id);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const target = e.target as Node;
      if (box.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    // Any scroll outside the panel moves the trigger away from its popup, so the panel closes. A scroll of the panel's
    // own model list is not that: capture hears it too, and closing here would make a long list unscrollable.
    const pageScroll = (e: Event) => { if (box.current?.contains(e.target as Node)) return; setOpen(false); };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', pageScroll, true);
    window.addEventListener('resize', resize);
    search.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', pageScroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(nextIndex(active, 1, rows.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(nextIndex(active, -1, rows.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row && !row.disabled) choose(row.choice);
    }
  };

  const label = value || defaultLabel;
  return (
    <span class="picker">
      <button ref={trigger} type="button" class="sel pick-btn" aria-label={`${name} model`} aria-haspopup="listbox"
        aria-expanded={open} title={label} onClick={() => (open ? close() : show())}>
        <span class="pick-text">{label}</span>
        <span class="pick-caret" aria-hidden="true">▾</span>
      </button>
      {open && panel && (
        <div ref={box} class="pick-panel" style={{ left: `${panel.left}px`, top: `${panel.top}px`, width: `${panel.width}px` }}>
          <input ref={search} class="inp mono" aria-label={`${name} model search`} placeholder="Search models…" value={query}
            onInput={e => { setQuery((e.target as HTMLInputElement).value); setActive(0); }} onKeyDown={onKeyDown} />
          {multipleProvider && providers.length > 1 && <select class="sel pick-provider" aria-label={`${name} provider filter`} value={provider} onChange={e => { setProvider((e.target as HTMLSelectElement).value); setActive(0); }}>
            <option value="">All providers</option>
            {providers.map(([id, label]) => <option value={id}>{label}</option>)}
          </select>}
          <div class="pick-list" role="listbox" aria-label={`${name} models`} style={{ maxHeight: `${panel.height - 44}px` }}>
            {rows.map((row, i) => (
              <button type="button" role="option" aria-selected={row.choice === value} disabled={row.disabled}
                class={`pick-item${i === active ? ' pick-active' : ''}${row.choice === value ? ' pick-selected' : ''}`}
                onMouseDown={e => e.preventDefault()} onMouseMove={() => { if (i !== active) setActive(i); }} onClick={() => choose(row.choice)}>
                <span class="pick-id mono">{row.choice || row.label}</span>
                {row.detail && <span class="pick-detail small muted">{row.detail}</span>}
              </button>
            ))}
            {query.trim() && matching.length === 0 && (
              <span role="presentation" class="pick-empty small muted">no models match “{query.trim()}”</span>
            )}
            {!query.trim() && models.length === 0 && (
              <span role="presentation" class="pick-empty small muted">this harness listed no models</span>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
