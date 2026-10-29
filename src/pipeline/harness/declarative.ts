import { which } from '../../shell.js';
import type {
  AgentHarnessPlugin,
  DeclarativeHarnessManifest,
  HarnessDetection,
  HarnessInvocation,
  HarnessModel,
  HarnessPluginMeta,
  HarnessResult,
  StageCompileOptions,
} from './types.js';

export class DeclarativeHarness implements AgentHarnessPlugin {
  readonly id: string;
  readonly name: string;
  readonly defaultBinary: string;
  readonly meta: HarnessPluginMeta;
  private readonly manifest: DeclarativeHarnessManifest;

  constructor(manifest: DeclarativeHarnessManifest) {
    this.manifest = manifest;
    this.id = manifest.id;
    this.name = manifest.name;
    this.defaultBinary = manifest.binary;
    this.meta = {
      version: '1.0.0',
      description: `Declarative manifest harness for ${manifest.name}`,
    };
  }

  async detect(env: NodeJS.ProcessEnv = process.env): Promise<HarnessDetection> {
    const bin = which(this.defaultBinary, { env });
    if (!bin) {
      return { installed: false, error: `${this.defaultBinary} not found on PATH` };
    }
    return { installed: true, path: bin };
  }

  async listModels(_env: NodeJS.ProcessEnv = process.env): Promise<HarnessModel[]> {
    if (Array.isArray(this.manifest.models)) {
      return this.manifest.models.map(m => ({
        id: m.id,
        name: m.name,
        harness: this.id,
        supportsEffort: Boolean(m.supportsEffort),
        defaultEffort: m.defaultEffort as HarnessModel['defaultEffort'],
      }));
    }
    return [];
  }

  compileStageArgs(opts: StageCompileOptions): HarnessInvocation {
    const args: string[] = [];
    const flags = this.manifest.flags;

    // Prompt flag or positional
    if (flags.prompt) {
      args.push(flags.prompt, opts.prompt);
    } else {
      args.push(opts.prompt);
    }

    if (opts.model && flags.modelFlag) {
      args.push(flags.modelFlag, opts.model);
    }

    if (opts.effort && flags.effortFlag) {
      args.push(flags.effortFlag, opts.effort);
    }

    if (opts.mode === 'acceptEdits' && flags.acceptEditsFlag) {
      args.push(...flags.acceptEditsFlag.split(' '));
    } else if (opts.mode === 'bypass' && flags.bypassPermissionsFlag) {
      args.push(...flags.bypassPermissionsFlag.split(' '));
    }

    if (flags.outputFormatFlag) {
      args.push(...flags.outputFormatFlag.split(' '));
    }

    return {
      command: this.defaultBinary,
      args,
      env: {},
    };
  }

  compileAuditArgs(opts: { prompt: string; model: string; effort?: string; cwd?: string }): HarnessInvocation {
    const args: string[] = [];
    const flags = this.manifest.flags;

    if (flags.prompt) {
      args.push(flags.prompt, opts.prompt);
    } else {
      args.push(opts.prompt);
    }

    if (opts.model && flags.modelFlag) {
      args.push(flags.modelFlag, opts.model);
    }
    if (opts.effort && flags.effortFlag) {
      args.push(flags.effortFlag, opts.effort);
    }
    if (flags.outputFormatFlag) {
      args.push(...flags.outputFormatFlag.split(' '));
    }

    return {
      command: this.defaultBinary,
      args,
      env: {},
    };
  }

  parseOutput(stdoutText: string, stderrText: string): HarnessResult {
    const denials: Array<{ tool: string; detail: string; rule: string }> = [];
    let text = stdoutText;
    const rateLimitedUntil: Date | null = null;
    let rawJson: Record<string, unknown> | undefined;

    const respKey = this.manifest.outputMapping?.responseField || 'result';

    try {
      rawJson = JSON.parse(stdoutText);
      if (rawJson && typeof rawJson[respKey] === 'string') {
        text = rawJson[respKey] as string;
      }
    } catch {
      // Raw text output fallback
    }

    return {
      text,
      exitCode: stderrText.length > 0 && !stdoutText ? 1 : 0,
      denials,
      rateLimitedUntil,
      rawJson,
    };
  }
}
