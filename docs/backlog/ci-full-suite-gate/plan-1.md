# Technical Plan: CI Full Suite Gate (`ci-full-suite-gate`)

## Dependencies
- none

## Architecture Overview

This feature introduces a gate where the full test suite runs in GitHub Actions CI instead of locally when `tests.fullSuite` is configured to `"ci"`. It provides:
1. Configuration resolution (`tests.fullSuite`, `ci.waitMinutes`, `tests.allowFailures`) with environment, personal, and project precedence and strict validation.
2. Draft PR creation and availability checking right after the Red tests commit locks tests.
3. Mid-run and initial fallback to local execution if CI is unavailable or workflow is absent.
4. Implement attempt loop that runs local red/side-effect tests, commits, pushes, and waits for CI on the head commit.
5. CI failure classification: artifact download (`sdlc-test-report`), check-level fallback, classification into infrastructure, pre-existing (base comparison), flaky (single re-run of failed jobs), allowed (`tests.allowFailures`), or side-effect.
6. Non-blocking failure logging to `<docs>/logs/ci-failures.md` and CLI WARNINGs.
7. Local gate support for `tests.allowFailures` (non-blocking for matching tests; red tests never allowed).
8. Finalise readying of the existing PR without duplicate creation or squashing.
9. Structured per-round CLI logging and run status updates for the web UI.

---

## Order of Implementation

### Step 1: Configuration Schema, Resolution, and Overrides
**Files:**
- `src/config/settings.ts`
- `src/config/edit.ts`
- `src/registry/projects.ts`
- `test/config.test.ts`
- `test/edit-settings.test.ts`

**Changes & Functions:**
1. In `src/config/settings.ts`:
   - Extend `SCHEMA`:
     - Add `tests.fullSuite: ['local', 'ci']`.
     - Add `tests.allowFailures: 'string[]'`.
     - Add `ci: { waitMinutes: 'ciWaitMinutes' }` or custom integer check enforcing whole numbers $\ge 1$.
   - Update `Config` and `TestRuns` TypeScript interfaces to include:
     - `tests.fullSuite: 'local' | 'ci'`
     - `tests.allowFailures: string[]`
     - `ci: { waitMinutes: number }`
   - In `resolve(root, { env, agentFrom })`:
     - Validate environment variables:
       - `SDLC_FULL_SUITE`: If set and non-empty, must be `'local'` or `'ci'`. Any other value triggers config error naming source, key, bad value, and allowed values. Empty string counts as unset.
       - `SDLC_CI_WAIT_MINUTES`: If set and non-empty, must be a whole number $\ge 1$. Any other value triggers config error naming source, key, and bad value. Empty string counts as unset.
     - Validate personal overrides:
       - Read overrides for the project root via `findContaining(readRegistry(env), root)?.overrides`.
       - Validate `overrides.fullSuite` (must be `'local'` or `'ci'`) and `overrides.ciWaitMinutes` (whole number $\ge 1$).
     - Resolve `tests.fullSuite` with precedence: `env.SDLC_FULL_SUITE` > `overrides.fullSuite` > `file.tests?.fullSuite` > default `'local'`.
     - Resolve `ci.waitMinutes` with precedence: `env.SDLC_CI_WAIT_MINUTES` > `overrides.ciWaitMinutes` > `file.ci?.waitMinutes` > default `60`.
     - Validate and resolve `tests.allowFailures`: project config only (`file.tests?.allowFailures || []`). If present but not an array of non-empty strings, emit config error.
2. In `src/registry/projects.ts`:
   - Extend `ProjectOverrides` interface:
     - `fullSuite?: 'local' | 'ci'`
     - `ciWaitMinutes?: number`
3. In `src/config/edit.ts`:
   - In `overrideErrors(o: Json)`:
     - Validate `fullSuite`: must be `'local'` or `'ci'`.
     - Validate `ciWaitMinutes`: must be an integer $\ge 1$.
