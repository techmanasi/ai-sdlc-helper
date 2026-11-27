import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { layout, resolve } from '../../src/config/settings.js';
import { runAgent } from '../../src/pipeline/agent.js';
import type { Ctx } from '../../src/pipeline/context.js';
import { Git } from '../../src/pipeline/git.js';
import { reviewLoop } from '../../src/pipeline/review-gate.js';
import { runSuites, type RunAll } from '../../src/runners/run.js';
import type { RunResult, TestStatus } from '../../src/runners/types.js';
import { DOCS, LOG, SLUG, fixture } from '../pipeline-fixture.js';

vi.mock('../../src/pipeline/agent.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/pipeline/agent.js')>(), runAgent: vi.fn(),
}));
vi.mock('../../src/pipeline/stages.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/pipeline/stages.js')>(),
  implementStage: vi.fn(async () => { throw new Error('Implement started without named evidence'); }),
}));
vi.mock('../../src/runners/run.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/runners/run.js')>(), runSuites: vi.fn(),
}));

const file = 'src/coverage.test.mjs';
const title = 'sum adds';
function result(status?: TestStatus): RunAll {
  const merged: RunResult = {
    runner: 'node-test', suite: 'app', command: 'node --test', ok: status === 'passed', exitCode: status === 'passed' ? 0 : 1,
    tests: status ? [{ file, name: title, status, message: null }] : [], suiteErrors: [],
  };
  return { results: [merged], merged };
}

describe('Review gate runner failures', () => {
  it.each(['launch error', 'empty report', 'missing report', 'no baseline', 'ambiguous baseline', 'unreadable prior inventory'])(
    'rejects %s at Red tests and releases detached worktrees', async failure => {
      const { dir } = fixture();
      const git = new Git(dir);
      const config = resolve(dir, { env: {} }).config!;
      const log = path.join(dir, LOG);
      fs.mkdirSync(log, { recursive: true });
      fs.writeFileSync(path.join(dir, DOCS, 'plan-1.md'), 'fixture');
      if (failure === 'unreadable prior inventory') fs.writeFileSync(path.join(dir, file), "import './old-case.mjs';\n");
      git.run('add', '-A');
      git.run('commit', '-qm', `[red-tests] test(${SLUG}): add failing tests`);
      const original = git.head();
      const ctx = {
        root: dir, log: LOG, docs: DOCS, slug: SLUG, from: 'review', config, layout: layout(config), env: {},
        git, origRedSha: original, redSha: original, out: vi.fn(), err: vi.fn(), status: { write: vi.fn() },
      } as unknown as Ctx;
      vi.mocked(runAgent).mockImplementation(async (_ctx, _name, stage) => {
        if (stage === 'review') {
          fs.writeFileSync(path.join(dir, DOCS, 'review.json'), JSON.stringify({
            verdict: 'changes', blockers: [], missingTests: [{ file: 'sum.mjs', criterion: 'adds', reason: 'cover addition' }],
          }));
        } else if (stage === 'red-tests') {
          fs.writeFileSync(path.join(dir, file), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('sum adds', async () => assert.equal((await import('./sum.mjs')).sum(2, 3), 5));\n");
          fs.writeFileSync(path.join(log, 'tests.json'), JSON.stringify(result('failed').merged));
        } else {
          throw new Error(`unexpected agent ${stage}`);
        }
      });
      vi.mocked(runSuites).mockReset().mockImplementation((_config, opts) => {
        if (failure === 'launch error') return { error: 'runner failed to launch' };
        if (failure === 'empty report') return result();
        if (failure === 'missing report') {
          const missing = result();
          missing.merged.noReport = true;
          missing.merged.suiteErrors = [{ file, message: 'runner did not write a report' }];
          return missing;
        }
        if (opts.root === dir) return result('passed');
        if (failure === 'unreadable prior inventory') return { error: 'runner failed to inventory old cases' };
        const baseline = result('failed');
        baseline.merged.tests.push({ ...baseline.merged.tests[0] });
        return baseline;
      });
      if (failure === 'no baseline') {
        const run = git.run.bind(git);
        vi.spyOn(git, 'run').mockImplementation((...args) => {
          if (args[0] === 'worktree' && args[1] === 'add') throw new Error('baseline unavailable');
          return run(...args);
        });
      }
      const worktrees = () => git.lines('worktree', 'list', '--porcelain').filter(line => line.startsWith('worktree '));
      const before = worktrees();
      const stop = await reviewLoop(ctx).catch((error: unknown) => error);
      expect(runSuites).toHaveBeenCalled();
      expect(worktrees()).toEqual(before);
      expect(stop).toMatchObject({
        code: 1, resumeFrom: 'red-tests', reason: expect.stringMatching(/RED GATE FAILED/i),
      });
      expect(git.head()).toBe(original);
      expect(ctx.out).not.toHaveBeenCalledWith(expect.stringContaining('Implement skipped:'));
    },
  );
});
