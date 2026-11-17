import { describe, expect, test } from 'vitest';
import {
  DEFAULT_PREFS, attentionFrom, channelsFor, readPrefs, titleFor, writePrefs,
  type Attention, type NotifyPrefs,
} from '../web/ui/src/notify.js';
import { permissionState, playChime, setFaviconBadge, showDesktop } from '../web/ui/src/notify-dom.js';

const att = (kind: Attention['kind']): Attention => ({ slug: 'a', kind, title: 't', body: 'b' });
const prefs = (o: Partial<NotifyPrefs>): NotifyPrefs => ({ ...DEFAULT_PREFS, ...o });

describe('readPrefs / writePrefs', () => {
  test('nothing saved gives the defaults', () => {
    expect(readPrefs(() => null)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toMatchObject({ mode: 'off', volume: 0.5, onlyWhenHidden: true, events: { paused: true, failed: true, done: true } });
  });
  test('junk gives the defaults', () => {
    for (const j of ['not json', '42', 'null', '"x"', '[]']) expect(readPrefs(() => j), j).toEqual(DEFAULT_PREFS);
  });
  test('an unknown mode is off; volume is clamped; wrong types fall back', () => {
    expect(readPrefs(() => JSON.stringify({ mode: 'loud' })).mode).toBe('off');
    expect(readPrefs(() => JSON.stringify({ volume: 7 })).volume).toBe(1);
    expect(readPrefs(() => JSON.stringify({ volume: -1 })).volume).toBe(0);
    expect(readPrefs(() => JSON.stringify({ volume: 'x', onlyWhenHidden: 'no', events: { done: 1 } }))).toEqual(DEFAULT_PREFS);
  });
  test('a written value reads back', () => {
    const store: Record<string, string> = {};
    const p = prefs({ mode: 'both', volume: 0.2, onlyWhenHidden: false, events: { paused: true, failed: false, done: true } });
    writePrefs((k, v) => { store[k] = v; }, p);
    expect(readPrefs(k => store[k] ?? null)).toEqual(p);
  });
});

describe('attentionFrom', () => {
  test('the first load fires nothing', () => {
    expect(attentionFrom({}, [{ slug: 'a', state: 'paused' }, { slug: 'b', state: 'done' }])).toEqual([]);
  });
  test('running to paused, failed, done', () => {
    const prev = { a: 'running', b: 'running', c: 'running' };
    const out = attentionFrom(prev, [
      { slug: 'a', state: 'paused', stage: 'spec', questions: 3 },
      { slug: 'b', state: 'failed', stage: 'implement' },
      { slug: 'c', state: 'done', stage: 'finalise' },
    ]);
    expect(out.map(o => o.kind)).toEqual(['paused', 'failed', 'done']);
    expect(out[0]).toMatchObject({ title: 'a needs your answer', body: 'Paused at Spec: 3 questions to answer' });
    expect(out[1]).toMatchObject({ title: 'b failed', body: 'Failed at Implement' });
    expect(out[2]).toMatchObject({ title: 'c is done', body: 'Finished at Finalise' });
  });
  test('a pause without questions just needs you; one question is singular', () => {
    const p = attentionFrom({ a: 'running', b: 'running' }, [{ slug: 'a', state: 'paused', stage: 'plan' }, { slug: 'b', state: 'paused', stage: 'plan', questions: 1, permissions: 2 }]);
    expect(p[0]).toMatchObject({ title: 'a needs you', body: 'Paused at Plan' });
    expect(p[1].body).toBe('Paused at Plan: 1 question and 2 permission requests to answer');
  });
  test('an unchanged state fires nothing', () => {
    expect(attentionFrom({ a: 'paused' }, [{ slug: 'a', state: 'paused' }])).toEqual([]);
  });
  test('stopped, refused and interrupted count as failed', () => {
    for (const s of ['stopped', 'refused', 'interrupted']) {
      expect(attentionFrom({ a: 'running' }, [{ slug: 'a', state: s, stage: 'review' }])[0], s).toMatchObject({ kind: 'failed' });
    }
  });
  test('a change into a running state fires nothing', () => {
    expect(attentionFrom({ a: 'paused' }, [{ slug: 'a', state: 'running' }])).toEqual([]);
  });
});

describe('channelsFor', () => {
  test('off uses nothing', () => {
    expect(channelsFor(prefs({ mode: 'off' }), att('done'), true, 'granted')).toEqual({ desktop: false, sound: false });
  });
  test('browser needs the permission', () => {
    expect(channelsFor(prefs({ mode: 'browser' }), att('done'), true, 'granted')).toEqual({ desktop: true, sound: false });
    for (const perm of ['denied', 'default', 'unsupported']) expect(channelsFor(prefs({ mode: 'browser' }), att('done'), true, perm).desktop).toBe(false);
  });
  test('onlyWhenHidden mutes the desktop notification on a visible tab but not the sound', () => {
    expect(channelsFor(prefs({ mode: 'both' }), att('paused'), false, 'granted')).toEqual({ desktop: false, sound: true });
    expect(channelsFor(prefs({ mode: 'both', onlyWhenHidden: false }), att('paused'), false, 'granted')).toEqual({ desktop: true, sound: true });
  });
  test('a disabled event fires nothing', () => {
    const p = prefs({ mode: 'both', events: { paused: true, failed: false, done: true } });
    expect(channelsFor(p, att('failed'), true, 'granted')).toEqual({ desktop: false, sound: false });
  });
});

describe('titleFor and the browser effects', () => {
  test('titleFor', () => {
    expect(titleFor(2, 'app')).toBe('(2) app');
    expect(titleFor(0, 'app')).toBe('app');
  });
  test('the effects are harmless under Node', async () => {
    expect(permissionState()).toBe('unsupported');
    expect(() => { showDesktop(att('done'), () => {}); playChime('done', 1); setFaviconBadge(1, 0); }).not.toThrow();
  });
});
