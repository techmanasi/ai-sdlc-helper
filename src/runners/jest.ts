import { norm, noReport, q, namePattern, relTo, type Adapter, type RunParts, type TestStatus } from './types.js';

const STATUS: Record<string, TestStatus> = {
  passed: 'passed', failed: 'failed', pending: 'skipped', skipped: 'skipped', todo: 'skipped', disabled: 'skipped', focused: 'passed',
};

/** Jest --json and Vitest --reporter=json reports, which share one shape (testResults[].assertionResults[]). */
export function parseJestLike(report: any, { root }: { root: string }): RunParts {
  const parts: RunParts = { tests: [], suiteErrors: [] };
  for (const f of report.testResults || []) {
    const file = relTo(root, f.name);
    const list = f.assertionResults || [];
    if (!list.length && f.status === 'failed') parts.suiteErrors.push({ file, message: String(f.message || 'test file failed to run').trim().slice(0, 4000) });
    for (const a of list) {
      parts.tests.push({
        file, name: norm(a.fullName || [...(a.ancestorTitles || []), a.title].join(' ')), status: STATUS[a.status] || 'failed',
        message: a.status === 'failed' ? String((a.failureMessages || [])[0] || '').slice(0, 4000) : null,
      });
    }
  }
  return parts;
}

/** Jest: `--json --outputFile`, files as arguments, `-t` for names, `--maxWorkers` when limited. */
export const jestAdapter: Adapter = ctx => {
  const t = ctx.names.length ? ` -t ${q(namePattern(ctx.names))}` : '';
  const workers = ctx.maxWorkers ? ` --maxWorkers=${ctx.maxWorkers}` : '';
  const command = ctx.wrap(`${ctx.exec} jest --json --outputFile=${q(ctx.out)}${workers}${ctx.inSuite.length ? ` ${ctx.inSuite.join(' ')}` : ''}${t}`);
  const r = ctx.sh(command);
  const report = ctx.read(ctx.out);
  if (!report) return noReport(command, r);
  return { command, exitCode: r.status, parts: parseJestLike(JSON.parse(report), { root: ctx.root }), output: `${r.stdout}${r.stderr}` };
};
