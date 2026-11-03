import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSETS_DIR } from '../util.js';
import { norm, noReport, relTo, type Adapter, type RunParts } from './types.js';

/** The node:test reporter the adapter adds: one JSON line per test start and result. */
export const REPORTER = path.join(ASSETS_DIR, 'runners', 'node-test-reporter.mjs');

const fromUrl = (s: unknown) => {
  if (typeof s !== 'string' || !s.startsWith('file:')) return s;
  try { return fileURLToPath(s); } catch { return s; }
};

/** The reporter's lines. Describe blocks and tests with subtests are containers, not tests. */
export function parseNodeTest(text: string, { root, cwd = root }: { root: string; cwd?: string }): RunParts {
  const parts: RunParts = { tests: [], suiteErrors: [] };
  const files = new Map<string, { names: string[]; hasChild: boolean[] }>();
  const state = (file: string) => { if (!files.has(file)) files.set(file, { names: [], hasChild: [] }); return files.get(file)!; };
  for (const line of String(text || '').split('\n')) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    // Node 18 names an ES module test file by its file: URL
    e.file = fromUrl(e.file);
    e.name = fromUrl(e.name);
    const s = state(e.file);
    const n = e.nesting || 0;
    if (e.event === 'start') { s.names[n] = e.name; s.names.length = n + 1; s.hasChild[n] = false; continue; }
    if (n > 0) s.hasChild[n - 1] = true;
    const file = relTo(root, e.file);
    // A file that failed to load is reported as one failed test named after the file.
    if (n === 0 && e.event === 'fail' && e.file && e.name && path.resolve(cwd, e.name) === path.resolve(e.file)) {
      parts.suiteErrors.push({ file, message: String(e.message || 'test file failed to run').slice(0, 4000) });
      continue;
    }
    if (e.suite || s.hasChild[n] || e.failureType === 'subtestsFailed') continue;
    parts.tests.push({
      file, name: norm([...s.names.slice(0, n), e.name].join(' ')),
      status: e.skip || e.todo ? 'skipped' : e.event === 'pass' ? 'passed' : 'failed', message: e.event === 'fail' ? e.message : null,
    });
  }
  return parts;
}

const nodeOption = (s: string) => (/\s/.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s);

/**
 * node:test: the whole suite runs the project's own test command (with the project's Node) and the reporter is added
 * through NODE_OPTIONS; named files run with `node --test <files>` (or `tsx --test` when the project's command uses tsx).
 * node:test cannot pick tests by full name on every Node version, so a narrowed run re-runs whole files. There is no
 * worker limit: --test-concurrency is not on Node 18.
 */
export const nodeTestAdapter: Adapter = ctx => {
  const { suite, files, env } = ctx;
  const nodeOptions = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--test-reporter=${nodeOption(REPORTER)} --test-reporter-destination=${nodeOption(ctx.out)}`;
  const tsx = /\btsx\s[^;&|]*--test/.test(suite.testCmd);
  const command = files.length ? ctx.wrap(`${tsx ? `${ctx.exec} tsx` : 'node'} --test ${ctx.inSuite.join(' ')}`) : (suite.runCmd || suite.testCmd);
  const where = files.length ? ctx.cwd : ctx.root;
  const r = ctx.sh(command, where, { NODE_OPTIONS: nodeOptions });
  const report = ctx.read(ctx.out);
  if (!report) return noReport(command, r);
  return { command, exitCode: r.status, parts: parseNodeTest(report, { root: ctx.root, cwd: where }), output: `${r.stdout}${r.stderr}` };
};
