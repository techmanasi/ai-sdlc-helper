import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { doctor } from '../src/registry/doctor.js';
import { runAgent, runAudit } from '../src/pipeline/agent.js';
import { extract } from '../src/permissions/index.js';
import { Status } from '../src/pipeline/status.js';
import { Git } from '../src/pipeline/git.js';
import { Keys } from '../src/testcheck/keys.js';

describe('Codex Runner Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-codex-test-'));
  });

  describe('doctor with Codex', () => {
    it('verifies codex CLI when configured in agent.harness', () => {
      fs.writeFileSync(path.join(tmpDir, 'sdlc.config.json'), JSON.stringify({
        agent: { harness: 'codex' },
        suites: [{ dir: '.', runner: 'vitest', testCmd: 'vitest run' }],
      }));
      fs.mkdirSync(path.join(tmpDir, 'Docs', 'backlog'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'Docs', 'backlog', 'index.md'), '# Backlog\n');

      const mockWhich = (bin: string) => (bin === 'codex' ? '/usr/local/bin/codex' : null);
      const checks = doctor(tmpDir, { which: mockWhich as any });
      const codexCheck = checks.find(c => c.name === 'codex CLI');
      expect(codexCheck).toBeDefined();
      expect(codexCheck?.ok).toBe(true);
      expect(codexCheck?.detail).toBe('/usr/local/bin/codex');
    });

    it('reports failure when codex is missing on PATH and configured in agent.harness', () => {
      fs.writeFileSync(path.join(tmpDir, 'sdlc.config.json'), JSON.stringify({
        agent: { harness: 'codex' },
        suites: [{ dir: '.', runner: 'vitest', testCmd: 'vitest run' }],
      }));
      fs.mkdirSync(path.join(tmpDir, 'Docs', 'backlog'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'Docs', 'backlog', 'index.md'), '# Backlog\n');

      const mockWhich = (_bin: string) => null;
      const checks = doctor(tmpDir, { which: mockWhich as any });
      const codexCheck = checks.find(c => c.name === 'codex CLI');
      expect(codexCheck).toBeDefined();
      expect(codexCheck?.ok).toBe(false);
      expect(codexCheck?.fix).toContain('install OpenAI Codex CLI');
    });
  });

  describe('runAgent with Codex harness', () => {
    it('dispatches to codex CLI with exec and JSONL streaming flags', async () => {
      const docsDir = path.join(tmpDir, 'docs', 'test-task');
      const logDir = path.join(docsDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(docsDir, 'brief.md'), '# Task Brief');

      const capturedRequests: any[] = [];
      const mockSpawn = vi.fn(async (req) => {
        capturedRequests.push(req);
        // Write mock Codex JSONL output
        fs.writeFileSync(req.stdout, [
          JSON.stringify({ type: 'start' }),
          JSON.stringify({ type: 'message', content: 'Codex completed changes.' }),
        ].join('\n'));
        return 0;
      });

      const ctx: any = {
        root: tmpDir,
        config: {
          root: tmpDir,
          backlogDir: 'docs',
          suites: [{ name: 'unit', dir: '.', runner: 'vitest', testCmd: 'vitest run', runCmd: 'vitest run', testGlobs: [], sourceGlobs: [], setup: null, report: null, language: 'typescript', packageManager: 'npm' }],
          integration: null,
          tests: { retry: null, maxWorkers: null },
          lint: null,
          worktree: { base: '', link: [] },
          git: { branchPrefix: 'feat/', base: null, conflictSuffixStart: 1 },
          agent: { harness: 'codex', allowCommands: [], codeSearch: 'none', codeIndexer: null },
          finalise: { envExample: true, maxFileBytes: 1048576 },
          ship: { envExample: true, maxFileBytes: 1048576 },
          ui: { timezone: 'UTC' },
          node: { version: '22', current: '22', manager: null },
        },
        layout: { root: tmpDir, backlogDir: 'docs', testCmd: 'vitest run', testFiles: 'test/', testDirs: ['test'], sourceDirs: ['src'], link: [], retry: false, maxWorkers: null },
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
        git: new Git(tmpDir),
        keys: new Keys({ testDirs: ['test'], globs: [] } as any, tmpDir),
        status: new Status(path.join(logDir, 'status.json'), 'test-task'),
        spawnAgent: mockSpawn,
        promptsDir: path.resolve('assets/prompts'),
        guide: '',
        allowed: ['Bash(npm test:*)'],
        testFileCmd: 'npx vitest run',
        fetchCmd: 'fetch',
        permRepo: path.join(tmpDir, 'sdlc-rules.json'),
        redSha: '',
        lockSha: '',
        origRedSha: '',
        failLog: path.join(logDir, 'tests.log'),
        out: () => {},
        err: () => {},
      };

      await runAgent(ctx, 'implement', 'implement');

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const req = capturedRequests[0];
      expect(req.command).toBe('codex');
      expect(req.args[0]).toBe('exec');
      expect(req.args).toContain('-C');
      expect(req.args).toContain(tmpDir);
      expect(req.args).toContain('-m');
      // Default implement model mapped from sonnet -> o3-mini
      expect(req.args).toContain('o3-mini');
      expect(req.args).toContain('-s');
      expect(req.args).toContain('workspace-write');
      expect(req.args).toContain('--approve-for-me');
      expect(req.args).toContain('--json');
    });

    it('extracts denied permissions from Codex JSONL output', () => {
      const jsonFile = path.join(tmpDir, 'agent.json');
      const logFile = path.join(tmpDir, 'agent.log');
      const stateFile = path.join(tmpDir, 'permissions.json');

      const codexJsonl = [
        JSON.stringify({ type: 'message', content: 'Attempting to run unauthorized script...' }),
        JSON.stringify({ type: 'tool_denial', tool: 'Bash', command: 'rm -rf /unauthorized', rule: 'dangerous' }),
      ].join('\n');
      fs.writeFileSync(jsonFile, codexJsonl);

      const pendingCount = extract({
        jsonFile,
        logFile,
        stateFile,
        stage: 'implement',
        cwd: tmpDir,
        allowed: [],
      });

      expect(pendingCount).toBe(1);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.pending[0]).toMatchObject({
        stage: 'implement',
        tool: 'Bash',
        detail: 'rm -rf /unauthorized',
      });
    });

    it('runs test audit with codex read-only sandbox', async () => {
      const logDir = path.join(tmpDir, 'docs', 'test-task', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const capturedRequests: any[] = [];
      const mockSpawn = vi.fn(async (req) => {
        capturedRequests.push(req);
        fs.writeFileSync(req.stdout, JSON.stringify({ ok: true }));
        return 0;
      });

      const ctx: any = {
        root: tmpDir,
        log: 'docs/test-task/logs',
        config: {
          agent: { harness: 'codex' },
        },
        env: {},
        spawnAgent: mockSpawn,
      };

      await runAudit(ctx, 'audit prompt', { args: [], env: {} });
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const req = capturedRequests[0];
      expect(req.command).toBe('codex');
      expect(req.args[0]).toBe('exec');
      expect(req.args).toContain('-s');
      expect(req.args).toContain('read-only');
      expect(req.args).toContain('--json');
      expect(req.args).toContain('o3-mini');
    });
  });
});