4. Tests in `test/config.test.ts` and `test/edit-settings.test.ts`:
   - Test default values (`tests.fullSuite = 'local'`, `ci.waitMinutes = 60`).
   - Test precedence: environment variable overrides personal override, personal override overrides project config.
   - Test validation errors for bad values in environment, personal override, project config, and `tests.allowFailures`.

---

### Step 2: Allow-Failures Matching and Local Gate Scoping
**Files:**
- `src/pipeline/allow-failures.ts` (new file)
- `src/pipeline/gates.ts`
- `test/allow-failures.test.ts` (new file)
- `test/gates-failfast.test.ts`

**Changes & Functions:**
1. In `src/pipeline/allow-failures.ts`:
   - Export `parseAllowEntry(entry: string): { filePattern: string; testName: string | null }`.
   - Export `matchesAllowEntry(entry: string, file: string, testName?: string | null): boolean`:
     - Compares test file using glob matching via `globToRegex(pattern)`.
     - If entry contains ` > <test name>`, checks that full reported test name matches `<test name>`.
   - Export `isRedTest(ctx: Ctx, file: string, testName?: string | null): boolean`:
     - Checks if file/test was introduced/modified in `ctx.redSha` or recorded in `red.json`.
   - Export `checkAllowedFailures(failures: Array<{ file: string; name?: string }>, allowList: string[], isRed: (f: string, n?: string) => boolean, warn: (msg: string) => void): { allowed: Array<{ file: string; name?: string }>; blocked: Array<{ file: string; name?: string }> }`:
     - Emits `WARNING` when an allow entry matches a red test (and ignores the allow entry for that red test).
     - Categorizes matching non-red test failures as allowed.
2. In `src/pipeline/gates.ts`:
   - In `testsPass(ctx, opts)`:
     - When `ctx.config.tests.fullSuite === 'ci'` and CI is available:
       - Limit local gate execution targets to red test files (`redCommitTestFiles(ctx)` / `targetTestFiles(ctx)`) plus any recorded CI side-effect test files (`ctx.ciSideEffectFiles`).
       - Filter failures against `tests.allowFailures`:
         - If all failing tests match allowed entries, log warnings, record allowed failures into test log, and treat local gate as passed.
         - If any non-allowed failure remains (or red test fails), gate fails.
3. Tests in `test/allow-failures.test.ts`:
   - Test glob file matching and `<file> > <test name>` matching.
   - Test that red tests matching allow entries are flagged with WARNING and remain blocking.
   - Test that non-red tests matching allow entries pass the gate with WARNINGs.

---

### Step 3: GitHub PR Query and Draft PR Enhancements
**Files:**
- `src/pipeline/finalise.ts`
- `test/pr-status.test.ts`

**Changes & Functions:**
1. In `src/pipeline/finalise.ts`:
   - Extend `PrStatus` interface:
     - `url: string`
     - `state: 'OPEN' | 'MERGED' | 'CLOSED'`
     - `number?: number`
     - `isDraft?: boolean`
     - `statusCheckRollup?: CheckRunStatus[]`
   - In `createOrGetPr(cwd, branch, title, body, base, opts?: { draft?: boolean })`:
     - Support `--draft` flag when creating a PR.
     - Detect existing PR status: return existing open PR (draft or ready) as-is without converting to draft.
   - In `refreshPrStatus` and `getPrStatus`:
     - Update `gh pr view` args to include `--json url,state,number,isDraft,statusCheckRollup`.
     - Update `parsePr(stdout)` to extract `isDraft` and `statusCheckRollup`.
   - Export `markPrReady(cwd: string, branchOrUrl: string, env?: NodeJS.ProcessEnv): boolean`:
     - Executes `gh pr ready <branchOrUrl>` to convert draft PR to ready.
2. Tests in `test/pr-status.test.ts`:
   - Test parsing of `isDraft` and check rollup items.
   - Test `markPrReady` invocation.

---

### Step 4: CI Step: Availability, Waiting, Report Download, and Failure Classification
**Files:**
- `src/pipeline/ci.ts` (new file)
- `test/ci-step.test.ts` (new file)

