// What an Implement round says about the full suite in CI: the status line, the run status, and the failure text the
// next agent reads. Pure formatting; the orchestration is in stages.ts.
import fs from 'node:fs';
import { at, type Ctx } from './context.js';
import type { CiStatus } from './status.js';
import type { CiClassification, CiStepResult, CiTestFailure } from './ci.js';

/** A duration as the round block shows it: 10m 28s (28s under a minute). */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const count = (list: CiTestFailure[], c: CiClassification): number => list.filter(f => f.classification === c).length;

/** The "status:" line of a round block for a CI result (10.1). */
export function ciStatusLine(r: CiStepResult, waitMinutes: number): string {
  const all = [...r.sideEffects, ...r.nonBlocking];
  if (r.status === 'timed-out') return `Timed out after ${waitMinutes}m (paused)`;
  if (r.status === 'unavailable') return `Unavailable (${r.reason || 'unknown'}): running the full suite locally`;
  const took = r.durationMs !== undefined ? ` in ${duration(r.durationMs)}` : '';
  if (r.status === 'red') {
    const parts = [`${count(all, 'side-effect')} side effect`, `${count(all, 'pre-existing')} pre-existing`];
    for (const c of ['flaky', 'infrastructure', 'allowed'] as const) {
      const n = count(all, c);
      if (n) parts.push(`${n} ${c}`);
    }
    const checks = r.failingChecks && r.failingChecks.length ? ` (checks: ${r.failingChecks.join(', ')})` : '';
    const head = r.totalTests !== undefined
      ? `${r.failedTests ?? all.length} of ${r.totalTests} tests failed in CI`
      : `${r.failingChecks?.length ?? all.length} of ${r.totalChecks ?? '?'} checks failed in CI`;
    return `Red - ${head}: ${parts.join(', ')}${checks}`;
  }
  const allowed = count(all, 'allowed');
  const extra: string[] = [];
  if (r.skippedTests) extra.push(`${r.skippedTests} skipped`);
  if (allowed) extra.push(`${allowed} allowed failure${allowed > 1 ? 's' : ''}`);
  const tail = extra.length ? ` (${extra.join(', ')})` : '';
  if (r.totalTests !== undefined) return `Green - ${r.totalTests} tests executed in CI${took}${tail}`;
  return `Green - ${r.totalChecks ?? 'all'} checks passed in CI${took}${tail}`;
}

/** The run-status state word for a CI result. */
export function ciState(r: CiStepResult): string {
  if (r.status === 'green') return 'green';
  if (r.status === 'green-with-warnings') return 'green with warnings';
  if (r.status === 'red') return 'red: side effect';
  if (r.status === 'timed-out') return 'timed out (paused)';
  return 'unavailable: running locally';
}

/** Records the CI state in the run status (status.json) for the run page. */
export function setCiStatus(ctx: Ctx, patch: Partial<CiStatus> & { state: string }): void {
  ctx.status.ci = { ...(ctx.status.ci || { enabled: true, state: patch.state }), enabled: true, ...patch };
  ctx.status.write();
}

/** The warnings the run page lists: one per non-blocking CI failure. */
export function ciWarnings(r: CiStepResult): string[] {
  return r.nonBlocking.map(f => `${f.classification}: ${f.checkName}${f.file ? ` ${f.file}` : ''}${f.testName ? ` :: ${f.testName}` : ''}`);
}

/** What the next Implement agent reads in tests.log after a red CI: each side effect, and the files its local gate will run. */
export function ciFailureText(r: CiStepResult, gateFiles: string[]): string {
  const lines = ['CI FAILED: the full suite in CI found side effects of your change. Fix the source (never the tests).', ''];
  for (const f of r.sideEffects) {
    lines.push(`  FAIL  [${f.checkName}] ${f.file || '(check)'}${f.testName ? ` :: ${f.testName}` : ''}`);
    if (f.message) lines.push(...f.message.trim().split('\n').slice(0, 20).map(l => `      ${l}`));
    if (f.runUrl) lines.push(`      run: ${f.runUrl}`);
  }
  if (gateFiles.length) lines.push('', `The local gate will run these test files: ${gateFiles.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

/** The tests of the last local run, from tests.json: total and failed, or null when there is none. */
export function localCounts(ctx: Ctx): { total: number; failed: number } | null {
  try {
    const j = JSON.parse(fs.readFileSync(at(ctx, `${ctx.log}/tests.json`), 'utf8'));
    if (!Array.isArray(j.tests)) return null;
    return { total: j.tests.length, failed: j.tests.filter((t: { status: string }) => t.status === 'failed').length };
  } catch { return null; }
}
