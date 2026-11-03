import { parseJestLike } from './jest.js';
import { noReport, q, relTo, namePattern, type Adapter } from './types.js';

const SLOW_FILE_MS = 60000;

/** Vitest: `run --reporter=json --outputFile`, files as arguments, `-t` for names, `--maxWorkers` when limited. */
export const vitestAdapter: Adapter = ctx => {
  const t = ctx.names.length ? ` -t ${q(namePattern(ctx.names))}` : '';
  const workers = ctx.maxWorkers ? ` --maxWorkers=${ctx.maxWorkers}` : '';
  const command = ctx.wrap(`${ctx.exec} vitest run --reporter=json --outputFile=${q(ctx.out)}${workers}${ctx.inSuite.length ? ` ${ctx.inSuite.join(' ')}` : ''}${t}`);
  const r = ctx.sh(command);
  const report = ctx.read(ctx.out);
  if (!report) return noReport(command, r);
  const json = JSON.parse(report);
  const parts = parseJestLike(json, { root: ctx.root });
  const output = `${r.stdout}${r.stderr}`;
  // A file that blocks the event loop makes the worker's RPC time out ("Timeout calling ..."), and Vitest exits non-zero
  // with every test passed; the files that ran over a minute are the ones that did it.
  if (r.status !== 0 && !parts.suiteErrors.length && !parts.tests.some(t => t.status === 'failed') && output.includes('Timeout calling "')) {
    const message = output.trim().slice(-4000);
    for (const f of json.testResults || []) {
      if (f.endTime - f.startTime >= SLOW_FILE_MS) parts.suiteErrors.push({ file: relTo(ctx.root, f.name), message });
    }
  }
  return { command, exitCode: r.status, parts, output };
};
