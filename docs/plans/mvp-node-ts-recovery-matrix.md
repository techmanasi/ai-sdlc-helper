# MVP Specification: Node.js & TypeScript Zero Dead-End Recovery Matrix

> **Target Release:** `ai-sdlc-helper` v0.1.0 MVP  
> **Target Audience:** Developers maintaining Node.js (>= 18) and TypeScript codebases  
> **Core Guarantee:** "Guaranteed Forward Progress with Zero Dead-Ends" — every pause, refusal, or failure produces deterministic, actionable diagnosis with three immediate resolution paths: (1) Autonomous 1-click/flag fix, (2) Assisted human-in-the-loop steering, and (3) Escape hatch / bailout.

---

## 1. Node.js & TypeScript Ecosystem Compatibility Matrix

The MVP is engineered and validated specifically for Node.js and TypeScript projects. Non-Node runtimes (Python/Go/Rust) and cloud SaaS dependencies are strictly out of scope for the MVP.

| Runtime / Tool | Supported Versions | Notes & Detection Strategy |
| :--- | :--- | :--- |
| **Node.js** | `>= 18.18.0`, `20.x`, `22.x`, `24.x` | Verified in `package.json.engines.node`. Supports native ESM, worker threads, and built-in `node:test`. |
| **TypeScript** | `5.x`, `4.9+` | Handles CommonJS (`"module": "commonjs"`), ES Modules (`"moduleResolution": "NodeNext"` or `"Bundler"`), and compiled `tsc` build pipelines. |
| **Vitest** | `1.x`, `2.x`, `3.x` | Auto-detected via `vitest.config.ts`, `vite.config.ts`, or `"test": "vitest"`. Parses JSON test results natively. |
| **Jest** | `27.x`, `28.x`, `29.x` | Auto-detected via `jest.config.*` or `"test": "jest"`. Supports `ts-jest` and `@swc/jest`. |
| **Mocha** | `9.x`, `10.x` | Auto-detected via `.mocharc.*` or `"test": "mocha"`. Runs with `ts-node` or `tsx` loader. |
| **node:test** | Native in Node >= 18 | Auto-detected when `--test` is configured. Emits and parses TAP / spec results. |
| **Package Managers** | `npm`, `pnpm`, `yarn` (classic/berry), `bun` | Auto-detects lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`). |

---

## 2. Pre-flight Readiness & Zero-Config Onboarding

Before initiating a pipeline run, the environment is validated to ensure zero setup friction.

### 2.1 Pre-Flight Check (`doctor` validation)
1. **Git Repository Status:**
   - Validates that the current folder is inside a Git working tree (`git rev-parse --is-inside-work-tree`).
   - Ensures `user.name` and `user.email` are configured in git config (or alerts developer).
   - Verifies base branch is clean or can spawn an isolated worktree.
2. **Node & Package Setup:**
   - Validates `package.json` exists in project root.
   - Validates `npm test` or configured test runner script is defined.
   - Detects test directories (`test/`, `tests/`, `__tests__/`, `src/**/*.test.ts`).
3. **Agent Harness Readiness:**
   - Checks agent executable availability (`claude`, `gh`, or configured agent backend in PATH).
   - Validates API key or CLI session tokens before launching lengthy tasks.

---

## 3. Seven-Stage "Zero Dead-Ends" Recovery State Machine

In AI-driven TDD workflows, an AI agent can pause for human clarification, request sensitive tool permissions, hit token limits, or fail on test assertions. The system guarantees that developers are never left at a blank screen or vague stack trace.

```
       ┌──────────┐
       │   SPEC   ├───────────────────────┐
       └────┬─────┘                       │
            │                             ▼
       ┌────┴─────┐               [ DIAGNOSTIC ENGINE ]
       │   PLAN   ├───────────────► 1. Autonomous Path
       └────┬─────┘                 2. Human-in-the-Loop Path
            │                       3. Escape Hatch / Bailout
       ┌────┴─────┐                       ▲
       │RED TESTS ├───────────────────────┤
       └────┬─────┘                       │
            │                             │
       ┌────┴─────┐                       │
       │IMPLEMENT ├───────────────────────┤
       └────┬─────┘                       │
            │                             │
       ┌────┴─────┐                       │
       │TESTREPAIR├───────────────────────┤
       └────┬─────┘                       │
            │                             │
       ┌────┴─────┐                       │
       │  REVIEW  ├───────────────────────┤
       └────┬─────┘                       │
            │                             │
       ┌────┴─────┐                       │
       │ FINALISE ├───────────────────────┘
       └──────────┘
