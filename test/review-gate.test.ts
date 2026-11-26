import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readReviewRounds, parseReview } from '../src/pipeline/review-gate.js';
import { DOCS, LOG, SLUG, fixture, git, pipeline, read, type Fixture } from './pipeline-fixture.js';

afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
vi.setConfig({ testTimeout: 300_000 });

const CHANGES = (file: string, reason: string) => `{"verdict":"changes","blockers":[{"file":"${file}","criterion":"sum of nothing is 0","reason":"${reason}"}],"missingTests":[]}`;

/** Red tests and Implement stand-ins that add one more failing test and its code on every start after the first. */
const LOOP_STAGES = {
  'red-tests': `echo "cases" > "$FAKE_DOCS/test-cases-1.md"
printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { sum } from './sum.mjs';\\ntest('sum adds', () => assert.equal(sum(2, 3), 5));\\n" > src/sum.test.mjs
n=$(grep -c '^red-tests$' "$FAKE_DIR/calls.txt")
if [ "$n" -gt 1 ]; then printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\ntest('extra $n', async () => assert.equal((await import('./extra$n.mjs')).extra$n(), $n));\\n" > src/extra$n.test.mjs; fi`,
  implement: `printf 'export const sum = (a, b) => a + b;\\n' > src/sum.mjs
n=$(grep -c '^implement$' "$FAKE_DIR/calls.txt")
i=2; while [ "$i" -le "$n" ]; do printf "export const extra$i = () => $i;\\n" > src/extra$i.mjs; i=$((i+1)); done`,
};
/** A Review that asks for changes in its first FAKE_REVIEW_CHANGES starts, then passes. */
const reviewScript = (changes: string) => `echo "reviewed" > "$FAKE_DOCS/review-1.md"
n=$(grep -c '^review$' "$FAKE_DIR/calls.txt")
if [ "$n" -le "\${FAKE_REVIEW_CHANGES:-1}" ]; then printf '%s\\n' '${changes}' > "$FAKE_DOCS/review.json"; else printf '{"verdict":"pass","blockers":[],"missingTests":[]}\\n' > "$FAKE_DOCS/review.json"; fi`;

function configure(f: Fixture, review: Record<string, unknown>): void {
  const file = path.join(f.dir, 'sdlc.config.json');
  fs.writeFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), review }, null, 2)}\n`);
  git(f.dir, 'commit', '-q', '-am', 'review settings');
}
const errors = (f: Fixture): string => read(f.dir, `${LOG}/errors.log`);

describe('Review findings are acted on', () => {
  test('changes: Red tests (with the findings), Implement, Review again; Finalise only after a pass', async () => {
    const f = fixture({ ...LOOP_STAGES, review: reviewScript(CHANGES('src/sum.mjs', 'no argument gives NaN')) });
    const r = await pipeline(f, { FAKE_REVIEW_CHANGES: '1' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'implement', 'review', 'red-tests', 'implement', 'review']);
    // the second Red tests prompt carries the finding; the first does not
    const reds = r.prompts.split('== ').filter(p => p.startsWith('red-tests'));
    expect(reds[0]).not.toContain('no argument gives NaN');
    expect(reds[1]).toContain('[blocker] src/sum.mjs: sum of nothing is 0: no argument gives NaN');
    expect(JSON.parse(read(f.dir, `${DOCS}/review.json`)).verdict).toBe('pass');
    const rounds = readReviewRounds(f.dir, LOG);
    expect(rounds.map(x => [x.round, x.verdict])).toEqual([[1, 'changes'], [2, 'pass']]);
    expect(rounds[0].findings.map(x => x.status)).toEqual(['fixed']);
    expect(git(f.dir, 'log', '--format=%s', 'main..HEAD')).toContain('[finalise]');
  });

  test('a Review that changes files: the changes are undone, logged and shown, the verdict counts, nothing is committed', async () => {
    const f = fixture({ review: `${reviewScript('{}')}
