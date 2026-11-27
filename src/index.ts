// ai-sdlc-helper as a library: project settings, detection, test framework setup and code search.
export { CONFIG_FILE } from './util.js';
export { parseReviewLimit, REVIEW_LIMIT_ENV, REVIEW_LIMIT_REQUIREMENT } from './config/review-limit.js';
export { RUNNERS, detect, detectPackage, literalList, packageGlobs, type Detection, type Runner } from './config/detect.js';
export { globToRegex, expandGlob } from './config/globs.js';
export { projectNode, satisfiesMajor, nodeRun, wrapCommand, type NodeRun, type ProjectNode } from './config/node.js';
export {
  CODE_INDEXERS, codeIndexers, codeSearchErrors, codeSearchFor, codeSearchGuide, inspectCodeSearch, executableBuild,
  type CodeIndexer, type CodeIndexerStatus, type CodeSearchInspection, type ExecutableBuild,
} from './config/codeSearch.js';
export {
  EFFORT_LEVELS, HARNESS_IDS, agentFor, harnessFor, resolve, validate, fileErrors, testDir, testSpec, testFiles, agentRules, allowedTools, testFramework, keyDir, layout, worktreeBase,
  type Config, type Suite, type Layout,
} from './config/settings.js';
export { suggest, setupPlan, provision, locateTestDir, packagesBelow, describeProject, rankRunners } from './config/suggest.js';
export { syncPr, markPrReadyForRun, writeCiFailure, CI_FAILURE_FILE, type PrSync } from './runs/prsync.js';
export { readRunDoc, saveRunDoc, type SaveRunDoc, type SavedRunDoc } from './runs/run-docs.js';
export { renderSkill, renderTemplate, skillNames } from './config/skills.js';
export { argsProblem } from './cli/args.js';
export { currentState, skipReason, snapshot, changed, mirror, mark, parseKeys, worktreeChanges, type Changed } from './changes/index.js';
export { extract, rulesFor, modeFor, decide, ruleFor, detailFor, isProtected, loadState, repoRulesFile, type Ask } from './permissions/index.js';
export { resolvePath as modelsFile, loadRegistry, validateProvider, validateRegistry, probe, modelsMain, type Registry } from './models/index.js';
export {
  addBacklogItem, backlogItems, backlogMain, backlogPlace, parseIndex, parseTitle, type BacklogItem, type NewItem,
  readBacklogEdit, editBacklogItem, BacklogEditError, type EditPlace, type BacklogEditView, type ItemEdit, type ItemEditResult,
} from './backlog/index.js';
export { main, type Io } from './cli/main.js';
export { configDir } from './configDir.js';
export { TRACE_FILE, startTrace, stopTrace, trace, traceSettings, type TraceLine, type TraceSettings } from './trace.js';
export {
  readRegistry, writeRegistry, registryFile, projectDir, gitRoot, findContaining, RegistryError, readEditorSetting, writeEditorSetting,
  type ProjectEntry, type ProjectOverrides,
} from './registry/projects.js';
export {
  DEFAULT_EDITOR, EDITORS, EDITOR_IDS, editorArgv, editorChoices, editorName, editorSettingErrors, normalizeEditor, splitWords,
  systemEditorCmd, validateCustomEditor, type EditorId, type EditorInfo, type EditorSetting,
} from './config/editor.js';
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
  runContext, start, stop, restart, discard, discardStage, undoLast, statusLines, statusRecords, watchFrame, runChanges, allChanges, runWorktree, pickBase,
  pipelineArgv, pipelineEnv, closeGoneRuns, closeIfGone, type RunContext, type Outcome,
} from './runs/index.js';
export { keepError } from './pipeline/errors.js';
export { addNotice, recentNotices, clearNotices, type Notice } from './runs/notices.js';
export { alive, killTree, readRecord, recordedSlugs, registryDir, primeRepoPaths, runState, type RunRecord } from './runs/records.js';
export {
  answerQuestions, boardView, boardInputs, boardIgnores, syncRunPr, parseQuestions, resumeStage, runView, runPaths, runTail, RUN_PARTS, clearGitFacts, type RunPart, type BoardView, type PrCard, type Question, type RunCard, type RunView,
  type TestCounts, type ViewState,
} from './runs/view.js';
export { estimateUsd, isFree, loadOpencodePrices, loadPrices, priceOf, pricesFromOpencode, pricesNow, type Price, type PriceTable } from './models/prices.js';
export { costLog, costMarkdown, costText, timeText, tokenText, type CostLog, type CostRun, type CostStage } from './runs/cost-log.js';
export { runTimeline, type LockOpen, type LockView, type StageSpan, type StageStatus, type StepSpan, type Timeline, type UsageTotals } from './runs/timeline.js';
export { runPipeline, firstPending, type PipelineOptions } from './pipeline/run.js';
export { spawnAgentProcess, spawnClaude, type AgentSpawn, type AgentRequest } from './pipeline/agent.js';
export {
  FINALISE_PERMISSIONS,
} from './permissions/index.js';
export {
  listCompletedTasks, listCompletedTasksAsync, completedListAsync, settleBriefCleanups, warmCompletedPrs, type PrWarmup, getCompletedTaskDetail, getCompletedTaskDetailAsync, createPrForCompleted, isArchivedInIndex, syncPrComments,
  type CompletedTask, type CompletedList, type CompletedTaskDetail, type CommitInfo, type FileChange,
} from './runs/completed.js';
export {
  archiveTask, unarchiveTask, archiveCompleted, type ArchiveOptions,
} from './backlog/archive.js';
export {
  finalise, type FinaliseOptions, type FinaliseResult,
  getPrFromBrief, recordPrInBrief, createOrGetPr, getPrStatus, getPrStatusCached, getPrStatusAsync, syncPrStatus, prPollOptions, PR_POLL_MS, keepPrStatusIn, forgetPrStatuses, PR_STATUS_FILE, fetchPrComments, type PrStatus, type PrRead, type CiState, type PrComment,
} from './pipeline/finalise.js';
export { STAGE_DEFAULTS, resolveProvider, stageModel, providerEnv, type Provider } from './pipeline/models.js';
export { agentSources, mergeAgent, personalAgentOf, type AgentSources, type Source } from './config/personal.js';
export { editOverrides, editSettings, hashOf, applyPatch, setRunBehaviour, type EditResult, type SettingsPatch } from './config/edit.js';
export { CONTROL_ENV, RUN_ENV, RUN_ENV_NAME, RUN_RESERVED_ENV, runBehaviourErrors, runBehaviourOf, runEnv, runEnvSet, type RunBehaviour } from './config/run-behaviour.js';
export { FROM_STAGES, AGENT_STAGES, type From, type AgentStage } from './pipeline/context.js';
export type { StatusLine } from './pipeline/status.js';
export {
  triage, triagePrompt, indexItems, commitTriage, triageTools, TRIAGE_DIR, newRunId, triageRunDir, createTriageWorktree, removeTriageWorktree,
  triageSplitPrompt, triageItemPrompt, triageAnsweredMessage, triageContinueMessage, parseTriageItems, buildTriageDraft,
  pendingTriageQuestions, answerTriageQuestions, parseStreamLine,
  type RunClaude, type TriageResult, type TriageItem, type TriageDraft, type TriageQuestion, type TriageState, type DraftStatus, type TriageStreamPart,
} from './triage.js';
export * from './pipeline/harness/index.js';
export { stampOf } from './gitdir.js';