```

### Detailed Stage Matrix

| Stage | Trigger / Failure Symptom | Autonomous Resolution (1-Click / CLI) | Human-in-the-Loop Steering | Escape Hatch / Bailout Path |
| :--- | :--- | :--- | :--- | :--- |
| **1. Spec** | Agent generated clarifying questions (`questions.md` has unanswered items, exit code 2). | **Auto-Answer:** Resume with model's suggested answers: `ai-sdlc-helper pipeline <slug> --from spec` with accepted defaults. | **Steer:** Open `<slug>/questions.md`, answer questions under `## Answer:`, then click "Resume" in UI. | **Bailout:** Manually write `<slug>/spec.md` with explicit scope and resume from Plan: `ai-sdlc-helper pipeline <slug> --from plan`. |
| **1. Spec** | Model permission request denied or pending (`permissions.json`). | **Auto-Approve:** Click "Allow Safe" in UI or run `ai-sdlc-helper permit <slug> allow all`. | **Review:** Inspect command/path in UI Permissions card and selectively allow/deny. | **Bailout:** Add protected path to repo `.sdlc/rules` or rerun with `--allow-all`. |
| **2. Plan** | Planner agent failure, missing context, or file read error (exit code 1). | **Auto-Retry:** Retry with expanded context: `ai-sdlc-helper pipeline <slug> --from plan`. | **Steer:** Add architectural constraints directly into `<slug>/plan.md` or `brief.md`. | **Bailout:** Write or paste approved plan in `<slug>/plan.md` and advance directly to Red Tests: `ai-sdlc-helper pipeline <slug> --from red-tests`. |
| **3. Red Tests** | Tests unexpectedly PASS on unimplemented code ("green on red", exit code 1). | **Auto-Audit:** Retry prompt directing agent to assert new functionality rather than existing behavior. | **Steer:** Edit new test in `test/` to assert unbuilt feature behavior. | **Bailout:** Delete redundant test file or mark existing test as expected regression test. |
| **3. Red Tests** | Test suite syntax error, compilation failure, or runner timeout. | **Auto-Repair:** Re-run red-tests agent with error logs injected. | **Steer:** Fix import or typing syntax in `<slug>/log/red.err` directly in editor. | **Bailout:** Run tests manually (`npx vitest run <file>`) to isolate error, then resume. |
| **4. Implement** | Max attempts reached (e.g., 3/3 attempts failed tests, exit code 1). | **Auto-Branch:** If implement agent noted test defects in `test-issues.md`, automatically advance to Test Repair: `ai-sdlc-helper pipeline <slug> --from test-repair`. | **Steer:** Inspect `<slug>/log/test-issues.md` and `now.json`; edit implementation files directly to address remaining failures. | **Bailout:** Checkpoint partial worktree (`git commit -am "wip"`) and resume with custom model: `ai-sdlc-helper pipeline <slug> --from implement --model opus`. |
| **4. Implement** | Agent was refused tool action (write to protected file, npm install, etc.). | **Auto-Grant:** Permit tool via UI button or `ai-sdlc-helper permit <slug> allow <id>`. | **Steer:** Manually run the requested command (e.g. `npm install <pkg>`) and resume. | **Bailout:** Deny action and let agent find alternative implementation. |
| **5. Test Repair** | Repaired test no longer fails on red commit (vacuous repair rejected by `redcheck`, exit code 1). | **Auto-Audit:** Re-run test repair agent with audit rejection feedback in prompt. | **Steer:** Edit test file so that it tests the real requirement and genuinely fails on the original unimplemented source. | **Bailout:** Discard test repair changes and restore original red tests: `git checkout <red_sha> -- <test_files>`, then resume implement: `ai-sdlc-helper pipeline <slug> --from implement`. |
| **6. Review** | Review agent rejected code with blocking issues (exit code 1). | **Auto-Fix:** Send review feedback directly back to Implement: `ai-sdlc-helper pipeline <slug> --from implement`. | **Steer:** Inspect `<slug>/log/review.md` and address specific reviewer concerns in code. | **Bailout:** Force proceed if review warnings are false positives: `ai-sdlc-helper pipeline <slug> --from finalise`. |
| **6. Review** | Review agent illegally modified test files ("GUARD FAILED: review modified tests"). | **Auto-Revert:** Revert test changes back to locked tests: `git checkout <lock_sha> -- <test_files>` and resume review. | **Steer:** Keep code edits but discard test edits manually. | **Bailout:** Advance to finalise directly. |
| **7. Finalise** | Git merge conflict when rebasing against base branch. | **Auto-Stash:** Pipeline keeps branch `sdlc/<slug>` intact with conflict markers logged. | **Steer:** Resolve merge conflicts in the worktree (`git status`, resolve, `git commit`), then resume: `ai-sdlc-helper pipeline <slug> --from finalise`. | **Bailout:** Keep feature branch without auto-merging: developer opens PR manually via GitHub/GitLab web interface. |
| **7. Finalise** | GitHub CLI (`gh`) authentication error or network timeout creating PR. | **Auto-Retry:** Re-run `ai-sdlc-helper pipeline <slug> --from finalise` after confirming GitHub connectivity. | **Steer:** Run `gh auth login` in terminal, then resume. | **Bailout:** Push branch directly (`git push origin sdlc/<slug>`) and create PR manually. |

