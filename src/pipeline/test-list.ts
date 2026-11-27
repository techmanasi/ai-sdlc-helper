// The per-run list is accumulated from accepted Red tests, Test repair claims and Implement's CI failures.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { norm, type RunParts, type RunResult } from '../runners/types.js';
import { SUITE_FAILED } from '../testcheck/keys.js';
import { matchesAllowEntry } from './allow-failures.js';
import { at, type Ctx } from './context.js';
import { keepError } from './errors.js';
import { leafNames, resultsAt, titlesOf } from './gates.js';

type Source = 'red' | 'repair' | 'ci';
type Test = { file: string; name?: string | null };
export interface TestListEntry {
  file: string;
  name?: string;
  whole?: true;
  addedBy: Source[];
  state: 'active' | 'already-failing' | 'dropped';
  reason: string;
  base?: string;
  conflictHead?: string;
}

const same = (a: Test, b: Test) => a.file === b.file && a.name === b.name;
const label = (t: Test) => t.name ? `${t.file} :: ${t.name}` : t.file;
const listPath = (ctx: Ctx) => at(ctx, `${ctx.log}/test-list.json`);

function notice(ctx: Ctx, message: string): void {
  keepError(ctx, 'test list', message);
  ctx.out(message);
}

function readJson(ctx: Ctx, file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { notice(ctx, `Cannot read ${file}: ${(e as Error).message}`); throw e; }
}

function report(ctx: Ctx, file: string): RunParts {
  const data = readJson(ctx, file) as RunResult;
  if (data?.noReport || ((data?.ok === false || data?.exitCode > 0)
    && !data.tests?.some(t => t.status === 'failed') && !data.suiteErrors?.length)) {
    const message = `No usable failing test report in ${file}: ${data.suiteErrors?.map(e => e.message).join('\n') || 'the runner reported no failures'}`;
    notice(ctx, message);
    throw new Error(message);
  }
  if (Array.isArray(data?.tests) && Array.isArray(data.suiteErrors ?? [])) return { tests: data.tests, suiteErrors: data.suiteErrors ?? [] };
  const message = `Invalid test report in ${file}`;
  notice(ctx, message);
  throw new Error(message);
}

function writeList(ctx: Ctx, entries: TestListEntry[]): void {
  const dest = listPath(ctx);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
    fs.renameSync(tmp, dest);
  } catch (e) { notice(ctx, `Cannot save ${dest}: ${(e as Error).message}`); throw e; }
}

function add(entries: TestListEntry[], t: Test, source: Source, reason: string): TestListEntry {
  const name = t.name && t.name !== SUITE_FAILED ? norm(t.name) : undefined;
  let entry = entries.find(e => same(e, { file: t.file, name }));
  if (!entry) {
    entry = { file: t.file, ...(name ? { name } : { whole: true }), addedBy: [], state: 'active', reason };
    entries.push(entry);
  }
  if (!entry.addedBy.includes(source)) entry.addedBy.push(source);
  if (entry.state === 'dropped' || (entry.state === 'already-failing' && source !== 'red')) {
    entry.state = 'active';
    entry.reason = reason;
    delete entry.conflictHead;
  }
  return entry;
}

function failures(ctx: Ctx, r: RunParts, files: string[] = []): Test[] {
  const tests: Test[] = [];
  const push = (file: string | null, name?: string) => {
    if (file) tests.push({ file, name });
    else {
      const message = 'The failing test report has no file';
      notice(ctx, files.length ? `${message}; checking all Red tests gate files in full: ${files.join(', ')}` : message);
      if (!files.length) throw new Error(message);
      for (const f of files) tests.push({ file: f });
    }
  };
  for (const t of r.tests) if (t.status === 'failed') push(t.file, norm(t.name));
  for (const e of r.suiteErrors) push(e.file);
  return tests.filter(t => !(ctx.config.tests?.allowFailures || []).some(a => matchesAllowEntry(a, t.file, t.name)));
}

export function readTestList(ctx: Ctx): TestListEntry[] {
  const file = listPath(ctx);
  if (fs.existsSync(file)) {
    const entries = readJson(ctx, file) as TestListEntry[];
    if (Array.isArray(entries) && entries.every(e => e?.file && Array.isArray(e.addedBy)
      && (e.whole === true || e.name) && ['active', 'already-failing', 'dropped'].includes(e.state))) return entries;
    const message = `Invalid test list in ${file}`;
    notice(ctx, message);
    throw new Error(message);
  }
  const entries: TestListEntry[] = [];
  const red = at(ctx, `${ctx.log}/red.json`);
  notice(ctx, 'No test-list.json from Red tests. Using red.json if available. Already-failing tests cannot be identified for this run.');
  if (fs.existsSync(red)) {
    for (const t of failures(ctx, report(ctx, red))) add(entries, t, 'red', 'Failed in red.json (base comparison unavailable)');
    writeList(ctx, entries);
  }
  return entries;
}