sed -i.bak 's/a + b/a - b/' src/sum.mjs && rm -f src/sum.mjs.bak
echo "x" > src/rogue.mjs
echo "tampered" > src/dev-note.txt
printf '{"verdict":"pass","blockers":[],"missingTests":[]}\\n' > "$FAKE_DOCS/review.json"` });
    fs.writeFileSync(path.join(f.dir, 'src/dev-note.txt'), 'the developer wrote this\n');
    const r = await pipeline(f, { FAKE_REVIEW_CHANGES: '0' });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('changed 3 file(s) although it only reports');
    expect(r.stderr).toContain('src/rogue.mjs');
    expect(errors(f)).toContain('src/sum.mjs');
    expect(read(f.dir, 'src/sum.mjs')).toBe('export const sum = (a, b) => a + b;\n');
    expect(fs.existsSync(path.join(f.dir, 'src/rogue.mjs'))).toBe(false);
    expect(read(f.dir, 'src/dev-note.txt')).toBe('the developer wrote this\n');
    expect(git(f.dir, 'log', '--format=%H', '-p', 'main..HEAD')).not.toContain('a - b');
    expect(git(f.dir, 'ls-files')).not.toContain('rogue');
  });

  test('maxLoops reached with open findings: the run fails and lists each finding with the resume hints', async () => {
    const f = fixture({ ...LOOP_STAGES, review: reviewScript(`{"verdict":"changes","blockers":[{"file":"src/a.mjs","criterion":"first rule","reason":"first reason"}],"missingTests":[{"file":"src/b.mjs","criterion":"second rule","reason":"second reason"}]}`) });
    configure(f, { maxLoops: 1 });
    const r = await pipeline(f, { FAKE_REVIEW_CHANGES: '9' });
    expect(r.status).toBe(1);
    expect(r.calls.filter(c => c === 'review')).toHaveLength(2);
    expect(r.stdout).toContain('REVIEW NOT RESOLVED after 1 fix loop(s): 2 finding(s) still open');
    expect(r.stdout).toContain('[blocker] src/a.mjs: first rule: first reason');
    expect(r.stdout).toContain('[missing test] src/b.mjs: second rule: second reason');
    expect(r.stdout).toContain(`ai-sdlc-helper pipeline ${SLUG} --from review`);
    expect(errors(f)).toContain('first reason');
    expect(git(f.dir, 'log', '--format=%s', 'main..HEAD')).not.toContain('[finalise]');
    const rounds = readReviewRounds(f.dir, LOG);
    expect(rounds).toHaveLength(2);
    expect(rounds[0].findings.map(x => x.status)).toEqual(['still open', 'still open']);
  });

  test('a blocker with only a baseline failure stops with a blocker diagnosis in output and errors.log', async () => {
    const f = fixture({
      ...LOOP_STAGES,
      'red-tests': `${LOOP_STAGES['red-tests']}
n=$(grep -c '^red-tests$' "$FAKE_DIR/calls.txt")
if [ "$n" -gt 1 ]; then printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\ntest('already true', async () => assert.equal((await import('./sum.mjs')).sum(1, 1), 2));\\n" > src/extra$n.test.mjs; fi`,
      review: reviewScript(CHANGES('src/sum.mjs', 'claims a bug that is not there')),
    });
    const r = await pipeline(f, { FAKE_REVIEW_CHANGES: '1' });
    expect(r.status).toBe(1);
    for (const output of [r.stdout, errors(f)]) {
      expect(output).toContain('RED GATE FAILED: blocker finding has no failing test on current code.');
      expect(output).toContain('[blocker] src/sum.mjs: sum of nothing is 0: claims a bug that is not there');
    }
  });

  test.each([
    ['no review.json', 'echo "reviewed" > "$FAKE_DOCS/review-1.md"', 'Review wrote no report'],
    ['invalid JSON', 'echo "{not json" > "$FAKE_DOCS/review.json"', 'is not valid JSON'],
    ['a verdict that is not pass or changes', `echo '{"verdict":"maybe"}' > "$FAKE_DOCS/review.json"`, '"verdict" must be'],
    ['changes without a finding', `echo '{"verdict":"changes","blockers":[]}' > "$FAKE_DOCS/review.json"`, 'lists no finding'],
  ])('%s: the run stops and the reason is kept in errors.log', async (_name, script, reason) => {
    const f = fixture({ review: script });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`REVIEW FAILED: `);
    expect(r.stderr).toContain(reason);
    expect(errors(f)).toContain(reason);
    expect(git(f.dir, 'log', '--format=%s', 'main..HEAD')).not.toContain('[finalise]');
  });

  test('parseReview accepts a report with findings and reads absent lists as empty', () => {
    const dir = path.join(fixture().dir);
    fs.writeFileSync(path.join(dir, 'r.json'), '{"verdict":"changes","blockers":[{"file":"a","criterion":"b","reason":"c"}]}');
    expect(parseReview(dir, 'r.json')).toEqual({ verdict: 'changes', findings: [{ kind: 'blocker', file: 'a', criterion: 'b', reason: 'c' }] });
  });
});

