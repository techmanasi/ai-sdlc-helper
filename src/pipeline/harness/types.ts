/**
 * Pluggable Agent Harness types for multi-agent CLI execution.
 * Decouples the pipeline engine from proprietary coding agent CLIs (Claude Code, Google Antigravity, OpenAI Codex, etc.)
 * and provides an open plugin extension architecture for adding any third-party or internal coding agent.
 */

export type BuiltinHarnessId = 'claude' | 'agy' | 'codex';
export type HarnessId = BuiltinHarnessId | (string & {});

export type StageName = 'spec' | 'plan' | 'red-tests' | 'implement' | 'test-repair' | 'test-audit' | 'review';

export interface HarnessModel {
  /** Unique model identifier within the harness, e.g. "gemini-3.8-flash-high", "o3-mini", or "opus" */
  id: string;
  /** Human-readable display label, e.g. "Gemini 3.8 Flash (High)", "OpenAI o3-mini", "Claude Opus 4.6" */
  name: string;
  /** Owning harness identifier */
  harness: HarnessId;
  /** Whether reasoning effort can be configured for this model */
  supportsEffort: boolean;
  /** Default reasoning effort, if supported */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Optional context window limit or description */
  description?: string;
}

export interface HarnessDetection {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface PermissionRule {
  type: 'command' | 'file_read' | 'file_write';
  pattern: string;
}

export interface StageCompileOptions {
  prompt: string;
  stage: StageName;
  model: string;
  effort?: string;
  mode: 'acceptEdits' | 'bypass' | 'bypassPermissions';
  allowedCommands: string[];
  maxTurns?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface HarnessInvocation {
  /** CLI binary name or absolute path (e.g. "claude", "agy", "codex", or a custom binary) */
  command: string;
  /** Process arguments */
  args: string[];
  /** Environment variables to merge into process execution */
  env: Record<string, string>;
  /** Optional temporary settings/configuration file created for this session */
  tempSettingsFile?: string;
}

export interface HarnessResult {
  /** Extracted primary text response from the agent */
  text: string;
  /** Process exit code */
  exitCode: number;
  /** Intercepted tool actions that were denied and require developer decision */
  denials: Array<{ tool: string; detail: string; rule: string }>;
  /** Reset timestamp if the agent hit an account rate/usage limit */
  rateLimitedUntil?: Date | null;
  /** Optional token usage details */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    totalTokens?: number;
  };
  /** Complete raw parsed JSON payload, if available */
  rawJson?: Record<string, unknown>;
}

/** Core contract every coding agent harness must implement. */
export interface AgentHarness {
  readonly id: HarnessId;
  readonly name: string;
  readonly defaultBinary: string;

  /** Probe local environment for CLI binary availability and version */
  detect(env?: NodeJS.ProcessEnv): Promise<HarnessDetection>;

  /** Query or return models supported by this harness */
  listModels(env?: NodeJS.ProcessEnv): Promise<HarnessModel[]>;

  /** Compile arguments, mode flags, and dynamic permissions for a stage run */
  compileStageArgs(opts: StageCompileOptions): HarnessInvocation;

  /** Compile arguments for read-only audit stages */
  compileAuditArgs(opts: { prompt: string; model: string; effort?: string; cwd?: string }): HarnessInvocation;

  /** Parse JSON/text stdout and stderr into a normalized result */
  parseOutput(stdoutText: string, stderrText: string, cwd?: string): HarnessResult;
}

/** Metadata for pluggable external harnesses loaded as extensions. */
export interface HarnessPluginMeta {
  version: string;
  author?: string;
  homepage?: string;
  description?: string;
  /** Declarative config schema or options required by this plugin */
  optionsSchema?: Record<string, unknown>;
}

/** A pluggable agent harness packaged as an extension module. */
export interface AgentHarnessPlugin extends AgentHarness {
  readonly meta: HarnessPluginMeta;
  /** Optional initialization hook called when plugin is loaded into the registry */
  initialize?(context: { configDir: string; env: NodeJS.ProcessEnv }): Promise<void> | void;
}

/** Declarative JSON manifest schema for zero-code CLI wrapper plugins. */
export interface DeclarativeHarnessManifest {
  schemaVersion: '1';
  id: string;
  name: string;
  binary: string;
  detection: {
    versionArgs?: string[];
    versionRegex?: string;
  };
  models: Array<{
    id: string;
    name: string;
    supportsEffort?: boolean;
    defaultEffort?: string;
  }> | {
    command: string;
    jsonKey?: string;
  };
  flags: {
    prompt: string; // e.g. "-p" or "--message"
    modelFlag?: string; // e.g. "--model" or "-m"
    effortFlag?: string; // e.g. "--effort"
    acceptEditsFlag?: string; // e.g. "--mode accept-edits" or "-s workspace-write --approve-for-me"
    bypassPermissionsFlag?: string; // e.g. "--dangerously-skip-permissions"
    outputFormat?: 'json' | 'jsonl' | 'file';
    outputFormatFlag?: string; // e.g. "--output-format json"
    outputFileFlag?: string; // e.g. "-o"
  };
  outputMapping: {
    responseField?: string; // e.g. "result" or "response"
    statusField?: string;
    deniedActionsField?: string;
  };
}

/** Registry interface managing both built-in harnesses and dynamic plugins. */
export interface HarnessRegistry {
  register(plugin: AgentHarness | AgentHarnessPlugin): void;
  unregister(id: HarnessId): boolean;
  get(id: HarnessId): (AgentHarness | AgentHarnessPlugin) | undefined;
  list(): Array<AgentHarness | AgentHarnessPlugin>;
  detectAll(env?: NodeJS.ProcessEnv): Promise<Array<{ harness: AgentHarness; detection: HarnessDetection }>>;
  listAllModels(env?: NodeJS.ProcessEnv): Promise<HarnessModel[]>;
  loadPluginsFromDir(dir: string, env?: NodeJS.ProcessEnv): Promise<void>;
}
