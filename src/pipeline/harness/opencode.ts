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

  constructor(catalog: OpencodeModelCatalogAdapter = defaultOpencodeCatalog) {
    this.catalog = catalog;
  }

  selectStageModel(opts: { configuredModel?: string; configuredEffort?: string }): { model: string; effort?: string } {
    return { model: opts.configuredModel || '', effort: opts.configuredEffort };
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
    if (!effort || !(EFFORT_LEVELS as readonly string[]).includes(effort)) return model;
    // Discovery is asynchronous while compilation is synchronous. Once discovered, never
    // send a variant to a model without one; otherwise trust a valid configured effort.
    if (this.catalog.getCachedModel(model)?.supportsEffort === false) return model;
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
