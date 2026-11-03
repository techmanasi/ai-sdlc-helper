import path from 'node:path';
import { norm, noReport, relTo, type Adapter, type RunParts, type TestCase } from './types.js';

const xmlText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, c) => String.fromCharCode(Number(c))).replace(/&amp;/g, '&');
const attrs = (s: string): Record<string, string> => Object.fromEntries([...s.matchAll(/([\w:.-]+)="([^"]*)"/g)].map(m => [m[1], xmlText(m[2])]));
const looksLikePath = (s: string | undefined) => /[/\\]|\.[cm]?[jt]sx?$/.test(s || '');

/** JUnit XML from any runner: nested <testsuite> names that are not file paths prefix the <testcase> name. */
export function parseJUnit(xml: string, { root }: { root: string }): RunParts {
  const tests: TestCase[] = [];
  const suites: Record<string, string>[] = [];
  let current: TestCase | null = null;
  for (const m of String(xml || '').matchAll(/<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, rawAttrs, selfClose] = m;
    if (tag === 'testsuite') {
      if (close) suites.pop(); else if (!selfClose) suites.push(attrs(rawAttrs));
    } else if (tag === 'testcase') {
      if (close) { current = null; continue; }
      const a = attrs(rawAttrs);
      const prefix = suites.map(x => x.name).filter(n => n && !looksLikePath(n));
      const classname = a.classname && !looksLikePath(a.classname) && a.classname !== a.name ? a.classname : null;
      const name = classname && classname.endsWith(a.name) ? classname : [...prefix, a.name].join(' ');
      const fileAttr = a.file || (suites.find(x => x.file) || {}).file || (looksLikePath(a.classname) ? a.classname : null)
        || (suites.map(x => x.name).find(looksLikePath) || null);
      current = { file: relTo(root, fileAttr), name: norm(name), status: 'passed', message: null };
      tests.push(current);
      if (selfClose) current = null;
    } else if (current && !close) {
      if (tag === 'skipped') current.status = 'skipped';
      else { current.status = 'failed'; current.message = (attrs(rawAttrs).message || '').slice(0, 4000); }
    }
  }
  return { tests, suiteErrors: [] };
}

/**
 * Any command that writes a JUnit XML report (the suite's `report`, from the root): the project's own command runs, with
 * the project's Node. It has no file filter, so a narrowed run runs everything and keeps the files asked for.
 */
export const junitAdapter: Adapter = ctx => {
  const command = ctx.suite.runCmd || ctx.suite.testCmd;
  const r = ctx.sh(command, ctx.root);
  const report = ctx.read(path.resolve(ctx.root, ctx.suite.report || ''));
  if (!report) return noReport(command, r);
  return { command, exitCode: r.status, parts: parseJUnit(report, { root: ctx.root }), output: `${r.stdout}${r.stderr}` };
};