**Changes & Functions:**
1. In `src/pipeline/ci.ts`:
   - Define types:
     - `CiClassification = 'infrastructure' | 'pre-existing' | 'flaky' | 'allowed' | 'side-effect'`
     - `CiCheckResult = { name: string; conclusion: string; detailsUrl?: string; log?: string }`
     - `CiTestFailure = { checkName: string; file: string; testName: string; message: string; runUrl: string; classification: CiClassification }`
     - `CiStepResult = { status: 'green' | 'green-with-warnings' | 'red' | 'timed-out' | 'unavailable'; reason?: string; nonBlocking: CiTestFailure[]; sideEffects: CiTestFailure[]; testFiles: string[]; totalTests?: number; failedTests?: number; skippedTests?: number; durationMs?: number }`
   - Implement `checkCiAvailability(ctx: Ctx): { available: boolean; reason?: string }`:
     - Checks `origin` remote: `git remote` contains `origin` (else `no remote`).
     - Checks `gh` installed: `gh --version` runs without error (else `gh not installed`).
     - Checks `gh` authenticated: `gh auth status` returns 0 (else `gh not authenticated`).
     - Pushes branch with upstream tracking: `git push -u origin <branch>`; on failure returns `push failed: <first line of git error>`.
     - Checks existing PR or creates draft PR:
       - If PR is closed -> `PR is closed`.
       - If PR is merged -> `PR is merged`.
       - If PR creation/lookup fails -> `PR could not be created`.
     - Records PR in `brief.md`.
   - Implement `downloadTestReport(cwd: string, runId: string, destDir: string, env: NodeJS.ProcessEnv): RunParts | null`:
     - Runs `gh run download <runId> -n sdlc-test-report -D <destDir>`.
     - Parses downloaded JSON using `parseJestLike`, `parseNodeTest`, or native `RunResult` structure.
     - Returns null if artifact is missing or parsing fails.
   - Implement `fetchBaseResults(ctx: Ctx): { report: RunParts | null; failedChecks: string[] }`:
     - Resolves merge-base: `git merge-base HEAD <base>` (defaulting `<base>` to `ctx.config.git.base || 'main'`).
     - Queries latest completed CI run on base commit with `gh run list --commit <baseSha>`.
     - Attempts to download base commit's `sdlc-test-report`.
   - Implement `waitForCiAndClassify(ctx: Ctx, headSha: string, options: { prUrl: string; startTime: number }): Promise<CiStepResult>`:
     - Reuses `getPrStatus(ctx.root, prUrl, ctx.env)` polling every 60 seconds.
     - Detects "no workflow" condition: if no check is registered for head commit within 3 minutes of push, returns `status: 'unavailable', reason: 'no workflow'`.
     - Detects timeout: if elapsed minutes exceed `ctx.config.ci.waitMinutes`, returns `status: 'timed-out'`.
     - When all checks have finished (conclusions: success, skipped, neutral, or failed):
       - If all checks are success/skipped/neutral -> returns `status: 'green'`.
       - If any check failed:
         - Attempt downloading `sdlc-test-report` for head commit.
         - If report is missing or cannot be parsed:
           - Print `CI test report not found: classifying by check` once per run.
           - Classify per check (8.2):
             1. Infrastructure: conclusion cancelled, timed_out, startup_failure, or log has no test output.
             2. Pre-existing: check with same name failed in base results.
             3. Allowed: whole-file `tests.allowFailures` entry matches file in check log.
             4. Flaky: run `gh run rerun <runId> --failed` once; if check passes on rerun, classify as flaky.
             5. Side effect: remaining failures.
         - If report is present:
           - Classify per test (8.3):
             1. Infrastructure per check.
             2. Pre-existing: test (file + name) failed in base commit report.
             3. Allowed: matches `tests.allowFailures` (red tests never allowed).
             4. Flaky: failed test passes on single rerun of failed jobs (`gh run rerun <runId> --failed`).
             5. Side effect: remaining failures.
       - If side-effect failures remain -> returns `status: 'red'`.
       - If only non-blocking failures remain -> returns `status: 'green-with-warnings'`.
       - Log non-blocking failures to `<docs>/logs/ci-failures.md` and emit WARNING lines.