---

## 4. Diagnostics & Recovery Architecture

### 4.1 Structured Diagnosis Contract
The diagnostic engine in `src/pipeline/hints.ts` analyzes:
- The current pipeline stage (`spec`, `plan`, `red-tests`, `implement`, `test-repair`, `review`, `finalise`)
- Exit code (`0` = done, `1` = failed, `2` = paused)
- Document states (`questions.md`, `permissions.json`, `test-issues.md`, `now.json`, `run.out`)
- Git state (uncommitted changes, locked test shas, merge conflicts)

It outputs a structured `StageRecovery` object:
```typescript
export interface StageRecovery {
  stage: string;
  diagnosis: string;
  autoAction?: {
    label: string;
    command: string;
    env?: Record<string, string>;
  };
  manualAction?: {
    file?: string;
    instruction: string;
  };
  escapeHatch?: {
    label: string;
    command: string;
  };
}
```

### 4.2 Web UI Recovery Card Integration
When `v.state === 'paused' | 'failed' | 'refused'`, `web/ui/src/Run.tsx` displays an elevated Recovery Card directly below the status banner:
1. **Diagnosis summary banner:** Explains exactly why the pipeline stopped (e.g. "Test Repair rejected: Repaired test no longer detects the bug on unimplemented source").
2. **Action buttons:**
   - Primary button: One-click Auto Action (e.g. `[ Auto-Answer & Resume ]` or `[ Retry Implement ]`).
   - Secondary button: Quick file link to open relevant file in editor (e.g. `[ Open questions.md ]` or `[ Open test-issues.md ]`).
   - Tertiary button: Escape Hatch (e.g. `[ Restore Red Tests & Re-implement ]` or `[ Skip to Finalise ]`).

### 4.3 CLI Output Guarantee
When executing `ai-sdlc-helper pipeline <slug>` in a terminal or CI environment, upon exit code `1` or `2`, the CLI prints:
```
================================================================================
SDLC PIPELINE PAUSED / STOPPED AT: <stage>
DIAGNOSIS: <diagnosis>
--------------------------------------------------------------------------------
RECOVERY OPTIONS:
  1. Auto:   <autoAction.label> -> Run: <autoAction.command>
  2. Manual: <manualAction.instruction> (File: <manualAction.file>)
  3. Bailout:<escapeHatch.label> -> Run: <escapeHatch.command>
================================================================================
```

---

## 5. MVP Packaging, Publishing & Quality Gate

### 5.1 Package Configuration (`package.json`)
- `name`: `ai-sdlc-helper`
- `bin`: `{ "ai-sdlc-helper": "dist/bin.js" }`
- `files`: `["dist", "assets", "CHANGELOG.md"]`
- `engines`: `{ "node": ">=18.18" }`
- Executable header: `dist/bin.js` starts with `#!/usr/bin/env node`.

### 5.2 Release Quality Verification Checklist
- [x] All unit and integration test suites pass (`npm test`).
- [x] Fast test gate passes in < 15 seconds (`npm run test:fast`).
- [x] Type checking and linting pass (`npm run check`).
- [x] `npm pack --dry-run` confirms clean tarball with only `dist/`, `assets/`, `CHANGELOG.md`, `README.md`, `package.json`.
- [x] Clean-room smoke test: Installing packed tarball into a brand-new Node/TS repo successfully runs `doctor`, `init`, and starts a test run.