export function addTestEntries(ctx: Ctx, source: 'ci' | 'repair', tests: Test[]): void {
  if (!tests.length) return;
  const entries = readTestList(ctx);
  const reason = source === 'ci' ? 'Reported failing by CI' : 'Claimed by Test repair';
  for (const t of tests) add(entries, t, source, reason);
  writeList(ctx, entries);
}

function drop(ctx: Ctx, entry: TestListEntry, reason: string): void {
  entry.state = 'dropped';
  entry.reason = reason;
  ctx.out(`Dropped ${label(entry)}: ${reason}`);
}

export function dropTests(ctx: Ctx, dropped: TestListEntry[], reason: string): void {
  const entries = readTestList(ctx);
  for (const e of entries) if (dropped.some(t => same(t, e))) drop(ctx, e, reason);
  writeList(ctx, entries);
}

// The resolver replays commits with their original subjects. Record its actual file resolutions on the
// entries that exist at the time, so later additions cannot inherit permission to drop a missing test.
export function recordConflictChanges(ctx: Ctx, files: string[], head: string): void {
  if (!files.length || (!fs.existsSync(listPath(ctx)) && !fs.existsSync(at(ctx, `${ctx.log}/red.json`)))) return;
  const entries = readTestList(ctx);
  const affected = entries.filter(e => files.includes(e.file) && e.state !== 'dropped');
  if (!affected.length) return;
  for (const e of affected) e.conflictHead = head;
  writeList(ctx, entries);
}

export function conflictChanged(ctx: Ctx, entry: TestListEntry): boolean {
  if (!entry.conflictHead) return false;
  if (ctx.git.tryRun('merge-base', '--is-ancestor', entry.conflictHead, 'HEAD') !== null) return true;
  notice(ctx, `The Resolve conflicts commit for ${label(entry)} is outside the current history. Keeping the missing test active.`);
  return false;
}

/** Read the accepted whole-file run before any comparison with original source can replace it. */
export function acceptRedTests(ctx: Ctx, baseSha: string, files: string[], previous?: TestListEntry[], changed: string[] = []): void {
  const accepted = report(ctx, at(ctx, `${ctx.log}/tests.json`));
  if (!accepted.suiteErrors.length && !accepted.tests.some(t => t.status === 'failed')) {
    const message = 'The accepted Red tests report contains no failures';
    notice(ctx, message);
    throw new Error(message);
  }
  const entries = previous ?? [];
  const base = entries.find(e => e.base)?.base || baseSha;
  const failed = failures(ctx, accepted, files);
  const baseFiles = new Map<string, ReturnType<typeof titlesOf>>();
  const candidates: TestListEntry[] = [];
  for (const t of failed) {
    const entry = add(entries, t, 'red', 'Failed at the accepted Red tests gate');
    entry.base = base;
    if (!entry.name || entry.addedBy.some(source => source !== 'red')) continue;
    if (!baseFiles.has(t.file)) {
      try {
        const tracked = ctx.git.lines('ls-tree', '--name-only', base, '--', t.file).includes(t.file);
        baseFiles.set(t.file, titlesOf(tracked ? ctx.git.run('show', `${base}:${t.file}`) : ''));
      } catch (e) {
        notice(ctx, `Cannot inspect ${t.file} at base: ${(e as Error).message}`);
        throw e;
      }
    }
    if ([entry.name, ...leafNames(entry.name)].some(n => baseFiles.get(t.file)!.has(n))) candidates.push(entry);
  }
  if (candidates.length) {
    const rel = `${ctx.log}/base-tests-${randomUUID()}.json`;
    try {
      resultsAt(ctx, base, rel, [], [...new Set(candidates.map(t => t.file))]);
      const before = report(ctx, at(ctx, rel));
      for (const entry of candidates) {
        const original = before.tests.find(t => t.file === entry.file && norm(t.name) === entry.name);
        if (original?.status === 'failed') {
          entry.state = 'already-failing';
          entry.reason = 'Failed before the first Red tests commit';
          notice(ctx, `Already failing before the run: ${label(entry)}`);
        } else if (original?.status !== 'passed') {
          notice(ctx, `No passing or failing result at base for ${label(entry)}. Keeping the test active.`);
        }
      }
    } finally { fs.rmSync(at(ctx, rel), { force: true }); }
  }
  if (previous) {
    for (const entry of entries) {
      if (entry.state === 'dropped' || !changed.includes(entry.file)) continue;
      const deleted = !fs.existsSync(at(ctx, entry.file));
      // A load error or an incomplete report cannot establish that a particular name disappeared.
      const fileReported = files.includes(entry.file) && accepted.tests.some(t => t.file === entry.file)
        && !accepted.suiteErrors.some(e => !e.file || e.file === entry.file);
      if (deleted || (entry.name && fileReported && !accepted.tests.some(t => t.file === entry.file && norm(t.name) === entry.name))) {
        drop(ctx, entry, 'Removed or renamed in the Review fix round');
      }
    }
  }
  writeList(ctx, entries);
}
