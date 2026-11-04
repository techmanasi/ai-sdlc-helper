#!/usr/bin/env node
// Prints one row per action + why from the UI trace (ui-trace.jsonl and its rotated files, oldest first): events a
// minute, the share that changed nothing, the median and total milliseconds a minute. Sorted by total time.
//   node scripts/trace-report.mjs [trace-file] [--json]
// The default file is <config dir>/ui-trace.jsonl (AI_SDLC_HELPER_CONFIG_DIR, XDG_CONFIG_HOME or ~/.config).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const json = args.includes('--json');
const given = args.find(a => !a.startsWith('--'));
const env = process.env;
const dir = env.AI_SDLC_HELPER_CONFIG_DIR
  ? path.resolve(env.AI_SDLC_HELPER_CONFIG_DIR)
  : process.platform === 'win32'
    ? path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ai-sdlc-helper')
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ai-sdlc-helper');
const file = given ? path.resolve(given) : path.join(dir, 'ui-trace.jsonl');

const rotated = i => file.replace(/\.jsonl$/, `.${i}.jsonl`);
const files = [];
for (let i = 12; i >= 1; i--) if (fs.existsSync(rotated(i))) files.push(rotated(i));
if (fs.existsSync(file)) files.push(file);
if (!files.length) { console.error(`no trace file at ${file}`); process.exit(1); }

const events = [];
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (typeof e.t === 'number' && e.action) events.push(e); } catch { /* a torn line */ }
  }
}
events.sort((a, b) => a.t - b.t);
if (!events.length) { console.error('the trace has no events'); process.exit(1); }

const minutes = Math.max((events[events.length - 1].t - events[0].t) / 60e6, 1 / 60);
const groups = new Map();
for (const e of events) {
  const key = `${e.action}${e.why ? ` ${e.why}` : ''}`;
  const g = groups.get(key) || { key, n: 0, withChanged: 0, unchanged: 0, ms: [] };
  g.n++;
  if (typeof e.changed === 'boolean') { g.withChanged++; if (!e.changed) g.unchanged++; }
  if (typeof e.ms === 'number') g.ms.push(e.ms);
  groups.set(key, g);
}
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const rows = [...groups.values()].map(g => ({
  action: g.key,
  perMin: +(g.n / minutes).toFixed(2),
  unchangedPct: g.withChanged ? Math.round((100 * g.unchanged) / g.withChanged) : null,
  medianMs: +median(g.ms).toFixed(3),
  totalMsPerMin: +(g.ms.reduce((a, b) => a + b, 0) / minutes).toFixed(2),
  count: g.n,
})).sort((a, b) => b.totalMsPerMin - a.totalMsPerMin || b.perMin - a.perMin || a.action.localeCompare(b.action));

if (json) { console.log(JSON.stringify({ minutes: +minutes.toFixed(2), rows }, null, 2)); process.exit(0); }
console.log(`${events.length} events over ${minutes.toFixed(1)} min from ${files.length} file(s)\n`);
const w = Math.max(6, ...rows.map(r => r.action.length));
console.log(`${'action'.padEnd(w)}  ${'per min'.padStart(8)}  ${'unchanged'.padStart(9)}  ${'median ms'.padStart(9)}  ${'total ms/min'.padStart(12)}`);
for (const r of rows) {
  console.log(`${r.action.padEnd(w)}  ${String(r.perMin).padStart(8)}  ${(r.unchangedPct === null ? '-' : `${r.unchangedPct}%`).padStart(9)}  ${String(r.medianMs).padStart(9)}  ${String(r.totalMsPerMin).padStart(12)}`);
}
