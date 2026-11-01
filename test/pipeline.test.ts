import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { READ_ONLY_COMMANDS, READ_ONLY_EXACT } from '../src/config/settings.js';
import {
  DOCS, LOG, NODE_TEST, SLUG, filesIn, fixture, git, pipeline, read, statusOf, subjects,
} from './pipeline-fixture.js';

// The runs are long chains of synchronous git and test runs: yield between tests so the runner's messages get through.
afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
// A run takes seconds, and many more on a loaded machine.
vi.setConfig({ testTimeout: 300_000 });

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/;

describe('a full run', () => {
  test('Spec to Ship: the settings\' branch, commits, red results, prompts, tools and status', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.dir, DOCS, 'manual-inputs.md'), '## plan\nUse a queue.\n\n## implement\nKeep it small.\n');
    const r = await pipeline(f);
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain(`SDLC: ${SLUG} on branch feature/${SLUG}\n`);
    expect(r.stdout).toContain('\n== 1/6 Spec\n   -> agent: spec-1\n   model=opus effort=medium\n');
    expect(r.stdout).toContain(`DONE: ${SLUG} on feature/${SLUG}. Committed 2 file(s), skipped 0 (see ${LOG}/finalise-skipped.md).`);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests', 'implement', 'review']);
    expect(git(f.dir, 'branch', '--show-current')).toBe(`feature/${SLUG}`);
    expect(subjects(f.dir)).toEqual([
      `chore(backlog): mark ${SLUG} done`, `feat(${SLUG}): implement per ${DOCS}/specs-1.md`, `test(${SLUG}): add failing tests and spec/plan docs`,
    ]);
    // the red-tests commit holds the docs and the new test; the implementation comes after
    expect(filesIn(f.dir, 'HEAD~2')).toEqual(['src/sum.test.mjs', `${DOCS}/manual-inputs.md`, `${DOCS}/plan-1.md`, `${DOCS}/specs-1.md`, `${DOCS}/test-cases-1.md`]);
    expect(filesIn(f.dir, 'HEAD~1')).toEqual(['src/sum.mjs', `${DOCS}/review-1.md`]);
    expect(read(f.dir, 'work/items/index.md')).toContain(`- [x] \`${SLUG}\``);
    expect(read(f.dir, `${LOG}/finalise-skipped.md`)).toBe('');

    // the tests at the red commit: the new file failed to load, the old tests passed
    const red = JSON.parse(read(f.dir, `${LOG}/red.json`));
    expect(red.runner).toBe('node-test');
    expect(red.tests.map(t => [t.file, t.status])).toEqual([['src/existing.test.mjs', 'passed'], ['src/flaky.test.mjs', 'passed']]);
    expect(red.suiteErrors.map(e => e.file)).toEqual(['src/sum.test.mjs']);
    expect(read(f.dir, `${LOG}/tests.log`)).toMatch(/^app \(node-test\): 3 passed, 0 failed/);

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
    expect(Object.keys(st)).toEqual(['slug', 'state', 'stage', 'agent', 'model', 'effort', 'models', 'attempt', 'agent_started', 'run_started', 'updated', 'pid', 'note']);
    expect(st).toMatchObject({ slug: SLUG, state: 'done', stage: 'Finalise', agent: '', model: '', effort: '', attempt: '', pid: process.pid });
    expect(st.models).toEqual({
      spec: { model: 'opus', effort: 'medium' }, plan: { model: 'opus', effort: 'medium' }, 'red-tests': { model: 'sonnet', effort: 'medium' },
      implement: { model: 'sonnet', effort: 'medium' }, 'test-repair': { model: 'sonnet', effort: 'medium' },
      'test-audit': { model: 'opus', effort: 'medium' }, review: { model: 'opus', effort: 'medium' },
    });
    for (const k of ['agent_started', 'run_started', 'updated']) expect(st[k]).toMatch(STAMP);
    const stageFiles = JSON.parse(read(f.dir, `${LOG}/stage-files.json`)).stages;
    expect(stageFiles.Implement).toEqual(['src/sum.mjs']);
    expect(stageFiles['Red tests']).toContain('src/sum.test.mjs');

    // Plan and Red tests refuse to run again once the red-tests commit exists
    const again = await pipeline(f, { FROM: 'plan' });
    expect(again.status).toBe(1);
    expect(again.stdout).toMatch(new RegExp(`FROM=plan but the red-tests commit [0-9a-f]{7} already exists: use FROM=implement`));
    expect(again.calls).toEqual([]);
    // the refused resume is no stage: the run keeps the one it ended at, so the board does not fall back to Spec
    expect(statusOf(f.dir)).toMatchObject({ state: 'failed', stage: 'Finalise' });
  });

  test('the red gate fails when the new tests pass before implementation', async () => {
    const f = fixture({ 'red-tests': `echo cases > "$FAKE_DOCS/test-cases-1.md"\nprintf "import { test } from 'node:test';\\ntest('trivially true', () => {});\\n" > src/sum.test.mjs` });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`RED GATE FAILED: new tests pass before implementation. See ${LOG}/tests.log`);
    expect(subjects(f.dir)).toEqual([]);
    expect(r.calls).toEqual(['spec', 'plan', 'red-tests']);
    expect(statusOf(f.dir)).toMatchObject({ state: 'failed', stage: 'Red tests' });
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
    // once at the red gate, once at the green gate (the implement agent re-arms it)
    expect(r.stdout.match(/WARNING: flaky test failed, then passed on retry; not counted as a failure: src\/flaky.test.mjs :: sometimes slow/g)).toHaveLength(2);
    expect(r.stdout).toContain(' tests and integration green');
    expect(read(f.dir, `${LOG}/flaky-tests.md`)).toContain('src/flaky.test.mjs :: sometimes slow :: first run: failed :: re-run: passed');
  });
});
