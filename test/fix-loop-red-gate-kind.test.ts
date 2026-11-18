import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { stageRecoveryHint } from '../src/pipeline/hints.js';
import * as reviewGate from '../src/pipeline/review-gate.js';
import { readReviewRounds } from '../src/pipeline/review-gate.js';
import { fixture, git, pipeline, LOG } from './pipeline-fixture.js';

const finding = { file: 'src/sum.mjs', criterion: 'sum behavior', reason: 'cover the result' };
const report = (blockers: boolean, missing: boolean) => JSON.stringify({
  verdict: 'changes', blockers: blockers ? [finding] : [], missingTests: missing ? [finding] : [],
});
const red = (extra: string) => `echo cases > "$FAKE_DOCS/test-cases-1.md"
printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { sum } from './sum.mjs';\\ntest('sum adds', () => assert.equal(sum(2, 3), 5));\\n" > src/sum.test.mjs
n=$(grep -c '^red-tests$' "$FAKE_DIR/calls.txt")
if [ "$n" -gt 1 ]; then ${extra}; fi`;
const passing = `printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { sum } from './sum.mjs';\\ntest('new coverage', () => assert.equal(sum(1, 1), 2));\\n" > src/coverage.test.mjs`;
const vacuous = `printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { one } from './existing.mjs';\\ntest('old coverage', () => assert.equal(one(), 1));\\n" > src/coverage.test.mjs`;
const failing = `printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { sum } from './sum.mjs';\\ntest('blocker coverage', () => assert.equal(sum(), 0));\\n" > src/blocker.test.mjs`;
const review = (value: string) => `echo reviewed > "$FAKE_DOCS/review-1.md"
n=$(grep -c '^review$' "$FAKE_DIR/calls.txt")
if [ "$n" -eq 1 ]; then printf '%s\\n' '${value}' > "$FAKE_DOCS/review.json"; else printf '%s\\n' '{"verdict":"pass","blockers":[],"missingTests":[]}' > "$FAKE_DOCS/review.json"; fi`;
const implement = `printf 'export const sum = (a = 0, b = 0) => a + b;\\n' > src/sum.mjs`;

describe('Review fix-loop red gate', () => {
  it('accepts missing-test coverage that fails at the original red commit and skips Implement', async () => {
    const f = fixture({ 'red-tests': red(passing), implement, review: review(report(false, true)) });
    const r = await pipeline(f);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'implement', 'review', 'red-tests', 'review']);
    expect(r.stdout).toContain('Implement skipped: no new test fails on the current tree; every accepted test covers a missing-test finding');
    const round = readReviewRounds(f.dir, LOG)[0] as { acceptedFiles?: string[]; outcome: string };
    expect(round.acceptedFiles).toContain('src/coverage.test.mjs');
    expect(['implement-skipped', 'fixed']).toContain(round.outcome);
    expect(git(f.dir, 'log', '--format=%s', 'main..HEAD').match(/\[red-tests\]/g)).toHaveLength(2);
  });

  it('rejects a passing test that also passes at the original red commit and names the finding', async () => {
    const f = fixture({ 'red-tests': red(vacuous), implement, review: review(report(false, true)) });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('already pass at base commit and on current code');
    expect(r.stdout).toContain('src/coverage.test.mjs :: old coverage');
    expect(r.stdout).toContain('cover the result');
    expect(r.stdout).not.toMatch(/resume at plan|fix the spec or plan/i);
  });

  it('rejects a blocker when every new test passes on current code', async () => {
    const f = fixture({ 'red-tests': red(passing), implement, review: review(report(true, false)) });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('blocker finding has no failing test on current code');
    expect(r.stdout).toContain('cover the result');
  });

  it('accepts mixed failing and passing tests and runs Implement', async () => {
    const fix = `printf 'export const sum = (a, b) => a === undefined ? 0 : a + b;\\n' > src/sum.mjs`;
    const f = fixture({ 'red-tests': red(`${passing}; ${failing}`), implement: fix, review: review(report(true, true)) });
    // The first implementation intentionally leaves the blocker unresolved.
    fs.writeFileSync(path.join(f.fake, 'implement.sh'), `set -e\nn=$(grep -c '^implement$' "$FAKE_DIR/calls.txt")\nif [ "$n" -eq 1 ]; then printf 'export const sum = (a, b) => a + b;\\n' > src/sum.mjs; else ${fix}; fi\n`);
    const r = await pipeline(f);
    expect(r.status).toBe(0);
    expect(r.calls.filter(c => c === 'implement')).toHaveLength(2);
    expect(r.stdout).not.toContain('Implement skipped:');
  });
});


