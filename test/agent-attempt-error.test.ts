// A failed agent is recorded once: the run output prints the failure and the round row keeps a short excerpt of it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { runAgent } from '../src/pipeline/agent.js';
import { Exit } from '../src/pipeline/context.js';
import { readRounds } from '../src/pipeline/observe.js';
import { Status } from '../src/pipeline/status.js';
import { Git } from '../src/pipeline/git.js';
import { Keys } from '../src/testcheck/keys.js';

test('a failed round records the failure excerpt and its log path, and still stops the run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attempt-error-'));
  try {
    const docsDir = path.join(root, 'docs', 'test-task');
    const logDir = path.join(docsDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'brief.md'), '# Task Brief');
    fs.writeFileSync(path.join(logDir, 'impl-1.err'), 'Error: lint failed\n  at src/gates.ts:12\n');
    fs.writeFileSync(path.join(logDir, 'impl-1.log'), 'the whole agent log');
    const said: string[] = [];
    const spawnAgent = vi.fn(async (req: { stdout: string }) => {
      fs.writeFileSync(req.stdout, JSON.stringify({ type: 'turn.completed' }));
      return 1;
    });
    const ctx: any = {
      root,
      config: {
        root,
        backlogDir: 'docs',
        suites: [{ name: 'unit', dir: '.', runner: 'vitest', testCmd: 'vitest run', runCmd: 'vitest run', testGlobs: [], sourceGlobs: [], setup: null, report: null, language: 'typescript', packageManager: 'npm' }],
        integration: null,
        tests: { retry: null, maxWorkers: null },
        lint: null,
        worktree: { base: '', link: [] },
        git: { branchPrefix: 'feat/', base: null, conflictSuffixStart: 1 },
        agent: { harness: 'codex', allowCommands: [], codeSearch: 'none', codeIndexer: null },
        finalise: { envExample: true, maxFileBytes: 1048576 },
        ui: { timezone: 'UTC' },
        node: { version: '22', current: '22', manager: null },
      },
      layout: { root, backlogDir: 'docs', testCmd: 'vitest run', testFiles: 'test/', testDirs: ['test'], sourceDirs: ['src'], link: [], retry: false, maxWorkers: null },
      slug: 'test-task',
      from: 'implement',
      fromN: 4,
      docs: 'docs/test-task',
      log: 'docs/test-task/logs',
      backlog: 'docs/index.md',
      branch: 'feat/test-task',
      env: {},
      envModels: {},
      registryFile: '',
      limits: { maxAttempts: 1, maxTurns: 25, maxRepairTests: 1 },
      git: new Git(root),
      keys: new Keys({ testDirs: ['test'], globs: [] } as any, root),
      status: new Status(path.join(logDir, 'status.json'), 'test-task'),
      spawnAgent,
      promptsDir: path.resolve('assets/prompts'),
      guide: '',
      allowed: [],
      testFileCmd: 'npx vitest run',
      fetchCmd: 'fetch',
      permRepo: path.join(root, 'sdlc-rules.json'),
      redSha: '',
      lockSha: '',
      origRedSha: '',
      failLog: path.join(logDir, 'tests.log'),
      out: (l: string) => { said.push(l); },
      err: () => {},
    };

    const stopped = await runAgent(ctx, 'impl-1', 'implement').catch(e => e);
    expect(stopped).toBeInstanceOf(Exit);
    expect(stopped.cause).toBe('error');
    expect(stopped.reason).toContain("agent 'impl-1' failed");

    const rounds = readRounds(logDir);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ kind: 'agent', stage: 'implement', agent: 'impl-1', exitCode: 1, log: 'impl-1.log' });
    expect(rounds[0].error).toContain('Error: lint failed');
    expect(rounds[0].error).toContain('at src/gates.ts:12');
    expect(rounds[0].error!.length).toBeLessThanOrEqual(1500);
    // The same failure is still printed to the run output and stops the run.
    expect(said.join('\n')).toContain('failure (exit 1): Error: lint failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
