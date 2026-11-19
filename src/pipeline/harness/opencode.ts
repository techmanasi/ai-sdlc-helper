import { EFFORT_LEVELS } from '../../config/settings.js';
import { which } from '../../shell.js';
import { defaultOpencodeCatalog, OpencodeModelCatalogAdapter, opencodeModelsFromPayload, queryOpencodeApi } from './opencode/catalog.js';
import type { AgentHarness, HarnessDetection, HarnessInvocation, HarnessModel, HarnessResult, StageCompileOptions } from './types.js';

export { defaultOpencodeCatalog, OpencodeModelCatalogAdapter, opencodeModelsFromPayload, queryOpencodeApi };

export class OpencodeHarness implements AgentHarness {
  readonly id = 'opencode' as const;
  readonly name = 'OpenCode';
  readonly defaultBinary = 'opencode';
  readonly catalog: OpencodeModelCatalogAdapter;
  /** OpenCode ids go to the CLI as they are: no provider indirection. */
  readonly ownsModelIds = true;
  /** One model is often offered by several providers ("opencode", "opencode-go", "openrouter"): pickers filter by one. */
  readonly multipleProvider = true;

  /**
   * OpenCode ids are "<provider>/<model>", and its providers include ids of their own ("opencode-go"), so its ids are
   * claimed by prefix as well as once the catalog has discovered them. Only a routed id is ours: a display name like
   * "gpt-6.1-sol" is another harness's model too (codex lists it), and claiming it would name every such stage a
   * mismatch.
   */
  ownsModel(model: string): boolean {
    return model.startsWith(`${this.id}/`) || model.startsWith(`${this.id}-`) || this.catalog?.modelById(model) !== undefined;
  }

  constructor(catalog: OpencodeModelCatalogAdapter = defaultOpencodeCatalog) {
    this.catalog = catalog;
  }

  selectStageModel(opts: { configuredModel?: string; configuredEffort?: string }): { model: string; effort?: string } {
    // The config names a model by its display name (the provider's own id); the CLI is routed by the catalog's id.
    const configured = opts.configuredModel || '';
    const found = configured ? this.catalog.getCachedModel(configured) : undefined;
    const model = found?.id || configured;
    return { model, effort: found?.supportsEffort === false ? undefined : opts.configuredEffort };
  }

  async detect(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetection> {
    const bin = which(this.defaultBinary, { env });
    if (!bin) {
      return { installed: false, error: 'opencode binary not found on PATH' };
    }
    const models = await this.listModels(env);
    return {
      installed: true,
      path: bin,
      models: { reachable: this.catalog.lastError === null, count: models.length },
      ...(this.catalog.lastError ? { error: this.catalog.lastError } : {}),
    };
  }

  async listModels(env: NodeJS.ProcessEnv = process.env): Promise<HarnessModel[]> {
    return this.catalog.listModels(env);
  }

  private modelWithEffort(model?: string, effort?: string): string | undefined {
    if (!model) return undefined;
    if (!effort) return model;
    const discovered = this.catalog.getCachedModel(model);
    if (discovered?.supportedEfforts && !discovered.supportedEfforts.includes(effort)) return model;
    if (discovered?.supportsEffort === false) return model;
    if (!discovered && !(EFFORT_LEVELS as readonly string[]).includes(effort)) return model;
    return `${model}#${effort}`;
  }

  compileStageArgs(opts: StageCompileOptions): HarnessInvocation {
    const args: string[] = ['run'];
    const model = this.modelWithEffort(opts.model, opts.effort);
    if (model) args.push('--model', model);
    args.push('--format', 'json');
    // OpenCode uses --auto for both acceptEdits and bypass permission modes.
    args.push('--auto');
    args.push(opts.prompt);
    return { command: this.defaultBinary, args, env: {} };
  }

  compileAuditArgs(opts: { prompt: string; model?: string; effort?: string; cwd?: string }): HarnessInvocation {
    const args: string[] = ['run'];
    const model = this.modelWithEffort(opts.model, opts.effort);
    if (model) args.push('--model', model);
    args.push('--format', 'json', opts.prompt);
    return { command: this.defaultBinary, args, env: {} };
  }

  parseOutput(stdoutText: string, stderrText: string): HarnessResult {
    // Follow-up: parse OpenCode's JSON event stream, including denials and rate limits.
    return {
      text: stdoutText,
      exitCode: stderrText.length > 0 && !stdoutText ? 1 : 0,
      denials: [],
      rateLimitedUntil: null,
    };
  }
}
