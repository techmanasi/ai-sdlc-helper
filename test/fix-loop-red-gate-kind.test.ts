import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { formatRecoveryCli, stageRecoveryHint } from '../src/pipeline/hints.js';
import { readReviewRounds } from '../src/pipeline/review-gate.js';
import { fixture, git, pipeline, filesIn, read, statusOf, DOCS, LOG, SLUG, STAGES } from './pipeline-fixture.js';

const finding = { file: 'src/sum.mjs', criterion: 'sum behavior', reason: 'cover the result' };
const report = (blockers: boolean, missing: boolean) => JSON.stringify({
  verdict: 'changes', blockers: blockers ? [finding] : [], missingTests: missing ? [{ ...finding, criterion: 'sum of two numbers' }] : [],
});
const passing = `printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\ntest('new coverage', async () => assert.equal((await import('./sum.mjs')).sum(1, 1), 2));\\n" > src/coverage.test.mjs`;
const vacuous = `printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { one } from './existing.mjs';\\ntest('old coverage', () => assert.equal(one(), 1));\\n" > src/coverage.test.mjs`;
const failing = `printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\ntest('blocker coverage', async () => assert.equal((await import('./sum.mjs')).sum(), 0));\\n" > src/blocker.test.mjs`;
const review = (value: string) => `echo reviewed > "$FAKE_DOCS/review-1.md"
n=$(grep -c '^review$' "$FAKE_DIR/calls.txt")
if [ "$n" -eq 1 ]; then printf '%s\\n' '${value}' > "$FAKE_DOCS/review.json"; else printf '%s\\n' '{"verdict":"pass","blockers":[],"missingTests":[]}' > "$FAKE_DOCS/review.json"; fi`;
const implement = `printf 'export const sum = (a = 0, b = 0) => a + b;\\n' > src/sum.mjs`;

describe('Review fix-loop red gate', () => {
  it('accepts missing-test coverage that fails at the original red commit and skips Implement', async () => {
    const f = readyForReview(passing);
    const out = vi.fn<(line: string) => void>();
    const r = await pipeline(f, {}, { from: 'review', out });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['review', 'red-tests', 'review']);
    expect(out.mock.calls.map(([line]) => line.trim()).filter(line => line.startsWith('Implement skipped:'))).toEqual(['Implement skipped: no new test fails on the current tree; every accepted test covers a missing-test finding']);
    const round = readReviewRounds(f.dir, LOG)[0];
    expect(round).toMatchObject({ acceptedFiles: ['src/coverage.test.mjs'], outcome: 'implement-skipped', loop: 1 });
    const [initial, accepted] = git(f.dir, 'log', '--reverse', '--format=%H', '--grep=^\\[red-tests\\]').split('\n');
    expect(filesIn(f.dir, accepted)).toContain('src/coverage.test.mjs');
    const events = read(f.dir, `${LOG}/attempts.jsonl`).trim().split('\n').map(line => JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'lock', sha: accepted, origRedSha: initial }));
    expect(git(f.dir, 'log', '--format=%s', 'main..HEAD').match(/\[red-tests\]/g)).toHaveLength(2);
  });

  it('rejects a passing test that also passes at the original red commit and names the finding', async () => {
    const f = readyForReview(vacuous);
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('already pass at base commit and on current code');
    expect(r.stdout).toContain('src/coverage.test.mjs :: old coverage');
    expect(r.stdout).toContain('Open findings:');
    expect(r.stdout).toContain('[missing-test] src/sum.mjs: sum of two numbers: cover the result');
    expect(r.stdout).not.toMatch(/resume at plan|fix the spec or plan/i);
  });

  it('rejects a blocker when every new test passes on current code', async () => {
    const f = readyForReview(passing, report(true, false));
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('blocker finding has no failing test on current code');
    expect(r.stdout).toContain('Open blocker findings:');
    expect(r.stdout).toContain('[blocker] src/sum.mjs: sum behavior: cover the result');
  });

  it('accepts mixed failing and passing tests and runs Implement', async () => {
    const f = readyForReview(`${passing}; ${failing}`, report(true, true));
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual(['review', 'red-tests', 'implement', 'review']);
    expect(readReviewRounds(f.dir, LOG)[0]).toMatchObject({ loop: 1 });
    expect(r.stdout).not.toContain('Implement skipped:');
  });
});


