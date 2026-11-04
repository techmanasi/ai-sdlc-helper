import { describe, expect, test } from 'vitest';
import { applyRunEvent, createStreamMachine, type StreamHost } from '../web/ui/src/stream.js';

/** A host with a fake clock: timers run when the clock is advanced; every call is recorded with its time. */
function fake(visible = true) {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const log: string[] = [];
  const state = { visible };
  const host: StreamHost = {
    now: () => now,
    after: (ms, fn) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    cancel: h => { timers.delete(h as number); },
    connect: () => log.push(`connect@${now / 1000}`),
    disconnect: () => log.push(`disconnect@${now / 1000}`),
    poll: () => log.push(`poll@${now / 1000}`),
    banner: on => log.push(`banner:${on}@${now / 1000}`),
    visible: () => state.visible,
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { host, advance, log, state, count: (p: string) => log.filter(l => l.startsWith(p)).length, timers };
}
const S = 1000;

describe('the stream state machine', () => {
  test('59 s of silence does nothing; 60 s closes and reopens the stream', () => {
    const f = fake();
    const m = createStreamMachine(f.host);
    m.start();
    f.advance(59 * S);
    expect(f.log).toEqual(['connect@0']);
    f.advance(1 * S);
    expect(f.log).toEqual(['connect@0', 'connect@60']);
  });

  test('pings every 15 s keep the connection: no reconnect in five minutes', () => {
    const f = fake();
    const m = createStreamMachine(f.host);
    m.start();
    for (let i = 0; i < 20; i++) { f.advance(15 * S); m.event(); }
    expect(f.count('connect')).toBe(1);
    expect(f.count('poll')).toBe(0);
  });

  test('a reopen that stays silent starts polling after 10 s, at 10 s then 20 s then 30 s, and the next event stops it', () => {
    const f = fake();
    const m = createStreamMachine(f.host);
    m.start();
    f.advance(60 * S); // silence: reopen
    f.advance(10 * S); // still silent: poll starts
    expect(f.count('poll')).toBe(1);
    expect(m.state().polling).toBe(true);
    f.advance(10 * S);
    f.advance(20 * S);
    f.advance(30 * S);
    f.advance(30 * S);
    expect(f.log.filter(l => l.startsWith('poll'))).toEqual(['poll@70', 'poll@80', 'poll@100', 'poll@130', 'poll@160']);
    m.event();
    f.advance(50 * S); // under the silence limit again: nothing more
    expect(f.count('poll')).toBe(5);
    expect(m.state()).toEqual({ polling: false, banner: false, failures: 0 });
  });

  test('the banner shows after the second failure and goes away with the next event', () => {
    const f = fake();
    const m = createStreamMachine(f.host);
    m.start();
    f.advance(60 * S);
    expect(f.count('banner')).toBe(0);
    f.advance(60 * S);
    expect(f.log).toContain('banner:true@120');
    m.event();
    expect(f.log).toContain('banner:false@120');
  });

  test('a browser error: the banner after the second, polling after 10 s without an event, and an event stops both', () => {
    const f = fake();
    const m = createStreamMachine(f.host);
    m.start();
    f.advance(5 * S);
    m.error();
    expect(f.count('banner')).toBe(0);
    m.error();
    expect(f.log).toContain('banner:true@5');
    expect(f.count('connect')).toBe(1); // the browser reconnects on its own; the page does not
    f.advance(10 * S);
    expect(f.log).toContain('poll@15');
    m.event();
    expect(m.state()).toEqual({ polling: false, banner: false, failures: 0 });
  });

  test('an error followed by an event within 10 s never polls', () => {
    const f = fake();
    const m = createStreamMachine(f.host);
    m.start();
    m.error();
    f.advance(4 * S);
    m.event();
    f.advance(50 * S);
    expect(f.count('poll')).toBe(0);
    expect(f.count('connect')).toBe(1);
  });

  test('a hidden tab neither reconnects nor polls; shown after a long silence it reconnects once; shown while fresh it does not', () => {
    const f = fake(false);
    const m = createStreamMachine(f.host);
    m.start();
    f.advance(300 * S);
    expect(f.log).toEqual(['connect@0']);
    f.state.visible = true;
    m.visibility();
    expect(f.log).toEqual(['connect@0', 'connect@300']);

    const g = fake(false);
    const n = createStreamMachine(g.host);
    n.start();
    g.advance(30 * S);
    n.event();
    g.advance(20 * S);
    g.state.visible = true;
    n.visibility();
    expect(g.count('connect')).toBe(1);
  });

  test('polling does not run in a hidden tab, and polls at once when the tab is shown', () => {
    const f = fake();
    const m = createStreamMachine(f.host);
    m.start();
    f.advance(70 * S); // polling started
    const before = f.count('poll');
    f.state.visible = false;
    f.advance(100 * S);
    expect(f.count('poll')).toBe(before);
    f.state.visible = true;
    m.visibility(); // silent for long: it reconnects, and looks at once
    expect(f.count('poll')).toBe(before + 1);
    expect(f.count('connect')).toBe(3); // the start, the silence at 60 s, and the long silence while hidden
  });

  test('stop cancels everything: no later reconnect, poll or banner', () => {
    const f = fake();
    const m = createStreamMachine(f.host);
    m.start();
    f.advance(70 * S);
    m.stop();
    const n = f.log.length;
    f.advance(600 * S);
    expect(f.log.slice(n)).toEqual([]);
    expect(f.timers.size).toBe(0);
    expect(f.log).toContain('disconnect@70');
  });
});

describe('applyRunEvent', () => {
  const base = { stage: 'Spec', tail: ['a', 'b'] };
  test('a snapshot replaces the page; a run event keeps the tail; a tail event changes only the tail', () => {
    expect(applyRunEvent(base, 'snapshot', { stage: 'Plan', tail: ['z'] })).toEqual({ stage: 'Plan', tail: ['z'] });
    expect(applyRunEvent(base, 'run', { stage: 'Plan', tail: [] })).toEqual({ stage: 'Plan', tail: ['a', 'b'] });
    expect(applyRunEvent(base, 'tail', { tail: ['c'] })).toEqual({ stage: 'Spec', tail: ['c'] });
    expect(applyRunEvent(base, 'ping', {})).toBe(base);
    expect(applyRunEvent(null, 'run', { stage: 'Plan', tail: [] })).toBeNull();
  });
});