2. Tests in `test/ci-step.test.ts`:
   - Unit tests mocking `gh` CLI invocations for:
     - Availability checks (no remote, gh missing, unauthenticated, closed PR, merged PR).
     - Waiting and 3-minute "no workflow" detection.
     - Timeout handling at `ci.waitMinutes`.
     - Test-level classification with report (pre-existing, flaky, allowed, side-effect).
     - Check-level classification without report.

---

### Step 5: Red Tests and Implement Pipeline Integration
**Files:**
- `src/pipeline/stages.ts`
- `src/pipeline/run.ts`
- `src/pipeline/status.ts`
- `src/pipeline/context.ts`
- `test/stages-ci.test.ts` (new file)

**Changes & Functions:**
1. In `src/pipeline/context.ts` & `src/pipeline/status.ts`:
   - Add fields to `Ctx`:
     - `ciAvailable?: boolean`
     - `ciFallbackReason?: string`
     - `ciSideEffectFiles?: string[]`
     - `ciLastResult?: CiStepResult`
   - Add CI details to `StatusLine` / `Status`:
     - `ci?: { enabled: boolean; state: string; reason?: string; pr?: string | null; failingChecks?: string[]; warnings?: string[] }`
2. In `src/pipeline/stages.ts`:
   - In `redTestsStage(ctx)`:
     - After red gate passes and tests are locked in `ctx.redSha`:
     - If `ctx.config.tests.fullSuite === 'ci'`:
       - Run availability check via `checkCiAvailability(ctx)`.
       - If unavailable: print `CI unavailable (<reason>): running the full suite locally`. Set `ctx.ciAvailable = false; ctx.ciFallbackReason = reason;`. Record in status.
       - If available: set `ctx.ciAvailable = true;`. Record draft PR in `brief.md`.
   - In `implementStage(ctx)`:
     - If `ctx.config.tests.fullSuite === 'ci'` and `ctx.ciAvailable !== false`:
       - Handle resume: if `ctx.from === 'implement'` and branch head was already pushed and unchanged, wait for CI before running agent (without consuming an attempt).
       - In attempt loop (`1..maxAttempts`):
         - Run implement agent with prompt enriched with side-effect failure details from earlier CI rounds.
         - Run local gate on red test files + test files from earlier CI side effects + `integration.cmd`.
         - If local gate fails: no commit, no push, no CI. Feed local failures to next round.
         - If local gate passes:
           - Check changed files against baseline (`changed(baselineFile, opts)`).
           - Commit changes: `feat(<slug>): implement (attempt N)` using Finalise baseline rules.
           - Push to origin.
           - Call `waitForCiAndClassify(ctx, headSha, { prUrl, startTime })`.
           - If `status === 'unavailable'` with reason `no workflow`: fall back mid-implement. Print fallback message, switch to setting-off behavior for remaining attempts, rerun local full suite for current gate.
           - If `status === 'timed-out'`: print `status: Timed out after <N>m (paused)` and stop with exit code 2 and hint `resume with FROM=implement`.
           - If `status === 'green'` or `status === 'green-with-warnings'`: Implement succeeds; return true.
           - If `status === 'red'`: accumulate side-effect test files for next round's local gate and feed failure diagnostics to next attempt.
         - Print exact per-round output block (Spec 10.1).
       - If attempts exhausted with side-effect failures: fail with `GREEN GATE FAILED after N attempts`. Fail log holds latest CI failures.
   - In `finaliseStage(ctx)`:
     - When setting is on and PR exists:
       - Commit remaining files (Review changes) without squashing.
       - Push branch.
       - Call `markPrReady(ctx.root, prUrl)` to mark PR ready (`gh pr ready`).
       - Do not open a second PR.
3. Tests in `test/stages-ci.test.ts`:
   - Test Red tests draft PR opening and fallback triggers.
   - Test Implement loop with passing local gate, commit naming `feat(<slug>): implement (attempt N)`, CI wait, and retry on side-effect failure.
   - Test pause and resume behavior on timeout.
   - Test finalise marks existing PR ready.

---

