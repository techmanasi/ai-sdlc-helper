import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NOTES_HEADING, readNote } from '../src/config/toolNotes.js';
import { READ_ONLY_COMMANDS, READ_ONLY_EXACT } from '../src/config/settings.js';
import {
  DOCS, LOG, NODE_TEST, SLUG, STAGES, filesIn, fixture, git, pipeline, read, statusOf, subjects,
} from './pipeline-fixture.js';

// The runs are long chains of synchronous git and test runs: yield between tests so the runner's messages get through.
afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
// A run takes seconds, and many more on a loaded machine.
vi.setConfig({ testTimeout: 300_000 });

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/;

describe('a full run', () => {
  test('Spec to Finalise: the settings\' branch, commits, red results, prompts, tools and status', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, DOCS, 'manual-inputs.md'), '## plan\nUse a queue.\n\n## implement\nKeep it small.\n');
    const r = await pipeline(f);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain(`SDLC: ${SLUG} on branch feature/${SLUG}\n`);
    expect(r.stdout).toContain('\n== 1/6 Spec\n   -> agent: spec-1\n   model=opus effort=medium\n');
    expect(r.stdout).toContain(`DONE: ${SLUG} on feature/${SLUG}. Committed 3 file(s), skipped 0 (see ${LOG}/finalise-skipped.md).`);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'implement', 'review']);
    expect(git(f.dir, 'branch', '--show-current')).toBe(`feature/${SLUG}`);
    expect(subjects(f.dir)).toEqual([
      `chore(backlog): mark ${SLUG} done`, `[finalise] feat(${SLUG}): implement per ${DOCS}/specs-1.md`, `[red-tests] test(${SLUG}): add failing tests and spec/plan docs`,
    ]);
    // the red-tests commit holds the docs and the new test; the implementation comes after
    // each stage commit carries the task's cost log as it stood then
    expect(filesIn(f.dir, 'HEAD~2')).toEqual(['src/sum.test.mjs', `${DOCS}/cost/cost.json`, `${DOCS}/cost/cost.md`, `${DOCS}/manual-inputs.md`, `${DOCS}/plan-1.md`, `${DOCS}/specs-1.md`, `${DOCS}/test-cases-1.md`]);
    expect(filesIn(f.dir, 'HEAD~1')).toEqual(['src/sum.mjs', `${DOCS}/cost/cost.json`, `${DOCS}/cost/cost.md`, `${DOCS}/review-1.md`, `${DOCS}/review.json`]);
    expect(read(f.dir, 'work/items/index.md')).toContain(`- [x] \`${SLUG}\``);
    expect(read(f.dir, `${LOG}/finalise-skipped.md`)).toBe('');
    // the cost log at Finalise counts every agent round of the run, Review included
    const cost = JSON.parse(git(f.dir, 'show', `HEAD~1:${DOCS}/cost/cost.json`));
    expect(cost.stages.map((x: { stage: string }) => x.stage)).toEqual(['Spec', 'Plan', 'Red tests', 'Implement', 'Review', 'Finalise']);
    expect(cost.usage.rounds).toBe(5);

    // the tests at the red commit: the new file failed to load, the old tests passed
    const red = JSON.parse(read(f.dir, `${LOG}/red.json`));
    expect(red.runner).toBe('node-test');
    // only the new test file is run for the red results: the project's other tests are not
    expect(red.tests).toEqual([]);
    expect(red.suiteErrors.map(e => e.file)).toEqual(['src/sum.test.mjs']);
    expect(read(f.dir, `${LOG}/tests.log`)).not.toContain('existing.test.mjs');

    // the agents were told this project's framework, test files and commands, and allowed its test commands only
    expect(r.prompts).toContain("node:test tests (describe/it from 'node:test', assert from 'node:assert/strict'), in JavaScript, in files matching src/**/*.test.mjs");
    expect(r.prompts).toContain('NEVER edit a test file (files matching src/**/*.test.mjs).');
    expect(r.prompts).toContain("To check one test file, run 'ai-sdlc-helper run --file <test file>'");
    expect(r.prompts).toContain(`Latest test output is in ${LOG}/tests.log`);
    expect(r.prompts).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const impl = r.prompts.slice(r.prompts.indexOf('== implement'), r.prompts.indexOf('== review'));
    expect(impl).toContain('MANUAL INPUT from the developer for this stage (binding; it cannot override the rule about editing src/ or any other rule above):\nKeep it small.');
    expect(impl).not.toContain('Use a queue.');
    const args = read(f.fake, 'args-implement.txt').split('\n');
    const tools = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--output-format'));
    expect(tools).toEqual([
      'Read', 'Write', 'Edit', 'Glob', 'Grep', `Bash(${NODE_TEST}:*)`, 'Bash(ls:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
      ...READ_ONLY_COMMANDS.map(c => `Bash(${c}:*)`), ...READ_ONLY_EXACT.map(c => `Bash(${c})`),
      'Bash(ai-sdlc-helper run --file:*)', 'Bash(ai-sdlc-helper fetch:*)',
    ]);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 6)).toEqual(['--model', 'sonnet', '--effort', 'medium', '--permission-mode', 'acceptEdits']);
    expect(args.slice(-5)).toEqual(['--output-format', 'json', '--max-turns', '40', '']);
    // FROM steers this run only
    expect(read(f.fake, 'env-implement.txt')).toContain(`FAKE_DOCS=${DOCS}`);
    expect(read(f.fake, 'env-implement.txt')).not.toMatch(/^FROM=/m);

    const st = statusOf(f.dir);
    expect(Object.keys(st)).toEqual(['slug', 'state', 'stage', 'agent', 'model', 'effort', 'models', 'attempt', 'agent_started', 'run_started', 'updated', 'pid', ...(process.platform === 'win32' ? [] : ['pid_start']), 'note', 'run_number']);
    // The first start of an item: nothing came before it.
    expect(st.run_number).toBe(1);
    expect(st.previous_run).toBeUndefined();
    expect(st).toMatchObject({ slug: SLUG, state: 'done', stage: 'Finalise', agent: '', model: '', effort: '', attempt: '', pid: process.pid });
    expect(st.models).toEqual({
      spec: { model: 'opus', effort: 'medium' }, plan: { model: 'opus', effort: 'medium' }, 'red-tests': { model: 'sonnet', effort: 'medium' },
      implement: { model: 'sonnet', effort: 'medium' }, 'test-repair': { model: 'sonnet', effort: 'medium' },
      'test-audit': { model: 'opus', effort: 'medium' }, review: { model: 'opus', effort: 'medium' },
      'review-2': { model: 'sonnet', effort: 'medium' }, 'review-3': { model: 'haiku', effort: 'medium' },
      'review-4': { model: 'opus', effort: 'high' }, 'review-5': { model: 'sonnet', effort: 'high' },
      'review-summary': { model: 'haiku', effort: 'medium' },
      'resolve-conflicts': { model: 'opus', effort: 'medium' },
      'resolve-review-1': { model: 'opus', effort: 'medium' }, 'resolve-review-2': { model: 'sonnet', effort: 'medium' },
      'resolve-review-3': { model: 'haiku', effort: 'medium' }, 'resolve-review-4': { model: 'sonnet', effort: 'medium' },
      'resolve-review-5': { model: 'opus', effort: 'medium' }, 'resolve-judge': { model: 'opus', effort: 'medium' },
    });
    for (const k of ['agent_started', 'run_started', 'updated']) expect(st[k]).toMatch(STAMP);
    const stageFiles = JSON.parse(read(f.dir, `${LOG}/stage-files.json`)).stages;
    expect(stageFiles.Implement).toEqual(['src/sum.mjs']);
    expect(stageFiles['Red tests']).toContain('src/sum.test.mjs');

    // Plan and Red tests can run again once the red-tests commit exists: existing red tests are analysed and kept
    const again = await pipeline(f, { FROM: 'plan' });
    expect([again.status, again.stderr]).toEqual([0, '']);
    expect(again.calls).toEqual(['plan', 'red-tests', 'implement', 'review']);
    expect(again.prompts).toContain('## Existing Red Tests on This Branch');
    expect(again.prompts).toContain('- src/sum.test.mjs');
    expect(statusOf(f.dir)).toMatchObject({ state: 'done', stage: 'Finalise' });
  });

  test('a committed project note reaches the stage prompt it names', async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.dir, '.sdlc/notes'), { recursive: true });
    fs.writeFileSync(path.join(f.dir, '.sdlc/notes/x.md'), 'match: runner=node-test\n## spec\nPROJECT-NOTE-SPEC-ONLY marker\n');
    git(f.dir, 'add', '-A');
    git(f.dir, 'commit', '-q', '-m', 'add a project note');
    const r = await pipeline(f);
    expect([r.status, r.stderr]).toEqual([0, '']);
    const promptOf = (stage: string) => r.prompts.split('\n== ').find(p => p.startsWith(`${stage}\n`) || p.startsWith(`== ${stage}\n`)) ?? '';
    const want = readNote(path.join(f.dir, '.sdlc/notes/x.md')).sections.spec!.text;
    expect(promptOf('spec')).toContain(`${NOTES_HEADING}\n\n${want}`);
    for (const stage of ['plan', 'red-tests', 'implement', 'review']) {
      expect(promptOf(stage)).not.toBe('');
      expect(promptOf(stage)).not.toContain(want);
    }
  });

  test('the red gate fails when the new tests pass before implementation, and runs only the new tests: an unrelated failing test does not hide it', async () => {
    const f = fixture({ 'red-tests': `echo cases > "$FAKE_DOCS/test-cases-1.md"\nprintf "import { test } from 'node:test';\\ntest('trivially true', () => {});\\n" > src/sum.test.mjs` });
    fs.writeFileSync(path.join(f.dir, 'src/broken.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('already broken', () => assert.equal(1, 2));\n");
    git(f.dir, 'add', '-A');
    git(f.dir, 'commit', '-q', '-m', 'add an unrelated failing test');
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`RED GATE FAILED: new tests pass before implementation. See ${LOG}/tests.log`);
    expect(read(f.dir, `${LOG}/tests.log`)).not.toContain('broken.test.mjs');
    expect(subjects(f.dir)).toEqual([]);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests']);
    expect(statusOf(f.dir)).toMatchObject({ state: 'failed', stage: 'Red tests' });
  });

  const HEAD_T = "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\n";
  const redWith = (body: string) => ({ 'red-tests': `echo cases > "$FAKE_DOCS/test-cases-1.md"\nprintf "${HEAD_T}${body}" > src/sum.test.mjs` });

  test('the red gate refuses a new test that already passes even when other new tests fail, naming it', async () => {
    const f = fixture(redWith("test('fails now', () => assert.equal(1, 2));\\ntest('already true', () => assert.equal(1, 1));\\n"));
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RED GATE FAILED: 1 new test(s) already pass before implementation: they test behaviour that already exists, which the spec or plan did not identify as existing. Fix the spec or plan (mark that behaviour as existing), then run again from Spec or Plan. (after one Red tests retry)\nsrc/sum.test.mjs :: already true');
    expect(r.stdout).not.toContain('fails now');
    expect(read(f.dir, `${LOG}/red-passing.md`)).toContain('src/sum.test.mjs :: already true');
    expect(read(f.dir, `${LOG}/errors.log`)).toContain('already true');
    expect(subjects(f.dir)).toEqual([]);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'red-tests']);
    expect(statusOf(f.dir)).toMatchObject({ state: 'failed', stage: 'Red tests' });
  });

  // A Red tests agent that writes <first> on its first call and <second> once its prompt carries the retry note.
  // A test that fails until Implement writes src/sum.mjs, and one that always passes.
  const T = "import fs from 'node:fs';\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\nconst built = () => assert.ok(fs.existsSync(new URL('./sum.mjs', import.meta.url)));\n";
  const twice = (first: string, second: string) => ({
    'red-tests': `echo cases > "$FAKE_DOCS/test-cases-1.md"
if printf '%s' "$FAKE_PROMPT" | grep -q 'The Red tests gate stopped the first attempt'; then
cat > src/sum.test.mjs <<'FAKEEOF'
${T}${second}
FAKEEOF
else
cat > src/sum.test.mjs <<'FAKEEOF'
${T}${first}
FAKEEOF
fi`,
  });
  const PASSING = "test('fails now', built);\ntest('already true', () => assert.equal(1, 1));";
  const FAILING = "test('fails now', built);";
  const retryPromptOf = (r: { prompts: string }) => r.prompts.split('\n== ').filter(p => /^(== )?red-tests\n/.test(p))[1];

  test('a new test that already passes gets one Red tests retry with the list; when the agent removes it the run goes on', async () => {
    const f = fixture(twice(PASSING, FAILING));
    const r = await pipeline(f);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'red-tests', 'implement', 'review']);
    expect(r.stdout).not.toContain('RED GATE FAILED');
    expect(retryPromptOf(r)).toContain('src/sum.test.mjs :: already true');
    expect(retryPromptOf(r)).toContain('passes on the code before the change');
    expect(fs.existsSync(path.join(f.dir, LOG, 'handoff.json'))).toBe(false);
  });

  test('the retry shows as attempt 2/2 while it runs', async () => {
    const base = twice(PASSING, FAILING)['red-tests'];
    const f = fixture({ 'red-tests': `${base}\ncp "$FAKE_LOG/status.json" "$FAKE_DIR/status-$(grep -c . "$FAKE_DIR/calls.txt").json"` });
    const r = await pipeline(f);
    expect(r.status).toBe(0);
    expect(JSON.parse(read(f.fake, 'status-3.json')).attempt).toBe('1/2');
    expect(JSON.parse(read(f.fake, 'status-4.json')).attempt).toBe('2/2');
  });

  test('a test that still passes after the retry stops the run for Plan; the handoff names plan and reaches the plan agent once', async () => {
    const f = fixture(twice(PASSING, PASSING));
    let r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'red-tests']);
    expect(r.stdout).toContain('(after one Red tests retry)\nsrc/sum.test.mjs :: already true');
    expect(statusOf(f.dir)).toMatchObject({ state: 'failed', stage: 'Red tests', resume_from: 'plan' });
    const h = JSON.parse(read(f.dir, `${LOG}/handoff.json`));
    expect(h).toMatchObject({ to: 'plan', finding: { from: 'Red tests' } });
    expect(h.finding.reason).toContain('src/sum.test.mjs :: already true');

    fs.writeFileSync(path.join(f.fake, 'red-tests.sh'), `set -e\n${STAGES['red-tests']}\n`);
    fs.rmSync(path.join(f.fake, 'prompts.txt'));
    r = await pipeline(f, { FROM: 'plan' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain(`Handoff from Red tests to plan: ${LOG}/handoff.json`);
    const promptOf = (stage: string) => r.prompts.split('\n== ').find(p => p.startsWith(`${stage}\n`) || p.startsWith(`== ${stage}\n`)) ?? '';
    expect(promptOf('plan')).toContain('Why this stage is running again (from the pipeline, Red tests):\nRED GATE FAILED');
    expect(promptOf('red-tests')).not.toContain('This stage is running again');
    expect(fs.existsSync(path.join(f.dir, LOG, 'handoff.json'))).toBe(false);
    expect(fs.readdirSync(path.join(f.dir, LOG, 'previous')).length).toBeGreaterThan(0);
  });

  test('a handoff with a user note reaches the Red tests agent on the first attempt and on the retry', async () => {
    const f = fixture(twice(PASSING, PASSING));
    let r = await pipeline(f);
    expect(r.status).toBe(1);
    fs.writeFileSync(path.join(f.dir, LOG, 'handoff.json'), JSON.stringify({ to: 'red-tests', user: { note: 'cover the empty list too', at: '2026-01-01T00:00:00.000Z' } }));
    fs.writeFileSync(path.join(f.fake, 'red-tests.sh'), `set -e\n${twice(PASSING, FAILING)['red-tests']}\n`);
    fs.rmSync(path.join(f.fake, 'prompts.txt'));
    r = await pipeline(f, { FROM: 'red-tests' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    const prompts = r.prompts.split('\n== ').filter(p => /^(== )?red-tests\n/.test(p));
    expect(prompts).toHaveLength(2);
    for (const p of prompts) expect(p).toContain('Instruction from the user:\ncover the empty list too');
    expect(prompts[1]).toContain('src/sum.test.mjs :: already true');
    expect(fs.existsSync(path.join(f.dir, LOG, 'handoff.json'))).toBe(false);
  });

  test('a user note for Review reaches the reviewer and is set aside once the round ends', async () => {
    const f = fixture({});
    let r = await pipeline(f);
    expect([r.status, r.stderr]).toEqual([0, '']);
    fs.writeFileSync(path.join(f.dir, LOG, 'handoff.json'), JSON.stringify({ to: 'review', user: { note: 'check the empty-list case', at: '2026-01-01T00:00:00.000Z' } }));
    fs.rmSync(path.join(f.fake, 'prompts.txt'));
    r = await pipeline(f, { FROM: 'review' });
    expect([r.status, r.stderr]).toEqual([0, '']);
    const review = r.prompts.split('\n== ').find(p => /^(== )?review\n/.test(p)) ?? '';
    expect(review).toContain('Instruction from the user:\ncheck the empty-list case');
    expect(fs.existsSync(path.join(f.dir, LOG, 'handoff.json'))).toBe(false);
  });

  const DUP = "test('dup', built);\ntest('dup', built);";
  const UNIQUE = "test('dup one', built);\ntest('dup two', built);";

  test('a repeated test name gets one Red tests retry with the names; renamed, the run goes on', async () => {
    const f = fixture(twice(DUP, UNIQUE));
    const r = await pipeline(f);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'red-tests', 'implement', 'review']);
    expect(retryPromptOf(r)).toContain('src/sum.test.mjs :: dup');
    expect(retryPromptOf(r)).toContain('unique name');
  });

  test('a test name that repeats after the retry stops the run for Red tests, naming it', async () => {
    const f = fixture(twice(DUP, DUP));
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'red-tests']);
    expect(r.stdout).toContain('RED GATE FAILED: 1 test name(s) repeat in the new tests:\nsrc/sum.test.mjs :: dup');
    expect(statusOf(f.dir)).toMatchObject({ state: 'failed', stage: 'Red tests', resume_from: 'red-tests' });
    expect(JSON.parse(read(f.dir, `${LOG}/handoff.json`))).toMatchObject({ to: 'red-tests', finding: { from: 'Red tests' } });
    expect(subjects(f.dir)).toEqual([]);
  });

  test('the red gate accepts new tests that all fail, and does not count a skipped new test as passing', async () => {
    const f = fixture(redWith("test('fails now', () => assert.equal(1, 2));\\ntest.skip('skipped one', () => {});\\n"));
    const r = await pipeline(f);
    expect(r.stdout).not.toContain('RED GATE FAILED');
    expect(r.calls).toContain('implement');
  });

  test('the red gate does not flag a passing test that was already in the changed file at the base', async () => {
    const f = fixture(redWith("test('old passes', () => assert.equal(1, 1));\\ntest('new fails', () => assert.equal(1, 2));\\n"));
    fs.writeFileSync(path.join(f.dir, 'src/sum.test.mjs'), `${HEAD_T.replace(/\\n/g, '\n')}test('old passes', () => assert.equal(1, 1));\n`);
    git(f.dir, 'add', '-A');
    git(f.dir, 'commit', '-q', '-m', 'add an existing passing test');
    const r = await pipeline(f);
    expect(r.stdout).not.toContain('RED GATE FAILED');
    expect(r.calls).toContain('implement');
  });

  test('the red gate does not flag existing parameterised tests or titles with an escaped quote in the changed file; a new passing one is still flagged', async () => {
    const f = fixture({ 'red-tests': `git checkout -q -- src/sum.test.mjs\necho cases > "$FAKE_DOCS/test-cases-1.md"\nprintf "test('new fails', () => assert.equal(1, 2));\\ntest('new one passes', () => {});\\n" >> src/sum.test.mjs` });
    fs.writeFileSync(path.join(f.dir, 'src/sum.test.mjs'), [
      HEAD_T.replace(/\\n/g, '\n'),
      "const each = rows => (title, fn) => rows.forEach(r => test(title.replace('%s', r), fn));",
      "each(['no file', 'bad json'])('%s: the run stops and says why', () => {});",
      "for (const n of ['one', 'two']) test(`reviewer ${n} writes its own file`, () => {});",
      "test('the summariser\\'s file holds the union', () => {});",
      '',
    ].join('\n'));
    git(f.dir, 'add', '-A');
    git(f.dir, 'commit', '-q', '-m', 'add existing parameterised tests');
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RED GATE FAILED: 1 new test(s) already pass before implementation');
    expect(r.stdout).toContain('src/sum.test.mjs :: new one passes');
    for (const old of ['no file: the run stops', 'reviewer one writes', "summariser's file"]) expect(r.stdout).not.toContain(old);
  });

  test('the red gate flags a new passing test even when the base file mentions a word of its name', async () => {
    const f = fixture(redWith("const value = 1;\\ntest('old passes', () => assert.equal(1, 1));\\ntest('new thing takes the saved value', () => assert.equal(1, 1));\\ntest('new fails', () => assert.equal(1, 2));\\n"));
    fs.writeFileSync(path.join(f.dir, 'src/sum.test.mjs'), `${HEAD_T.replace(/\\n/g, '\n')}const value = 1;\ntest('old passes', () => assert.equal(1, 1));\n`);
    git(f.dir, 'add', '-A');
    git(f.dir, 'commit', '-q', '-m', 'add an existing test');
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('src/sum.test.mjs :: new thing takes the saved value');
    expect(r.stdout).not.toContain('src/sum.test.mjs :: old passes');
  });

  test('the red gate stops when the Red tests agent leaves no new or changed test file', async () => {
    const f = fixture({ 'red-tests': 'echo cases > "$FAKE_DOCS/test-cases-1.md"' });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('RED GATE FAILED: the Red tests agent added or changed no test file');
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests']);
    expect(subjects(f.dir)).toEqual([]);
  });

  test('a test changed during Implement stops the run (guard)', async () => {
    const r = await pipeline(fixture(), { FAKE_TOUCH_TEST: '1' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('GUARD FAILED: tests were modified during implementation\nsrc/sum.test.mjs\n');
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'implement']);
  });

  test('a failure that passes on the retry is reported as flaky and does not fail the gate', async () => {
    const f = fixture();
    const marker = path.join(f.fake, 'flaky-marker');
    const r = await pipeline(f, { FAKE_FLAKY: marker });
    expect([r.status, r.stderr]).toEqual([0, '']);
    // the red gate runs only the new tests, so the project's flaky test is met once, at the green gate (the implement agent re-arms it)
    expect(r.stdout.match(/WARNING: flaky test failed, then passed on retry; not counted as a failure: src\/flaky.test.mjs :: sometimes slow/g)).toHaveLength(1);
    expect(r.stdout).toContain(' tests and integration green');
    expect(read(f.dir, `${LOG}/flaky-tests.md`)).toContain('src/flaky.test.mjs :: sometimes slow :: first run: failed :: re-run: passed');
  });
});
