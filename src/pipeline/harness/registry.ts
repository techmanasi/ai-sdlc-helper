import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgyHarness } from './agy.js';
import { ClaudeHarness } from './claude.js';
import { CodexHarness } from './codex.js';
import { DeclarativeHarness } from './declarative.js';
import type {
  AgentHarness,
  AgentHarnessPlugin,
  DeclarativeHarnessManifest,
  HarnessDetection,
  HarnessId,
  HarnessModel,
  HarnessRegistry,
} from './types.js';

export class DefaultHarnessRegistry implements HarnessRegistry {
  private readonly harnesses = new Map<string, AgentHarness | AgentHarnessPlugin>();

  constructor(registerDefaults = true) {
    if (registerDefaults) {
      this.register(new ClaudeHarness());
      this.register(new AgyHarness());
      this.register(new CodexHarness());
    }
  }

  register(plugin: AgentHarness | AgentHarnessPlugin): void {
    this.harnesses.set(plugin.id, plugin);
  }

  unregister(id: HarnessId): boolean {
    return this.harnesses.delete(id);
  }

  get(id: HarnessId): (AgentHarness | AgentHarnessPlugin) | undefined {
    return this.harnesses.get(id);
  }

  list(): Array<AgentHarness | AgentHarnessPlugin> {
    return Array.from(this.harnesses.values());
  }

  async detectAll(env: NodeJS.ProcessEnv = process.env): Promise<Array<{ harness: AgentHarness; detection: HarnessDetection }>> {
    const results: Array<{ harness: AgentHarness; detection: HarnessDetection }> = [];
    for (const harness of this.harnesses.values()) {
      try {
        const detection = await harness.detect(env);
        results.push({ harness, detection });
      } catch (e) {
        results.push({
          harness,
          detection: {
            installed: false,
            error: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
    return results;
  }

  async listAllModels(env: NodeJS.ProcessEnv = process.env): Promise<HarnessModel[]> {
    const allModels: HarnessModel[] = [];
    for (const harness of this.harnesses.values()) {
      try {
        const models = await harness.listModels(env);
        allModels.push(...models);
      } catch {
        // Skip failed model discovery for inactive harness
      }
    }
    return allModels;
  }

  async loadPluginsFromDir(dir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const manifest = JSON.parse(raw) as DeclarativeHarnessManifest;
          if (manifest.id && manifest.binary) {
            this.register(new DeclarativeHarness(manifest));
          }
        } catch {
          // Ignore invalid manifest
        }
      } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
        try {
          const moduleUrl = pathToFileURL(fullPath).href;
          const mod = await import(moduleUrl);
          const plugin = mod.default || mod.plugin;
          if (plugin && plugin.id && typeof plugin.compileStageArgs === 'function') {
            if (typeof plugin.initialize === 'function') {
              await plugin.initialize({ configDir: dir, env });
            }
            this.register(plugin);
          }
        } catch {
          // Ignore failed dynamic import
        }
      }
    }
  }
}

/** Global default registry instance singleton */
export const defaultRegistry = new DefaultHarnessRegistry();
