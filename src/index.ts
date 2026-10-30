// ai-sdlc-helper as a library: project settings, detection, test framework setup and code search.
export { CONFIG_FILE } from './util.js';
export { RUNNERS, detect, detectPackage, literalList, packageGlobs, type Detection, type Runner } from './config/detect.js';
export { globToRegex, expandGlob } from './config/globs.js';
export { projectNode, satisfiesMajor, nodeRun, wrapCommand, type NodeRun, type ProjectNode } from './config/node.js';
export { CODE_INDEXERS, codeIndexers, codeSearchErrors, codeSearchFor, codeSearchGuide, type CodeIndexer } from './config/codeSearch.js';
export {
  resolve, validate, testDir, testSpec, testFiles, agentRules, allowedTools, testFramework, keyDir, layout, worktreeBase,
  type Config, type Suite, type Layout,
} from './config/settings.js';
export { suggest, setupPlan, provision, locateTestDir, packagesBelow, describeProject, rankRunners } from './config/suggest.js';
export { renderSkill, renderTemplate, skillNames } from './config/skills.js';
export { argsProblem } from './cli/args.js';
export { currentState, skipReason, snapshot, changed, mirror, mark, parseKeys, worktreeChanges, type Changed } from './changes/index.js';
export { extract, rulesFor, modeFor, decide, ruleFor, detailFor, isProtected, loadState, repoRulesFile, type Ask } from './permissions/index.js';
export { resolvePath as modelsFile, loadRegistry, validateProvider, validateRegistry, probe, modelsMain, type Registry } from './models/index.js';
export {
  addBacklogItem, backlogItems, backlogMain, backlogPlace, parseIndex, parseTitle, type BacklogItem, type NewItem,
} from './backlog/index.js';
export { main, type Io } from './cli/main.js';
export { configDir } from './configDir.js';
export {
  readRegistry, writeRegistry, registryFile, projectDir, gitRoot, RegistryError, type ProjectEntry, type ProjectOverrides,
} from './registry/projects.js';
export { doctor, type Check, type DoctorOptions, type Spawn } from './registry/doctor.js';
export { ADAPTERS, runSuite, runSuites, mergeResults, summary, type RunOptions } from './runners/run.js';
export type { RunResult, TestCase, SuiteError } from './runners/types.js';
export { parseJestLike } from './runners/jest.js';
export { parseMocha } from './runners/mocha.js';
export { parseNodeTest } from './runners/nodeTest.js';
export { parseJUnit } from './runners/junit.js';
export { Keys, testLayout, layoutFromEnv, type TestLayout } from './testcheck/keys.js';
export * as testcheck from './testcheck/checks.js';
export {
  runContext, start, stop, restart, discard, statusLines, statusRecords, watchFrame, runChanges, allChanges, runWorktree, pickBase,
  pipelineArgv, pipelineEnv, type RunContext, type Outcome,
} from './runs/index.js';
export { alive, killTree, readRecord, recordedSlugs, registryDir, runState, type RunRecord } from './runs/records.js';
export {
  answerQuestions, boardView, parseQuestions, resumeStage, runView, type BoardView, type Question, type RunCard, type RunView,
  type TestCounts, type ViewState,
} from './runs/view.js';
export { runPipeline, firstPending, type PipelineOptions } from './pipeline/run.js';
export { spawnClaude, type AgentSpawn, type AgentRequest } from './pipeline/agent.js';
export { ship, type ShipOptions } from './pipeline/ship.js';
export { STAGE_DEFAULTS, resolveProvider, stageModel, providerEnv, type Provider } from './pipeline/models.js';
export { FROM_STAGES, AGENT_STAGES, type From, type AgentStage } from './pipeline/context.js';
export type { StatusLine } from './pipeline/status.js';
export {
  triage, triagePrompt, indexItems, commitTriage, triageTools, TRIAGE_DIR, newRunId, triageRunDir, createTriageWorktree, removeTriageWorktree,
  triageSplitPrompt, triageItemPrompt, triageAnsweredMessage, triageContinueMessage, parseTriageItems, buildTriageDraft,
  pendingTriageQuestions, answerTriageQuestions, parseStreamLine,
  type RunClaude, type TriageResult, type TriageItem, type TriageDraft, type TriageQuestion, type TriageState, type DraftStatus, type TriageStreamPart,
} from './triage.js';
export * from './pipeline/harness/index.js';
