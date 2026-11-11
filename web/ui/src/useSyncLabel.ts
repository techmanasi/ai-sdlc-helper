import { useEffect, useState } from 'preact/hooks';
import { api } from './api';

/** What a Sync PR in flight is doing now ("Asking GitHub…"): asked once a second while `active`, '' otherwise. */
export function useSyncLabel(active: boolean, project: string, slug: string): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!active) { setLabel(''); return undefined; }
    let alive = true;
    const tick = () => { api.syncPrProgress(project, slug).then(r => { if (alive) setLabel(r.label); }, () => undefined); };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [active, project, slug]);
  return label;
}
