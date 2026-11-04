import { useEffect, useRef } from 'preact/hooks';
import { createStreamMachine } from './stream';
import { pageTrace } from './pageTrace';

export interface StreamOptions {
  /** The SSE address; null: no stream (a finished run, or nothing loaded yet). */
  url: string | null;
  /** The events to listen for besides `ping`, with what to do with their JSON data. */
  on: Record<string, (data: any) => void>;
  /** One backup GET, used while the stream is silent. */
  poll: () => unknown;
  /** Called with true when the connection is lost (after a couple of failures) and false when it is back. */
  banner?: (on: boolean) => void;
}

/**
 * Opens an EventSource on <url> and keeps it healthy: a 60 s silence reconnects, a reconnect that stays silent starts
 * backup polling, a tab shown after a long silence reconnects (see stream.ts). Closes it when <url> becomes null.
 */
export function useStream(o: StreamOptions): void {
  const latest = useRef(o);
  latest.current = o;
  useEffect(() => {
    if (!o.url) return;
    const url = o.url;
    let es: EventSource | null = null;
    const machine = createStreamMachine({
      now: () => Date.now(),
      after: (ms, fn) => setTimeout(fn, ms),
      cancel: h => clearTimeout(h as ReturnType<typeof setTimeout>),
      visible: () => document.visibilityState !== 'hidden',
      banner: on => { pageTrace('stream', { why: on ? 'banner-on' : 'banner-off' }); latest.current.banner?.(on); },
      poll: () => { pageTrace('poll', { why: 'backup' }); latest.current.poll(); },
      disconnect: () => { es?.close(); es = null; },
      connect: () => {
        es?.close();
        pageTrace('stream', { why: 'connect' });
        const next = new EventSource(url);
        es = next;
        next.addEventListener('ping', () => { pageTrace('stream', { why: 'ping' }); machine.event(); });
        for (const name of Object.keys(latest.current.on)) {
          next.addEventListener(name, e => {
            machine.event();
            pageTrace('stream', { why: name, changed: true });
            let data: unknown;
            try { data = JSON.parse((e as MessageEvent).data); } catch { return; }
            latest.current.on[name]?.(data);
          });
        }
        next.onerror = () => { pageTrace('stream', { why: 'error' }); machine.error(); };
      },
    });
    const shown = () => machine.visibility();
    document.addEventListener('visibilitychange', shown);
    addEventListener('focus', shown);
    machine.start();
    return () => { document.removeEventListener('visibilitychange', shown); removeEventListener('focus', shown); machine.stop(); };
  }, [o.url]);
}
