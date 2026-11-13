#!/usr/bin/env node
// Measures how fs.watch on a folder reports changes on a given volume: the delay of the first event after each kind
// of change, and how many changes produce no event at all. Usage: node scripts/watch-probe.mjs <folder> [rounds]
// The folder must exist; a scratch folder is made inside it and removed at the end.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';

const base = path.resolve(process.argv[2] || '.');
const rounds = Number(process.argv[3] || 40);
const dir = fs.mkdtempSync(path.join(base, '.watch-probe-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIMIT_MS = 2000;

let pending = null;
let events = 0;
const attach = () => fs.watch(dir, () => { events++; if (pending) { const p = pending; pending = null; p(performance.now()); } });
let watcher = attach();

/** Runs <change> and returns the delay of the first event after it, or null when none came within the limit. */
async function time(change) {
  await sleep(120); // let earlier events drain
  pending = null;
  const seen = new Promise(res => { pending = res; });
  const t0 = performance.now();
  change();
  const at = await Promise.race([seen, sleep(LIMIT_MS).then(() => null)]);
  pending = null;
  return at === null ? null : at - t0;
}

const file = path.join(dir, 'record.json');
fs.writeFileSync(file, '{}\n');
const ops = {
  'write in place': i => fs.writeFileSync(file, `{"n":${i}}\n`),
  'replace by rename': i => { const t = `${file}.${process.pid}.${i}.tmp`; fs.writeFileSync(t, `{"n":${i}}\n`); fs.renameSync(t, file); },
  'create a file': i => fs.writeFileSync(path.join(dir, `new-${i}.json`), '{}\n'),
  'delete a file': i => fs.rmSync(path.join(dir, `new-${i}.json`), { force: true }),
  'append to a file': i => fs.appendFileSync(path.join(dir, 'run.out'), `line ${i}\n`),
};
const out = [];
for (const [name, op] of Object.entries(ops)) {
  const delays = [];
  let missed = 0;
  for (let i = 0; i < rounds; i++) { const d = await time(() => op(i)); if (d === null) missed++; else delays.push(d); }
  delays.sort((a, b) => a - b);
  const pick = q => (delays.length ? delays[Math.min(delays.length - 1, Math.floor(q * delays.length))] : NaN);
  out.push({ change: name, rounds, missed, medianMs: +pick(0.5).toFixed(1), p95Ms: +pick(0.95).toFixed(1), worstMs: +(delays[delays.length - 1] ?? NaN).toFixed(1) });
}

// A burst: many changes at once. How many events come back says whether events are merged.
await sleep(300);
events = 0;
for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `burst-${i}.json`), '{}\n');
await sleep(1500);
const burst = { changes: 50, events };

// The watched folder is removed and made again: does the old watcher say anything, and does it see the new folder?
await sleep(200);
let errored = false;
watcher.on('error', () => { errored = true; });
events = 0;
fs.rmSync(dir, { recursive: true, force: true });
await sleep(800);
const onRemoval = events;
fs.mkdirSync(dir);
events = 0;
fs.writeFileSync(path.join(dir, 'after.json'), '{}\n');
await sleep(1500);
const oldWatcherSeesNewFolder = events > 0;
watcher.close();
watcher = attach();
const reattached = await time(() => fs.writeFileSync(path.join(dir, 'after.json'), '{"n":1}\n'));
watcher.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ folder: base, platform: process.platform, node: process.version, changes: out, burst, removedFolder: { eventsOnRemoval: onRemoval, errorEvent: errored, oldWatcherSeesNewFolder, reattachedDelayMs: reattached === null ? null : +reattached.toFixed(1) } }, null, 1));