describe('Review loop history across starts', () => {
  it('restores the finding on a Red tests resume and keeps the implementation commit', async () => {
    const f = fixture({ 'red-tests': red(vacuous), implement, review: review(report(false, true)) });
    const first = await pipeline(f);
    expect(first.status).toBe(1);
    git(f.dir, 'add', 'src/sum.mjs');
    git(f.dir, 'commit', '-qm', '[implement] fixture implementation');
    const commit = git(f.dir, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(f.fake, 'red-tests.sh'), `set -e\n${passing}\n`);
    const resumed = await pipeline(f, {}, { from: 'red-tests' });
    const prompts = resumed.prompts.split('== red-tests');
    expect(prompts[prompts.length - 1]).toContain('cover the result');
    expect(git(f.dir, 'log', '--format=%H')).toContain(commit);
    expect(resumed.stdout).toContain('Implement skipped:');
    expect(resumed.calls).not.toContain('implement');
  });
  it('stops at the configured limit on a later start', async () => {
    const f = fixture({ 'red-tests': red(vacuous), implement, review: review(report(false, true)) });
    const configPath = path.join(f.dir, 'sdlc.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, review: { maxLoops: 1 } }));
    git(f.dir, 'commit', '-qam', 'set review loop limit');
    const first = await pipeline(f);
    expect(first.status).toBe(1);
    const historyFile = path.join(f.dir, LOG, 'review-rounds.json');
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    history[0].loop = 1;
    fs.writeFileSync(historyFile, JSON.stringify(history));
    const resumed = await pipeline(f, {}, { from: 'review' });
    expect(resumed.status).toBe(1);
    expect(resumed.stdout).toContain('REVIEW NOT RESOLVED after 1 fix loop(s)');
    expect(resumed.calls).not.toContain('red-tests');
  });
});

describe('fix-loop recovery hints', () => {
  it.each([
    ['RED GATE FAILED: test(s) already pass at base commit and on current code:', 'src/a.test.ts :: old coverage', 'Open findings:', '[missing-test] src/a.ts: result: cover result'],
    ['RED GATE FAILED: blocker finding has no failing test on current code.', 'Open blocker findings:', '[blocker] src/a.ts: result: cover result'],
  ])('offers Red tests recovery for %s', (...lines) => {
    const recovery = stageRecoveryHint({ slug: 'x', stage: 'Red tests', state: 'failed', exitCode: 1, runOut: ['SDLC: x on branch b', ...lines] });
    expect(recovery.autoAction).toEqual({ label: 'Resume at Red tests', command: 'ai-sdlc-helper pipeline x --from red-tests' });
    expect(recovery.manualAction?.file).toBe('logs/tests.log');
    expect(recovery.diagnosis).toContain('cover result');
    expect(recovery.escapeHatch).toBeUndefined();
  });
});


describe('restoring Review findings', () => {
  const api = reviewGate as unknown as {
    restoreFixFindings: (ctx: { root: string; log: string; promptExtra: Record<string, string> }) => boolean;
    findingsText: (round: number, findings: Array<{ kind: string; file: string; criterion: string; reason: string }>) => string;
  };
  it('gives distinct instructions for blockers and missing tests', () => {
    const text = api.findingsText(2, [{ ...finding, kind: 'blocker' }, { ...finding, kind: 'missing-test' }]);
    expect(text).toMatch(/blocker[\s\S]*fail/i);
    expect(text).toMatch(/missing.test[\s\S]*pass/i);
  });
  it.each(['fix loop 1 of 2', 'changes requested'])('restores open findings for %s', outcome => {
    const f = fixture();
    fs.mkdirSync(path.join(f.dir, LOG), { recursive: true });
    fs.writeFileSync(path.join(f.dir, LOG, 'review-rounds.json'), JSON.stringify([{ round: 1, verdict: 'changes', outcome, findings: [{ ...finding, kind: 'missing-test', status: 'open' }] }]));
    const ctx = { root: f.dir, log: LOG, promptExtra: { OTHER: 'kept' } };
    expect(api.restoreFixFindings(ctx)).toBe(true);
    expect(ctx.promptExtra).toMatchObject({ OTHER: 'kept', REVIEW_FINDINGS: expect.stringContaining('cover the result') });
  });
  it.each(['passed', 'fixed', 'implement-skipped', 'stopped: limit'])('does not restore final outcome %s', outcome => {
    const f = fixture();
    fs.mkdirSync(path.join(f.dir, LOG), { recursive: true });
    fs.writeFileSync(path.join(f.dir, LOG, 'review-rounds.json'), JSON.stringify([{ round: 1, verdict: 'changes', outcome, findings: [{ ...finding, kind: 'blocker', status: 'open' }] }]));
    const ctx = { root: f.dir, log: LOG, promptExtra: { OTHER: 'kept' } };
    expect(api.restoreFixFindings(ctx)).toBe(false);
    expect(ctx.promptExtra).toEqual({ OTHER: 'kept' });
  });
  it('leaves a run without history alone', () => {
    const f = fixture();
    const ctx = { root: f.dir, log: LOG, promptExtra: { OTHER: 'kept' } };
    expect(api.restoreFixFindings(ctx)).toBe(false);
    expect(ctx.promptExtra).toEqual({ OTHER: 'kept' });
  });
});
