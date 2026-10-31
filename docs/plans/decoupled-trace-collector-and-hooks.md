# Architecture & Execution Plan: Decoupled Log Collection & Pluggable Lifecycle Hooks

## 1. Executive Summary & Philosophy

This document defines the decoupled telemetry harvesting and log collection architecture for the `ai-sdlc-helper` ecosystem.

### Core Architectural Principle
* **`ai-sdlc-helper` (Production Runtime Engine):** Remains completely lean, fast, and free of telemetry/upload complexity. It contains **zero** awareness of the optimizer repository, zero external network dependencies, and zero heavy log-bundling tools. It merely checks for the existence of an optional executable hook at `.sdlc/hooks/post-finalise` and executes it asynchronously in detached mode if present.
* **`ai-sdlc-optimizer` (Companion Meta-Optimizer):** Houses the complete extraction, secret redaction, manifest generation, and Git synchronization machinery. It provides simple `hook install` and `hook uninstall` commands to plug into any local repository.
* **Unplugging Guarantee:** If the hook is deleted or not installed, `ai-sdlc-helper` executes with 0ms penalty, zero logs, and zero side effects.

---

## 2. System Architecture & Lifecycle Flow

```
┌─────────────────────────────────────────────────────────────┐
│                 ai-sdlc-helper (Core Engine)                │
│                                                             │
│  Pipeline: Spec -> Plan -> Red -> Implement -> Finalise     │
│                                   │                         │
│                                   ▼                         │
│                     Finalise Stage Completes                │
│                                   │                         │
│              fs.existsSync('.sdlc/hooks/post-finalise')?    │
│                         /                  \                │
│                     [No]                    [Yes]           │
│                      │                        │             │
│            Exits immediately        Spawn detached,         │
│            (0ms, 0 overhead)        fire-and-forget process │
└───────────────────────────────────────┬─────────────────────┘
                                        │ SDLC_SLUG, SDLC_DOCS, SDLC_ROOT
                                        ▼
┌─────────────────────────────────────────────────────────────┐
│               ai-sdlc-optimizer (Companion Repo)            │
│                                                             │
│  1. Hook Wrapper invokes:                                   │
│     `node /path/to/ai-sdlc-optimizer/bin/collect.mjs`       │
│                                                             │
│  2. Harvest Ephemeral Artifacts:                            │
│     - status.json, run.out, wrapper.log                     │
│     - brief.md, decisions.md, specs-1.md                    │
│     - tests.json, red.json, permissions.json                │
│     - Agent JSONL files (*.json: tokens, TTFT, thinking)    │
│                                                             │
│  3. Multi-Pass Secret & Path Sanitization:                  │
│     - Strips Bearer tokens, API keys (sk-ant-*, ghp_*)      │
│     - Anonymizes local home paths ($HOME -> [HOME_DIR])     │
│                                                             │
│  4. Manifest & Integrity Verification:                      │
│     - Computes SHA-256 hash for every harvested file        │
│     - Emits manifest.json                                   │
│                                                             │
│  5. Atomic Git Commit & Remote Push:                        │
│     - Saves to data/runs/<date>-<slug>/                     │
│     - Git commit & push to remote trace storage repository  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. The Hook Contract (in `ai-sdlc-helper`)

### 3.1 Hook Discovery
At the conclusion of `finalise()` in `src/pipeline/finalise.ts`, the engine looks for an executable hook:
1. File check: `path.join(ctx.root, '.sdlc', 'hooks', 'post-finalise')`
2. Environment override: `process.env.SDLC_HOOK_POST_FINALISE`

### 3.2 Invocation Interface
The hook is spawned in detached, non-blocking mode (`stdio: 'ignore'`, `detached: true`, `unref()`):
* **Arguments:** `post-finalise <slug> <docsDir> <exitCode>`
* **Environment Variables:**
  * `SDLC_SLUG`: The backlog item slug (e.g. `add-ui-triage-agent`)
  * `SDLC_ROOT`: The root path of the project repository
  * `SDLC_DOCS_DIR`: Path to the task's docs folder (`Docs/backlog/<slug>`)
  * `SDLC_LOGS_DIR`: Path to the ephemeral logs (`Docs/backlog/<slug>/logs`)
  * `SDLC_BRANCH`: The task's branch name
  * `SDLC_BASE`: The base branch name

### 3.3 Zero-Code Minimal Dispatcher
Implementation in `ai-sdlc-helper` (only ~12 lines of code in `src/pipeline/hooks.ts`):
```typescript
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function runPostFinaliseHook(root: string, slug: string, docsDir: string, exitCode = 0): void {
  const hookFile = process.env.SDLC_HOOK_POST_FINALISE || path.join(root, '.sdlc', 'hooks', 'post-finalise');
  try {
    if (!fs.existsSync(hookFile)) return;
    const child = spawn(hookFile, [slug, docsDir, String(exitCode)], {
      cwd: root,
      env: { ...process.env, SDLC_SLUG: slug, SDLC_ROOT: root, SDLC_DOCS_DIR: docsDir },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* non-blocking: hook errors never fail the core pipeline */
  }
}
```

---

## 4. Ingestion, Sanitization & Sync Pipeline (in `ai-sdlc-optimizer`)

### 4.1 Harvest Manifest
The collector in `ai-sdlc-optimizer` targets the following files from `Docs/backlog/<slug>`:
* **Context & Decisions:** `brief.md`, `decisions.md`, `specs-1.md`, `plan-1.md`
* **Lifecycle & Outputs:** `logs/run.out`, `logs/status.json`, `logs/stage-files.json`
* **Test Metrics:** `logs/tests.json`, `logs/red.json`
* **Permissions:** `logs/permissions.json`
* **Agent Transcripts:** `logs/*.json` (e.g., `spec-1.json`, `impl-1.json`, capturing TTFT, tokens, thinking tokens, and tool calls)

### 4.2 Multi-Pass Redaction Engine
Before writing to the optimizer repository or running git commits, all content passes through regex-based sanitizers:
1. **API Keys & Bearer Tokens:**
   * Anthropic (`sk-ant-[a-zA-Z0-9_\-]+`) &rarr; `[REDACTED_ANTHROPIC_KEY]`
   * OpenAI (`sk-[a-zA-Z0-9]{32,}`) &rarr; `[REDACTED_OPENAI_KEY]`
   * GitHub (`gh[pousr]-[a-zA-Z0-9]{36}`) &rarr; `[REDACTED_GITHUB_TOKEN]`
   * Generic Headers (`Authorization: Bearer [^\n\r]+`) &rarr; `Authorization: Bearer [REDACTED]`
2. **Filesystem Paths:**
   * User home path (`/Users/[^/]+` or `/home/[^/]+`) &rarr; `[USER_HOME]`
3. **Environment Credentials:**
   * Connection strings (`postgres://.*`, `mysql://.*`, `mongodb://.*`) &rarr; `[REDACTED_DB_URL]`

### 4.3 Target Storage Layout in `ai-sdlc-optimizer`
```
ai-sdlc-optimizer/
├── data/
│   └── traces/
│       └── 2026-10-31-add-ui-triage-agent/
│           ├── manifest.json         # Git commit, timestamp, sha256 hashes
│           ├── brief.md
│           ├── decisions.md
│           ├── run.out
│           └── logs/
│               ├── status.json
│               ├── spec-1.json
│               ├── impl-1.json
│               ├── red.json
│               └── tests.json
```

### 4.4 Automated Git Sync
The collector executes a localized git transaction inside `ai-sdlc-optimizer`:
```bash
git -C /path/to/ai-sdlc-optimizer add data/traces/<date>-<slug>/
git -C /path/to/ai-sdlc-optimizer commit -m "trace(ingest): add execution trace for <slug> (<timestamp>)"
git -C /path/to/ai-sdlc-optimizer push origin main
```

---

## 5. Hook Management: Install & Uninstall

The optimizer repository provides a single CLI utility to manage hook registration:

### Install Hook
```bash
# In the optimizer repository:
node bin/optimizer.mjs hook install /Volumes/Work/Projects/trials/ai-sdlc-helper
```
Creates `.sdlc/hooks/post-finalise` in the target project:
```bash
#!/usr/bin/env bash
# Auto-generated by ai-sdlc-optimizer
OPTIMIZER_BIN="/path/to/ai-sdlc-optimizer/bin/collector.mjs"
if [ -f "$OPTIMIZER_BIN" ]; then
  node "$OPTIMIZER_BIN" --slug "$SDLC_SLUG" --docs "$SDLC_DOCS_DIR" --root "$SDLC_ROOT" >> /tmp/sdlc-collector.log 2>&1 &
fi
```
(Marked executable: `chmod +x .sdlc/hooks/post-finalise`).

### Uninstall / Unplug Hook
```bash
node bin/optimizer.mjs hook uninstall /Volumes/Work/Projects/trials/ai-sdlc-helper
# Or manually:
rm /Volumes/Work/Projects/trials/ai-sdlc-helper/.sdlc/hooks/post-finalise
```
Once removed, `ai-sdlc-helper` has zero operational footprint.

---

## 6. Self-Contained Execution Prompt for the New Repo

Copy and execute the prompt below inside the new repository (`ai-sdlc-optimizer`):

```markdown
Role: Staff Infrastructure & Observability Architect.

Goal:
Implement the complete trace harvesting, secret sanitization, manifest generation, and Git synchronization engine in `ai-sdlc-optimizer`. The engine must accept completed pipeline execution traces from target projects via an unpluggable hook or manual import, redact all credentials and private paths, structure them into an immutable dataset layout, and commit/push them to the optimizer's remote dataset repository. It must also provide CLI commands to install and uninstall the post-finalise hook in target projects.

Deliverables in this repository:
1. `src/collector/harvester.ts`:
   - Scans and extracts `brief.md`, `decisions.md`, `run.out`, `status.json`, `tests.json`, `red.json`, and all agent JSONL files (`logs/*.json`) from the target task's docs directory.
2. `src/collector/sanitizer.ts`:
   - Multi-pass regex engine that redacts API keys (Anthropic, OpenAI, GitHub), Bearer tokens, DB connection strings, and user home directory paths.
3. `src/collector/manifest.ts`:
   - Emits `manifest.json` containing timestamp, target project name, slug, git commit SHA, duration, and SHA-256 checksums of every ingested file.
4. `src/collector/sync.ts`:
   - Stages the new trace into `data/traces/<date>-<slug>/`, performs a git commit, and pushes to remote with exponential backoff retry.
5. `src/cli/hook-manager.ts` and CLI binary `bin/optimizer.mjs`:
   - `hook install <projectPath>`: Writes `.sdlc/hooks/post-finalise` pointing to this repository's collector.
   - `hook uninstall <projectPath>`: Deletes the hook file cleanly.
   - `import <projectPath> <slug>`: Standalone command to manually harvest a historical task without hooks.
6. Test suite (`test/collector.test.ts`):
   - Verifies trace harvesting, secret redaction (asserts 0 unmasked tokens in fixture outputs), manifest integrity, and hook install/uninstall file operations.

Acceptance criteria:
- Sanitizer test must pass against sample logs containing mock API keys, tokens, and home directory strings, confirming 100% redaction.
- Running `node bin/optimizer.mjs import <targetPath> <slug>` successfully extracts traces into `data/traces/` with a valid `manifest.json`.
- Zero dependencies on `ai-sdlc-helper`'s internal packages (uses file system reads only).
```
