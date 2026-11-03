import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { suiteFiles } from './files.js';
import { norm, noReport, posix, q, namePattern, relTo, type Adapter, type RunParts } from './types.js';

const load = createRequire(import.meta.url);

/** Mocha --reporter json: tests[] (with err for failures), pending[], failures[] (hook failures are not in tests[]). */
export function parseMocha(report: any, { root }: { root: string }): RunParts {
  const key = (t: any) => `${t.file}\0${t.fullTitle}`;
  const pending = new Set((report.pending || []).map(key));
  const failed = new Map<string, any>((report.failures || []).map((t: any) => [key(t), t]));
  const tests = (report.tests || []).map((t: any) => ({
    file: relTo(root, t.file), name: norm(t.fullTitle),
    status: pending.has(key(t)) ? 'skipped' as const : failed.has(key(t)) ? 'failed' as const : 'passed' as const,
    message: failed.has(key(t)) ? String((t.err && t.err.message) || '').slice(0, 4000) : null,
  }));
  const inTests = new Set((report.tests || []).map(key));
  const suiteErrors = (report.failures || []).filter((t: any) => !inTests.has(key(t)))
    .map((t: any) => ({ file: relTo(root, t.file), message: `${norm(t.fullTitle)}: ${(t.err && t.err.message) || ''}`.slice(0, 4000) }));
  return { tests, suiteErrors };
}

/** The file a Mocha run that stopped while loading one names first in its stack: the culprit, or null. */
export function mochaCrashFile(stderr: string, root: string): string | null {
  for (const m of String(stderr || '').matchAll(/(?:\(|\s)((?:\/|[A-Za-z]:\\)[^\s():]+?\.[cm]?[jt]sx?):\d+:\d+/g)) {
    const file = relTo(root, m[1])!;
    if (!file.startsWith('..') && !file.includes('node_modules/')) return file;
  }
  return null;
}

/** JSON with // and /* *\/ comments (outside strings) removed. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) { out += c; if (c === '\\') out += text[++i] || ''; else if (c === '"') inString = false; }
    else if (c === '"') { inString = true; out += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; }
    else out += c;
  }
  return out;
}

/** Flat YAML: "key: value" and "key:" followed by "- item" lines (what .mocharc.yml files hold). */
export function simpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, any> = {};
  let list: string | null = null;
  const scalar = (v: string) => { const u = v.replace(/^['"]|['"]$/g, ''); return u === 'true' ? true : u === 'false' ? false : /^\d+$/.test(u) ? Number(u) : u; };
  for (const line of text.split('\n')) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    const kv = line.match(/^([\w-]+):\s*(.*?)\s*$/);
    if (item && list) out[list].push(scalar(item[1]));
    else if (kv) { list = kv[2] === '' ? kv[1] : null; out[kv[1]] = kv[2] === '' ? [] : scalar(kv[2]); }
  }
  return out;
}

/**
 * The project's Mocha settings (.mocharc.* in <dir>, over its package.json "mocha" key) without "spec": Mocha adds files
 * named on the command line to the configured spec instead of replacing it, so a narrowed run needs a spec-less config.
 */
export function mochaConfigWithoutSpec(dir: string): Record<string, unknown> {
  const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
  let pkg: Record<string, unknown> = {};
  try { pkg = JSON.parse(read('package.json') || '{}').mocha || {}; } catch { /* none */ }
  let rc: Record<string, unknown> = {};
  for (const f of ['.mocharc.cjs', '.mocharc.js', '.mocharc.yaml', '.mocharc.yml', '.mocharc.jsonc', '.mocharc.json']) {
    const text = read(f);
    if (text === null) continue;
    try {
      if (/\.c?js$/.test(f)) { const file = path.join(dir, f); delete load.cache[file]; rc = load(file); }
      else if (/\.ya?ml$/.test(f)) rc = simpleYaml(text);
      else rc = JSON.parse(stripJsonComments(text));
    } catch { rc = {}; }
    break;
  }
  const merged = { ...pkg, ...rc };
  delete merged.spec;
  return merged;
}

/**
 * Mocha: `--reporter json`, files with a spec-less config, `--grep` for names. Mocha stops the whole run when one file
 * fails to load, so then the files run one by one and the others still report. Mocha has no worker limit outside
 * --parallel, which the project sets itself.
 */
export const mochaAdapter: Adapter = ctx => {
  const { root, cwd, files, out } = ctx;
  const grep = ctx.names.length ? ` --grep ${q(namePattern(ctx.names))}` : '';
  const rc = path.join(ctx.tmp, 'mocharc.json');
  fs.writeFileSync(rc, JSON.stringify(mochaConfigWithoutSpec(cwd)));
  const mocha = (list: string[]) => ctx.wrap(`${ctx.exec} mocha --reporter json --reporter-option output=${q(out)}${list.length ? ` --config ${q(rc)} --no-package ${list.join(' ')}` : ''}${grep}`);
  const command = mocha(ctx.inSuite);
  const r = ctx.sh(command);
  const report = ctx.read(out);
  if (report) return { command, exitCode: r.status, parts: parseMocha(JSON.parse(report), { root }), output: `${r.stdout}${r.stderr}` };
  const broken = mochaCrashFile(r.stderr, root);
  if (!broken) return noReport(command, r);
  const parts: RunParts = { tests: [], suiteErrors: [] };
  let exitCode = 0;
  let output = `${r.stdout}${r.stderr}`;
  for (const f of files.length ? files.map(f => relTo(root, f)!) : suiteFiles(root, ctx.suite)) {
    fs.rmSync(out, { force: true });
    const one = ctx.sh(mocha([q(posix(path.relative(cwd, path.join(root, f))))]));
    const rep = ctx.read(out);
    if (one.status) exitCode = one.status;
    output += `${one.stdout}${one.stderr}`;
    if (rep) { const p = parseMocha(JSON.parse(rep), { root }); parts.tests.push(...p.tests.filter(t => t.file === f)); parts.suiteErrors.push(...p.suiteErrors); }
    else parts.suiteErrors.push({ file: mochaCrashFile(one.stderr, root) || f, message: one.stderr.trim().slice(-4000) });
  }
  return { command: `${command}  (then file by file: ${broken} failed to load)`, exitCode: exitCode || 1, parts, output };
};