describe('Review loop history across starts', () => {
  it('restores the finding on a Red tests resume and keeps the implementation commit', async () => {
    const f = readyForReview(vacuous);
    git(f.dir, 'add', 'src/sum.mjs');
    git(f.dir, 'commit', '-qm', `[implement] feat(${SLUG}): implement`);
    const commit = git(f.dir, 'rev-parse', 'HEAD').trim();
    const first = await pipeline(f, {}, { from: 'review' });
    expect(first.stdout).toContain('already pass at base commit and on current code');
    fs.writeFileSync(path.join(f.fake, 'red-tests.sh'), `set -e\n${passing}\n`);
    fs.writeFileSync(path.join(f.fake, 'review.sh'), STAGES.review);
    const resumed = await pipeline(f, {}, { from: 'red-tests' });
    const prompts = resumed.prompts.split('== red-tests');
    expect(prompts[prompts.length - 1]).toContain('cover the result');
    expect(git(f.dir, 'log', '--format=%H')).toContain(commit);
    expect(resumed.stdout).toContain('Implement skipped:');
    expect(resumed.status).toBe(0);
    expect(resumed.calls).toEqual(['red-tests', 'review']);
    expect(readReviewRounds(f.dir, LOG)[0]).toMatchObject({ loop: 1, outcome: 'implement-skipped' });
  });
  it('stops at the configured limit on a later start', async () => {
    const f = readyForReview(vacuous);
    const configPath = path.join(f.dir, 'sdlc.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    fs.writeFileSync(configPath, JSON.stringify({ ...config, review: { maxLoops: 1 } }));
    git(f.dir, 'add', 'sdlc.config.json');
    git(f.dir, 'commit', '-qm', 'set review loop limit');
    const first = await pipeline(f, {}, { from: 'review' });
    expect(first.status).toBe(1);
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
    expect(recovery.autoAction).toEqual({ label: 'Resume at Red tests', command: 'ai-sdlc-helper start x --from red-tests' });
    expect(recovery.manualAction?.file).toBe('logs/tests.log');
    expect(recovery.diagnosis).toContain('cover result');
    expect(recovery.manualAction?.instruction).toMatch(/assertion/i);
    expect(recovery.escapeHatch).toBeUndefined();
    const cli = formatRecoveryCli(stageRecoveryHint({ slug: 'x', stage: 'Red tests', state: 'failed', exitCode: 1, runOut: [lines.join('\n')] }));
    for (const detail of lines.slice(1).filter(line => !line.startsWith('Open '))) expect(cli).toContain(detail);
    expect(cli).toContain('ai-sdlc-helper start x --from red-tests');
    expect(cli).not.toMatch(/--from (plan|spec|implement)/);
  });
});


const appendCase = (body: string, file = 'src/sum.test.mjs') => `cat >> ${file} <<'CASE'
${body}
CASE
git add ${file}`;
const currentOnly = "test('added in review', async () => assert.equal((await import('./sum.mjs')).sum(4, 6), 10));";

// A task ready for Review. Keep the implementation uncommitted, as in local pipeline mode.
function readyForReview(extra: string, verdict = report(false, true), expected = 5) {
  const f = fixture({ 'red-tests': extra, implement, review: review(verdict) });
  git(f.dir, 'switch', '-qc', `feature/${SLUG}`);
  for (const name of ['specs-1.md', 'plan-1.md', 'test-cases-1.md']) fs.writeFileSync(path.join(f.dir, DOCS, name), 'fixture');
  const existing = `import { test } from 'node:test';
import assert from 'node:assert/strict';
test('sum adds', async () => assert.equal((await import('./sum.mjs')).sum(2, 3), ${expected}));
`;
  fs.writeFileSync(path.join(f.dir, 'src/sum.test.mjs'), existing);
  git(f.dir, 'add', '-A');
  git(f.dir, 'commit', '-qm', `[red-tests] test(${SLUG}): add failing tests`);
  fs.writeFileSync(path.join(f.dir, 'src/sum.mjs'), 'export const sum = (a, b) => a + b;\n');
  return f;
}

describe('fix-loop case identity and evidence', () => {
  it('shows the failing current case to Implement in a blocker-only round', async () => {
    const f = readyForReview(failing, report(true, false));
    fs.writeFileSync(path.join(f.fake, 'implement.sh'), `cp "$FAKE_LOG/tests.json" "$FAKE_DIR/implement-input.json"\n${implement}`);
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.calls).toEqual(['review', 'red-tests', 'implement', 'review']);
    expect(r.status).toBe(0);
    expect(JSON.parse(read(f.fake, 'implement-input.json')).tests).toContainEqual(expect.objectContaining({
      file: 'src/blocker.test.mjs', name: 'blocker coverage', status: 'failed',
    }));
    expect(readReviewRounds(f.dir, LOG)[0]).toMatchObject({ loop: 1 });
  });

  it('rejects a vacuous case even when another file has a failure with the same title', async () => {
    const f = readyForReview(`${vacuous}; ${failing.replace('blocker coverage', 'old coverage')}`, report(true, true));
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.calls).toEqual(['review', 'red-tests']);
    expect(r.stdout).toContain('RED GATE FAILED: test(s) already pass at base commit and on current code:');
    expect(r.stdout).toContain('src/coverage.test.mjs :: old coverage');
    expect(r.stdout).not.toContain('src/blocker.test.mjs :: old coverage');
  });

  it('accepts fresh cases in a staged existing file and records the file once', async () => {
    const additions = appendCase(`for (const n of [1, 2]) test('double ' + n, async () => assert.equal((await import('./sum.mjs')).sum(n, n), n * 2));`, 'src/existing.test.mjs');
    const f = readyForReview(additions);
    // The old runner-visible name incorporates three local implementation changes.
    // Omitting any from the inventory makes that old case look newly added.
    const oldFile = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { one } from './existing.mjs';
const name = [existsSync('src/sum.mjs'), existsSync('src/mode.txt') ? readFileSync('src/mode.txt', 'utf8') : 'default', existsSync('src/legacy.txt')].join('-');
test(name, () => assert.equal(one(), 1));
`;
    fs.writeFileSync(path.join(f.dir, 'src/existing.test.mjs'), oldFile);
    fs.writeFileSync(path.join(f.dir, 'src/mode.txt'), 'old');
    fs.writeFileSync(path.join(f.dir, 'src/legacy.txt'), 'old');
    git(f.dir, 'add', 'src/existing.test.mjs', 'src/mode.txt', 'src/legacy.txt');
    git(f.dir, 'commit', '-qm', 'record existing generated case and its inputs');
    fs.writeFileSync(path.join(f.dir, 'src/mode.txt'), 'new');
    fs.unlinkSync(path.join(f.dir, 'src/legacy.txt'));
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.status).toBe(0);
    expect(readReviewRounds(f.dir, LOG)[0]).toMatchObject({ outcome: 'implement-skipped', acceptedFiles: ['src/existing.test.mjs'] });
  });

  it('does not credit an unchanged failing case towards an open blocker', async () => {
    const f = readyForReview(appendCase(currentOnly), report(true, false), 6);
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.stdout).toContain('RED GATE FAILED: blocker finding has no failing test on current code.');
    expect(r.calls).toEqual(['review', 'red-tests']);
  });

  it.each([
    ['no changed test files', ':'],
    ['changed assertion with its old title', passing.replace('new coverage', 'sum adds').replace('src/coverage.test.mjs', 'src/sum.test.mjs')],
    ['duplicate runner-visible identity', appendCase([currentOnly, currentOnly].join('\n'))],
    ['current suite-load failure', 'echo "import \'./absent.mjs\';" > src/coverage.test.mjs'],
    ['baseline suite-load failure', passing + '\necho "import \'./sum.mjs\';" >> src/coverage.test.mjs'],
    ['baseline case skipped', appendCase("test('conditional', { skip: !(await import('node:fs')).existsSync('src/sum.mjs') }, async () => assert.equal((await import('./sum.mjs')).sum(1, 1), 2));")],
    ['baseline case missing', appendCase("if ((await import('node:fs')).existsSync('src/sum.mjs')) " + currentOnly)],
    ['current case skipped', appendCase(currentOnly.replace('test(', 'test.skip('))],
  ])('rejects insufficient evidence from %s before committing', async (_label, extra) => {
    const f = readyForReview(extra);
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.calls).toEqual(['review', 'red-tests']);
    expect(r.status).toBe(1);
    expect(statusOf(f.dir).resume_from).toBe('red-tests');
    expect(r.stdout).toMatch(/RED GATE FAILED/i);
    expect(r.stdout).not.toContain('blocker finding has no failing test');
    expect(r.stdout).not.toContain('already pass at base commit and on current code');
    expect(git(f.dir, 'log', '--format=%s', 'main..HEAD').match(/\[red-tests\]/g)).toHaveLength(1);
  });

  it('resumes a blocker with a pending untracked correction and runs Implement in its reserved slot', async () => {
    const f = readyForReview(passing, report(true, false));
    const first = await pipeline(f, {}, { from: 'review' });
    expect(first.stdout).toContain('blocker finding has no failing test');
    fs.writeFileSync(path.join(f.fake, 'implement.sh'), implement);
    fs.writeFileSync(path.join(f.fake, 'review.sh'), STAGES.review);
    // The user corrected the rejected file before resuming; the agent makes no further edit.
    fs.writeFileSync(path.join(f.dir, 'src/coverage.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('sum of nothing', async () => assert.equal((await import('./sum.mjs')).sum(), 0));\n");
    fs.writeFileSync(path.join(f.fake, 'red-tests.sh'), ':');
    const resumed = await pipeline(f, {}, { from: 'red-tests' });
    expect(resumed.status).toBe(0);
    expect(resumed.calls).toEqual(['red-tests', 'implement', 'review']);
    expect(readReviewRounds(f.dir, LOG)[0]).toMatchObject({ loop: 1, outcome: 'fixed' });
  });
});

describe('restart and recovery boundaries', () => {
  it.each(['spec', 'plan'] as const)('archives the exhausted history on an explicit %s restart', async from => {
    const f = readyForReview(passing);
    const old = [{ round: 1, loop: 20, verdict: 'changes', outcome: 'fixed', findings: [] }];
    fs.mkdirSync(path.join(f.dir, LOG), { recursive: true });
    fs.writeFileSync(path.join(f.dir, LOG, 'review-rounds.json'), JSON.stringify(old));
    const historyAtFirstAgent = vi.fn(() => readReviewRounds(f.dir, LOG));
    await pipeline(f, {}, { from, spawnAgent: async () => { historyAtFirstAgent(); return 1; } });
    expect(historyAtFirstAgent.mock.results[0]?.value).toEqual([]);
    const previous = path.join(f.dir, LOG, 'previous');
    expect(fs.existsSync(previous)).toBe(true);
    const archives = fs.readdirSync(previous).flatMap(dir => readReviewRounds(previous, dir));
    expect(archives).toEqual(old);
    const r = await pipeline(f, {}, { from: 'review' });
    expect(r.status).toBe(0);
    expect(readReviewRounds(f.dir, LOG)[0]).toMatchObject({ round: 1, loop: 1, outcome: 'implement-skipped' });
  });

  it('uses the newest fix-loop stop after an earlier initial-gate failure', () => {
    const recovery = stageRecoveryHint({
      slug: 'x', stage: 'Red tests', state: 'failed', exitCode: 1,
      runOut: ['SDLC: x on branch b', 'RED GATE FAILED: 1 new test(s) already pass before implementation:',
        'SDLC: x on branch b', 'RED GATE FAILED: blocker finding has no failing test on current code.',
        'Open blocker findings:', '[blocker] src/b.ts: correct output: handle zero'],
    });
    expect(recovery.diagnosis).toContain('handle zero');
    expect(recovery.autoAction?.command).toBe('ai-sdlc-helper start x --from red-tests');
  });
});
