import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgyHarness,
  ClaudeHarness,
  CodexHarness,
  DeclarativeHarness,
  DefaultHarnessRegistry,
  type DeclarativeHarnessManifest,
} from '../src/pipeline/harness/index.js';

describe('Pluggable Agent Harness Subsystem', () => {
  describe('ClaudeHarness', () => {
    const harness = new ClaudeHarness();

    it('has expected metadata and models', async () => {
      expect(harness.id).toBe('claude');
      expect(harness.name).toBe('Anthropic Claude Code');
      const models = await harness.listModels();
      expect(models.length).toBeGreaterThanOrEqual(3);
      expect(models.map(m => m.id)).toContain('opus');
      expect(models.map(m => m.id)).toContain('sonnet');
    });

    it('compiles stage arguments with acceptEdits and allowedTools', () => {
      const inv = harness.compileStageArgs({
        prompt: 'test prompt',
        stage: 'implement',
        model: 'opus',
        effort: 'high',
        mode: 'acceptEdits',
        allowedCommands: ['npm test', 'git diff'],
        maxTurns: 30,
      });

      expect(inv.command).toBe('claude');
      expect(inv.args).toContain('-p');
      expect(inv.args).toContain('test prompt');
      expect(inv.args).toContain('--model');
      expect(inv.args).toContain('opus');
      expect(inv.args).toContain('--effort');
      expect(inv.args).toContain('high');
      expect(inv.args).toContain('--permission-mode');
      expect(inv.args).toContain('acceptEdits');
      expect(inv.args).toContain('--allowedTools');
      expect(inv.args).toContain('npm test');
      expect(inv.args).toContain('--output-format');
      expect(inv.args).toContain('json');
    });

    it('parses JSON output correctly', () => {
      const parsed = harness.parseOutput(JSON.stringify({ result: 'Implementation complete' }), '');
      expect(parsed.text).toBe('Implementation complete');
      expect(parsed.exitCode).toBe(0);
    });
  });

  describe('AgyHarness', () => {
    const harness = new AgyHarness();

    it('has expected metadata and Gemini models', async () => {
      expect(harness.id).toBe('agy');
      expect(harness.name).toBe('Google Antigravity CLI');
      const models = await harness.listModels();
      expect(models.map(m => m.id)).toContain('gemini-3.8-flash-high');
      expect(models.map(m => m.id)).toContain('gemini-3.8-pro');
    });

    it('compiles stage arguments with --mode accept-edits and --settings', () => {
      const inv = harness.compileStageArgs({
        prompt: 'build feature',
        stage: 'implement',
        model: 'gemini-3.8-flash-high',
        effort: 'high',
        mode: 'acceptEdits',
        allowedCommands: ['npm test'],
      });

      expect(inv.command).toBe('agy');
      expect(inv.args).toContain('-p');
      expect(inv.args).toContain('build feature');
      expect(inv.args).toContain('--mode');
      expect(inv.args).toContain('accept-edits');
      expect(inv.args).toContain('--settings');
      expect(inv.args).toContain(JSON.stringify({ permissions: { allow: ['command(npm test)'] } }));
    });

    it('parses agy JSON output and captures denied actions', () => {
      const mockOut = {
        response: 'Done planning',
        status: 'OK',
        denied_actions: [{ tool: 'command', detail: 'rm -rf /', rule: 'danger' }],
      };
      const parsed = harness.parseOutput(JSON.stringify(mockOut), '');
      expect(parsed.text).toBe('Done planning');
      expect(parsed.denials).toHaveLength(1);
      expect(parsed.denials[0].detail).toBe('rm -rf /');
    });
  });

  describe('CodexHarness', () => {
    const harness = new CodexHarness();

    it('has expected metadata and OpenAI models', async () => {
      expect(harness.id).toBe('codex');
      expect(harness.name).toBe('OpenAI Codex CLI');
      const models = await harness.listModels();
      expect(models.map(m => m.id)).toContain('o3-mini');
      expect(models.map(m => m.id)).toContain('o1');
    });

    it('compiles stage arguments with codex exec and sandboxing', () => {
      const inv = harness.compileStageArgs({
        prompt: 'refactor code',
        stage: 'implement',
        model: 'o3-mini',
        effort: 'high',
        mode: 'acceptEdits',
        allowedCommands: [],
        cwd: '/path/to/project',
      });

      expect(inv.command).toBe('codex');
      expect(inv.args[0]).toBe('exec');
      expect(inv.args).toContain('-C');
      expect(inv.args).toContain('/path/to/project');
      expect(inv.args).toContain('-m');
      expect(inv.args).toContain('o3-mini');
      expect(inv.args).toContain('-c');
      expect(inv.args).toContain('model_reasoning_effort="high"');
      expect(inv.args).toContain('-s');
      expect(inv.args).toContain('workspace-write');
      expect(inv.args).toContain('--approve-for-me');
      expect(inv.args).toContain('--json');
    });

    it('compiles audit arguments with read-only sandbox', () => {
      const inv = harness.compileAuditArgs({
        prompt: 'audit review',
        model: 'o1',
        cwd: '/path/to/project',
      });

      expect(inv.command).toBe('codex');
      expect(inv.args[0]).toBe('exec');
      expect(inv.args).toContain('-s');
      expect(inv.args).toContain('read-only');
      expect(inv.args).toContain('--json');
    });

    it('parses JSONL events and extracts text response', () => {
      const jsonl = [
        JSON.stringify({ type: 'start' }),
        JSON.stringify({ type: 'message', content: 'Codex completed the refactor successfully.' }),
      ].join('\n');

      const parsed = harness.parseOutput(jsonl, '');
      expect(parsed.text).toBe('Codex completed the refactor successfully.');
      expect(parsed.exitCode).toBe(0);
    });
  });

  describe('DeclarativeHarness (Third-Party Agent Plugins)', () => {
    const manifest: DeclarativeHarnessManifest = {
      schemaVersion: '1',
      id: 'aider',
      name: 'Aider AI Pair Programmer',
      binary: 'aider',
      detection: { versionArgs: ['--version'] },
      models: [
        { id: 'deepseek-coder', name: 'DeepSeek Coder', supportsEffort: false },
      ],
      flags: {
        prompt: '--message',
        modelFlag: '--model',
        acceptEditsFlag: '--yes --auto-commits',
        bypassPermissionsFlag: '--yes',
      },
      outputMapping: {
        responseField: 'response',
      },
    };

    const harness = new DeclarativeHarness(manifest);

    it('instantiates plugin from declarative manifest', async () => {
      expect(harness.id).toBe('aider');
      expect(harness.name).toBe('Aider AI Pair Programmer');
      const models = await harness.listModels();
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('deepseek-coder');
    });

    it('compiles stage arguments using manifest flags', () => {
      const inv = harness.compileStageArgs({
        prompt: 'write function',
        stage: 'implement',
        model: 'deepseek-coder',
        mode: 'acceptEdits',
        allowedCommands: [],
      });

      expect(inv.command).toBe('aider');
      expect(inv.args).toContain('--message');
      expect(inv.args).toContain('write function');
      expect(inv.args).toContain('--model');
      expect(inv.args).toContain('deepseek-coder');
      expect(inv.args).toContain('--yes');
      expect(inv.args).toContain('--auto-commits');
    });
  });

  describe('DefaultHarnessRegistry', () => {
    it('initializes with built-in harnesses: claude, agy, codex', () => {
      const registry = new DefaultHarnessRegistry();
      const list = registry.list();
      expect(list.map(h => h.id)).toEqual(['claude', 'agy', 'codex']);
      expect(registry.get('claude')).toBeDefined();
      expect(registry.get('agy')).toBeDefined();
      expect(registry.get('codex')).toBeDefined();
    });

    it('registers and unregisters custom plugins', () => {
      const registry = new DefaultHarnessRegistry();
      const customPlugin = new DeclarativeHarness({
        schemaVersion: '1',
        id: 'custom-cli',
        name: 'Custom Agent',
        binary: 'custom',
        models: [{ id: 'custom-m1', name: 'Custom M1' }],
        flags: { prompt: '-p' },
        outputMapping: {},
        detection: {},
      });

      registry.register(customPlugin);
      expect(registry.get('custom-cli')).toBeDefined();
      expect(registry.list().map(h => h.id)).toContain('custom-cli');

      expect(registry.unregister('custom-cli')).toBe(true);
      expect(registry.get('custom-cli')).toBeUndefined();
    });

    it('federates models across all registered harnesses', async () => {
      const registry = new DefaultHarnessRegistry();
      const allModels = await registry.listAllModels();
      const harnessesRepresented = new Set(allModels.map(m => m.harness));

      expect(harnessesRepresented.has('claude')).toBe(true);
      expect(harnessesRepresented.has('agy')).toBe(true);
      expect(harnessesRepresented.has('codex')).toBe(true);
    });

    it('loads declarative plugins dynamically from directory', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-plugins-'));
      try {
        const manifest: DeclarativeHarnessManifest = {
          schemaVersion: '1',
          id: 'devin',
          name: 'Devin CLI',
          binary: 'devin',
          models: [{ id: 'devin-v1', name: 'Devin Model' }],
          flags: { prompt: '--prompt' },
          outputMapping: {},
          detection: {},
        };
        fs.writeFileSync(path.join(tempDir, 'devin.json'), JSON.stringify(manifest), 'utf8');

        const registry = new DefaultHarnessRegistry(false);
        await registry.loadPluginsFromDir(tempDir);

        expect(registry.get('devin')).toBeDefined();
        expect(registry.get('devin')?.name).toBe('Devin CLI');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