### Step 6: Web UI and Run Status Integration
**Files:**
- `src/runs/view.ts`
- `web/ui/src/api.ts`
- `web/ui/src/Run.tsx`
- `web/test/run-ci-view.test.ts` (new file)

**Changes & Functions:**
1. In `src/runs/view.ts`:
   - In `runView(ctx, slug, opts)`:
     - Read CI status from `status.json`.
     - When `tests.fullSuite === 'ci'`, expose `ci` object in `RunView`:
       - `state`: `'waiting' | 'running' | 'green' | 'red: side effect' | 'green with warnings' | 'timed out (paused)' | 'unavailable: running locally'`
       - `pr`: PR URL
       - `prDraft`: boolean (draft vs ready)
       - `reason`: fallback reason (when unavailable)
       - `failingChecks`: string[]
       - `warnings`: string[]
     - When `tests.fullSuite === 'local'`, omit CI object / set to null.
2. In `web/ui/src/api.ts`:
   - Update `RunView` interface with `ci` status properties.
3. In `web/ui/src/Run.tsx`:
   - Render CI line on the run page when `v.ci` is present:
     - Display PR link with `draft` or `ready` badge.
     - Display current CI status with appropriate pill/badge styling (`waiting`, `running`, `green`, `red: side effect`, `green with warnings`, `timed out (paused)`, `unavailable: running locally`).
4. Tests in `web/test/run-ci-view.test.ts`:
   - Test `runView` with setting on produces correct CI view payload and PR draft label.
   - Test `runView` with setting off produces no CI line payload.

---

### Step 7: Documentation (Review Stage Verification)
**Files:**
- `README.md`
- `docs/web-ui.md`

**Documentation Updates:**
1. In `README.md`:
   - Document `tests.fullSuite` (`"local" | "ci"`, default `"local"`), personal override `fullSuite`, and `SDLC_FULL_SUITE`.
   - Document `ci.waitMinutes` (default 60), personal override `ciWaitMinutes`, and `SDLC_CI_WAIT_MINUTES`.
   - Document `tests.allowFailures` in `sdlc.config.json` with file and `<file> > <test name>` syntax.
   - Document draft PR creation after Red tests and how Implement waits for CI.
   - Document the GitHub Actions workflow step to upload the `sdlc-test-report` artifact.
2. In `docs/web-ui.md`:
   - Document the CI status line on the run page and per-round output formatting.

---

## Verification Plan

### Automated Real-Code Unit and Integration Tests
Execute tests using the one-file test runner: `ai-sdlc-helper run --file <test-file>`:
1. **Config & Overrides Tests (`test/config.test.ts` & `test/edit-settings.test.ts`):**
   - Run `ai-sdlc-helper run --file test/config.test.ts` to verify config validation, precedence (`SDLC_FULL_SUITE` > `fullSuite` > `tests.fullSuite`), and error reporting for invalid values.
2. **Allow-Failures Logic Tests (`test/allow-failures.test.ts`):**
   - Run `ai-sdlc-helper run --file test/allow-failures.test.ts` to verify glob matching, per-test matching, red test protection, and non-blocking warnings in local gates.
3. **PR & Status Checks Tests (`test/pr-status.test.ts`):**
   - Run `ai-sdlc-helper run --file test/pr-status.test.ts` to verify PR draft query, check rollup parsing, and cache behavior.
4. **CI Step & Classification Tests (`test/ci-step.test.ts`):**
   - Run `ai-sdlc-helper run --file test/ci-step.test.ts` to verify availability checks, fallback reasons, timeout pauses, base comparison, flaky reruns, and report parsing.
5. **Stages Integration Tests (`test/stages-ci.test.ts`):**
   - Run `ai-sdlc-helper run --file test/stages-ci.test.ts` to verify Red tests draft PR opening, Implement attempt commits, feedback propagation, and Finalise marking ready.
6. **Web View Tests (`web/test/run-ci-view.test.ts`):**
   - Run `ai-sdlc-helper run --file web/test/run-ci-view.test.ts` to verify runView CI payload generation when setting is on vs off.
