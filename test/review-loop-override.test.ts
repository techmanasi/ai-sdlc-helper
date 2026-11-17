import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fixture, git, pipeline, type Fixture } from './pipeline-fixture.js';

afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
vi.setConfig({ testTimeout: 300_000 });

const CHANGES = (file: string, reason: string) => `{"verdict":"changes","blockers":[{"file":"${file}","criterion":"sum of nothing is 0","reason":"${reason}"}],"missingTests":[]}`;

/** Red tests and Implement stand-ins that add one more failing test and its code on every start after the first. */
const LOOP_STAGES = {
  'red-tests': `echo "cases" > "$FAKE_DOCS/test-cases-1.md"
printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { sum } from './sum.mjs';\\ntest('sum adds', () => assert.equal(sum(2, 3), 5));\\n" > src/sum.test.mjs
n=$(grep -c '^red-tests$' "$FAKE_DIR/calls.txt")
if [ "$n" -gt 1 ]; then printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { extra$n } from './extra$n.mjs';\\ntest('extra $n', () => assert.equal(extra$n(), $n));\\n" > src/extra$n.test.mjs; fi`,
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
describe('per-run review loop limit', () => {
  test.each([{ file: 3, override: '0', loops: 0 }, { file: 0, override: '1', loops: 1 }])('override $override takes precedence over project value $file', async ({ file, override, loops }) => {
    const f = fixture({ ...LOOP_STAGES, review: reviewScript(CHANGES('src/sum.mjs', 'still open')) });
    configure(f, { maxLoops: file });
    const r = await pipeline(f, { SDLC_REVIEW_MAX_LOOPS: override, FAKE_REVIEW_CHANGES: '9' });
    expect(r.status).toBe(1);
    expect(r.calls.filter(c => c === 'review')).toHaveLength(loops + 1);
    expect(r.calls.filter(c => c === 'implement')).toHaveLength(loops + 1);
    expect(r.stdout).toContain(`REVIEW NOT RESOLVED after ${loops} fix loop(s)`);
  });
});