describe('multi-model Review', () => {
  const reviewers = `case "$FAKE_PROMPT" in
  *review-r1.json*) n=1; file=review-r1.json ;; *) n=2; file=review-r2.json ;;
esac
echo "reviewed" > "$FAKE_DOCS/review-1.md"
if [ "$n" = 1 ]; then printf '%s\\n' '${CHANGES('src/a.mjs', 'from the first reviewer')}' > "$FAKE_DOCS/$file"
else printf '%s\\n' '{"verdict":"changes","blockers":[],"missingTests":[{"file":"src/b.mjs","criterion":"edge","reason":"from the second reviewer"}]}' > "$FAKE_DOCS/$file"; fi`;
  const union = `node -e "
const fs=require('fs');const d=process.env.FAKE_DOCS;
const a=JSON.parse(fs.readFileSync(d+'/review-r1.json','utf8')),b=JSON.parse(fs.readFileSync(d+'/review-r2.json','utf8'));
fs.writeFileSync(d+'/review.json',JSON.stringify({verdict:'changes',blockers:[...a.blockers,...b.blockers],missingTests:[...a.missingTests,...b.missingTests]}));"`;

  test('every reviewer writes its own file and the summariser\'s review.json holds the union', async () => {
    const f = fixture({ review: reviewers, 'review-summary': union });
    configure(f, { maxLoops: 0, mode: 'multi', reviewers: 2 });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.calls.filter(c => c === 'review')).toHaveLength(2);
    expect(r.calls).toContain('review-summary');
    const merged = JSON.parse(read(f.dir, `${DOCS}/review.json`));
    expect(merged.blockers.map((b: { reason: string }) => b.reason)).toEqual(['from the first reviewer']);
    expect(merged.missingTests.map((b: { reason: string }) => b.reason)).toEqual(['from the second reviewer']);
    expect(r.stdout).toContain('[blocker] src/a.mjs: sum of nothing is 0: from the first reviewer');
    expect(r.stdout).toContain('[missing test] src/b.mjs: edge: from the second reviewer');
  });

  test('a summariser that drops a finding does not lose it', async () => {
    const f = fixture({ review: reviewers, 'review-summary': `printf '%s\\n' '${CHANGES('src/a.mjs', 'from the first reviewer')}' > "$FAKE_DOCS/review.json"` });
    const r = await pipeline(f, { SDLC_REVIEW_MODE: 'multi' }, {});
    configure(f, { maxLoops: 0 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('from the second reviewer');
    expect(errors(f)).toContain('the review summariser dropped 1 finding(s)');
  });

  test('two reviewers on one model are refused before any agent runs', async () => {
    const f = fixture();
    const r = await pipeline(f, { SDLC_REVIEW_MODE: 'multi', SDLC_REVIEW_REVIEWERS: '2', MODEL_REVIEW_2: 'opus' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('review and review-2 both use claude:opus');
    expect(errors(f)).toContain('must use different models');
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'implement']);
  });

  test('a reviewer and the summariser on one model are refused', async () => {
    const f = fixture();
    const r = await pipeline(f, { SDLC_REVIEW_MODE: 'multi', MODEL_REVIEW_SUMMARY: 'opus' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('review and review-summary both use claude:opus');
    expect(r.calls).not.toContain('review');
  });
});
