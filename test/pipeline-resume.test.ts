import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DOCS, LOG, SLUG, filesIn, fixture, git, pipeline, read, statusOf, subjects,
} from './pipeline-fixture.js';

// The runs are long chains of synchronous git and test runs: yield between tests so the runner's messages get through.
afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
// A run takes seconds, and many more on a loaded machine.
vi.setConfig({ testTimeout: 300_000 });

describe('resuming', () => {
  test('a resumed Implement reads a fresh tests.log, and tests the developer committed meanwhile are not a guard failure', async () => {
    const f = fixture();
    let r = await pipeline(f, { MAX_ATTEMPTS: '1', FAKE_NO_IMPL: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`GREEN GATE FAILED after 1 attempts and no test defect was claimed. See ${LOG}/tests.log`);
    // a stale log, and the branch brought up to date with a change to an existing test
    fs.writeFileSync(path.join(f.dir, LOG, 'tests.log'), 'STALE: everything passed\n');
    fs.appendFileSync(path.join(f.dir, 'src/existing.test.mjs'), "test('one is still 1', () => assert.equal(one(), 1));\n");
    git(f.dir, 'commit', '-qam', `Merge branch 'main' into feature/${SLUG}`);
    for (const x of fs.readdirSync(f.fake).filter(x => x.startsWith('seen-tests-'))) fs.rmSync(path.join(f.fake, x));

    r = await pipeline(f, { FROM: 'implement' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toMatch(/Resuming at implement from tests commit [0-9a-f]{7}\n/);
    expect(r.stdout).not.toContain('GUARD FAILED');
    expect(r.calls).toEqual(['implement', 'review']);
    const seen = read(f.fake, 'seen-tests-0.log');
    expect(seen).not.toContain('STALE');
    expect(seen).toContain('ERROR src/sum.test.mjs: failed to run');
    // The earlier run's log was moved aside, not deleted.
    const aside = fs.readdirSync(path.join(f.dir, LOG, 'previous')).map(d => path.join(f.dir, LOG, 'previous', d, 'tests.log')).filter(x => fs.existsSync(x));
    expect(aside.map(x => fs.readFileSync(x, 'utf8'))).toContain('STALE: everything passed\n');
  });

  test('FROM=implement without a red-tests commit fails, and FROM=plan without a spec fails', async () => {
    const f = fixture();
    let r = await pipeline(f, { FROM: 'implement' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`WARNING: no baseline from the original run`);
    expect(r.stdout).toContain(`FROM=implement but no red-tests commit found for ${SLUG}`);
    r = await pipeline(f, {}, { from: 'plan' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`FROM=plan but ${DOCS}/specs-1.md is missing: run Spec first`);
    expect(r.calls).toEqual([]);
  });
});

describe('Test repair', () => {
  // The red test expects sum(2, 3) to be 6; the Implement agent claims it contradicts the spec.
  const CLAIMING = { FAKE_EXPECT: '6', FAKE_CLAIM: '1', MAX_ATTEMPTS: '1' };

  test('a failed repair agent says how to resume; the resumed run locks the tests at the branch head and finalises', async () => {
    const f = fixture();
    let r = await pipeline(f, { ...CLAIMING, FAKE_REPAIR_FAILS: '1' });
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'implement', 'test-repair']);
    expect(r.stdout).toContain(`== 4b Test repair (only because the Implement agent claimed test defects)\n`);
    expect(r.stdout).toContain(`   !! agent 'test-repair' failed, see ${LOG}/test-repair.log\nResume at Test repair once fixed: ai-sdlc-helper pipeline ${SLUG} --from test-repair\n`);
    expect(statusOf(f.dir)).toMatchObject({ state: 'failed', stage: 'Test repair' });

    // the developer brings the branch up to date: a commit that changes another test
    fs.appendFileSync(path.join(f.dir, 'src/existing.test.mjs'), "test('one is still 1', () => assert.equal(one(), 1));\n");
    git(f.dir, 'commit', '-qam', `Merge branch 'main' into feature/${SLUG}`);
    r = await pipeline(f, { MAX_ATTEMPTS: '1' }, { from: 'test-repair' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.calls).toEqual(['test-repair', 'test-audit', 'review']);
    expect(r.stdout).toMatch(/ test repair accepted; tests locked again at [0-9a-f]{7}\n/);
    expect(subjects(f.dir)).toEqual([
      `chore(backlog): mark ${SLUG} done`, `feat(${SLUG}): implement per ${DOCS}/specs-1.md`,
      `test(${SLUG}): repair invalid tests (mechanically checked and audited)`, `Merge branch 'main' into feature/${SLUG}`,
      `test(${SLUG}): add failing tests and spec/plan docs`,
    ]);
    expect(filesIn(f.dir, 'HEAD~2')).toEqual(['src/sum.test.mjs', `${DOCS}/test-audit.md`, `${DOCS}/test-issues.md`, `${DOCS}/test-repair-1.md`]);
    expect(read(f.dir, `${LOG}/test-repair.diff`)).toContain('+test(\'sum adds\', () => assert.equal(sum(2, 3), 5));');
    expect(read(f.dir, `${DOCS}/test-audit.md`)).toBe('VERDICT: VALID\n');
    // the auditor runs read-only, with its own model
    const audit = read(f.fake, 'args-test-audit.txt').split('\n');
    expect(audit.slice(audit.indexOf('--model'))).toEqual(['--model', 'opus', '--effort', 'medium', '--allowedTools', 'Read', 'Glob', 'Grep', '--max-turns', '15', '']);
  });

  test('an auditor that does not say VALID rejects the repair and restores the tests', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.fake, 'test-audit.out'), 'The new test asserts what the code returns.\nVERDICT: INVALID\n');
    const r = await pipeline(f, CLAIMING);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('TEST REPAIR REJECTED: independent auditor did not return VERDICT: VALID\n   tests restored to ');
    expect(read(f.dir, 'src/sum.test.mjs')).toContain('sum(2, 3), 6');
    expect(subjects(f.dir)).toEqual([`test(${SLUG}): add failing tests and spec/plan docs`]);
  });

  test('FROM=test-repair checks its preconditions first: no red-tests commit means no agent and no change', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, DOCS, 'test-issues.md'), 'src/sum.test.mjs :: sum adds :: contradicts the spec decision\n');
    const head = git(f.dir, 'rev-parse', 'HEAD');
    const r = await pipeline(f, { FROM: 'test-repair' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`REJECT: no red-tests commit found for ${SLUG}`);
    expect(r.calls).toEqual([]);
    expect(git(f.dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(read(f.dir, `${DOCS}/test-issues.md`)).toContain('sum adds');
  });
});
