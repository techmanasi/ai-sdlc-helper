import { useEffect, useRef } from 'preact/hooks';
import { pollDelay } from './polling';

/**
 * Calls <load> on the delays of pollDelay(state, visible): no timer for a settled run or a hidden tab, and one load
 * when the tab becomes visible or the window gains focus. The first load is the caller's.
 */
export function usePoll(load: () => unknown, state: string | undefined, key: unknown): void {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const arm = () => {
      clearTimeout(timer);
      const d = pollDelay(state, visible());
      if (d !== null) timer = setTimeout(() => { latest.current(); arm(); }, d);
    };
    const back = () => { if (visible()) { latest.current(); arm(); } };
    arm();
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back); };
  }, [state, key]);
}
