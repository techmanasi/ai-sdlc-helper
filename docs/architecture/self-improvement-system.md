# Auto-SDLC Self-Improving Subsystem Architecture

## 1. Executive Summary & Foundational Principles

The Auto-SDLC Self-Improving Subsystem is a closed-loop optimization architecture for `ai-sdlc-helper` inspired by Andrej Karpathy's concept of autoresearch and recursive self-improvement. 

Unlike naive LLM "self-reflection" loops that generate conversational summaries or uncontrollably patch arbitrary application logic, the Auto-SDLC subsystem treats optimization as an empirical search-and-mutate pipeline:
1. **Telemetry Ingestion:** Continuously extract structured telemetry from raw execution traces (`status.json`, `run.out`, and agent JSONL files).
2. **Causal Profiling & Anomaly Detection:** Map execution events against formal stage invariants (distinguishing healthy TDD failures from unexpected defects, permission friction, and latency sinks).
3. **Bounded Candidate Mutation:** Formulate targeted, machine-readable mutations over controlled operational surfaces (prompt steering directives, model/effort routing policies, and gate execution heuristics).
4. **Isolated Benchmark Replay:** Evaluate candidate mutations in ephemeral git worktrees against a frozen baseline portfolio.
5. **Pareto Selection & Promotion:** Accept only mutations that achieve strict non-negative task success with measurable reductions in latency, token consumption, or repair loops.

```
                      ┌──────────────────────────────────────┐
                      │    SDLC Execution (Worktree)         │
                      │  (Spec -> Plan -> Red -> Impl -> ...)│
                      └──────────────────┬───────────────────┘
                                         │ Emits run.out, status.json, *.json
                                         ▼
                      ┌──────────────────────────────────────┐
                      │    Trace Analyzer & Profiler         │
                      │   - Critical Path Latency Breakdown  │
                      │   - Stage Invariant Anomaly Detector │
                      └──────────────────┬───────────────────┘
                                         │ Performance Profile & Anomalies
                                         ▼
                      ┌──────────────────────────────────────┐
                      │      Hypothesis & Mutation Engine    │
                      │   - Prompt Directive Adjustments     │
                      │   - Model/Effort Route Adjustments   │
                      │   - Gate & Runner Policy Mutations   │
                      └──────────────────┬───────────────────┘
                                         │ Candidate Mutation (.json/.patch)
                                         ▼
                      ┌──────────────────────────────────────┐
                      │       Sandbox Benchmark Replayer     │
                      │   - Parallel Ephemeral Worktrees     │
                      │   - Frozen Task Benchmark Portfolio  │
                      └──────────────────┬───────────────────┘
                                         │ Multi-Objective Delta Metrics
                                         ▼
                      ┌──────────────────────────────────────┐
                      │       Pareto Selection Gate          │
                      │   - Zero Regressions (Hard Gate)     │
                      │   - Latency / Token / Retry Win      │
                      └──────────────────┬───────────────────┘
                                         │ Approved Promotion
                                         ▼
                      ┌──────────────────────────────────────┐
                      │   Promoted Policy / Prompt Patch     │
                      └──────────────────────────────────────┘
```

---

## 2. Telemetry Ingestion & Invariant Classification

### 2.1 Raw Telemetry Sources

The profiler processes undigested execution artifacts from each pipeline run:
- **`status.json`:** Lifecycle states (`running`, `paused`, `done`, `failed`), stage progression, active agent, current attempt count, timestamps.
- **`run.out`:** Formatted engine event stream, gate verdicts, test execution summaries, git operations.
- **`logs/<agent>.json`:** Raw JSONL transcripts including:
  - `duration_api_ms`, `ttft_ms`, `ttft_stream_ms`
  - Token breakdown: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `thinking_tokens`
  - `permission_denials`
  - Tool invocation counts and turn sequence
- **`logs/tests.json` & `logs/red.json`:** Test runner counts (passed, failed, skipped, syntax errors, run duration).

### 2.2 Stage Invariant Classifier

The system enforces deterministic expectations for every stage. An event is only a "defect" if it violates its stage invariant:

| Stage | Expected Healthy Outcome | Anomaly / Defect |
|---|---|---|
| **1/6 Spec** | Produces `specs-1.md` or valid `questions.md` with suggestions | Syntactically invalid questions, missing suggested answer, timeout |
| **2/6 Plan** | Produces `plan-1.md` adhering to spec decisions | Missing spec reference, circular dependency in plan steps |
| **3/6 Red Tests** | **Must fail** against source baseline (`tests.failed > 0`, `tests.passed >= 0`) | All tests pass (trivial red tests), syntax/import error, timeout |
| **4/6 Implement** | Iterative progress; final attempt green (`tests.failed === 0`) | Permission denials, editing test files directly, regression of baseline tests |
| **5/6 Test Repair** | Claims $\le 3$ contradictory tests with explicit spec citation | Modifying source code, unlinking test files, claiming valid tests |
| **6/6 Review** | Produces `review-1.md` verdict | Premature merge claim, unreviewed diffs |
| **Finalise** | Clean git commit and PR creation | Uncommitted dirty files, merge conflict, author identity missing |

### 2.3 Critical-Path Latency Breakdown

Total duration $T_{\text{total}}$ is decomposed into 4 discrete components:
$$T_{\text{total}} = T_{\text{agent\_compute}} + T_{\text{subprocess}} + T_{\text{human\_pause}} + T_{\text{overhead}}$$

1. **$T_{\text{agent\_compute}}$:** Agent LLM inference, split into TTFT (time-to-first-token) and generation/thinking time.
2. **$T_{\text{subprocess}}$:** Time spent in local compilers, git commands, and test runners (`npm test`, `pytest`, `cargo test`).
3. **$T_{\text{human\_pause}}$:** Time spent blocked on human interaction (Spec questions, permission approval prompts).
4. **$T_{\text{overhead}}$:** Workspace setup, worktree cloning, and lock acquisition.

---

## 3. Bounded Mutation Grammar

To prevent uncontrolled degradation or security compromise, the optimization engine operates strictly within a typed **Mutation Grammar**. It does *not* write raw code into `src/` without human review; it mutates execution parameters and prompt templates:

### 3.1 Prompt Directives (`PromptMutation`)
Overrides or steers stage prompts to eliminate recurring agent mistakes:
```typescript
interface PromptMutation {
  targetStage: 'spec' | 'plan' | 'red-tests' | 'implement' | 'test-repair' | 'review';
  type: 'prepend_directive' | 'append_constraint' | 'replace_clause';
  key: string;
  directive: string;
}
```
*Example:* If Implement attempt 1 consistently fails because the agent touches test files instead of source files, the mutation generates an `append_constraint`:
`"CRITICAL: Do not modify any files in test/ or src/**/*.test.ts. Only modify implementation files."`

### 3.2 Model & Effort Routing (`ModelPolicyMutation`)
Assigns optimal cost/reasoning tradeoffs per stage based on historical pass rates:
```typescript
interface ModelPolicyMutation {
  stage: 'spec' | 'plan' | 'red-tests' | 'implement' | 'test-repair' | 'review';
  model: 'opus' | 'sonnet' | 'haiku' | 'codex';
  effort: 'low' | 'medium' | 'high';
}
```

### 3.3 Gate & Concurrency Heuristics (`GatePolicyMutation`)
Tunes execution engine operational parameters:
```typescript
interface GatePolicyMutation {
  maxWorkers?: number | 'auto';
  retryFlaky?: boolean;
  maxImplementAttempts?: number;
  fastTestFiltering?: boolean;
}
```

---

## 4. Sandbox Benchmark Replay & Evaluation

### 4.1 Evaluation Portfolio
The optimizer maintains a frozen benchmark portfolio consisting of representative tasks:
1. `bench-01-simple-feature`: Clean greenfield unit implementation.
2. `bench-02-bugfix-regression`: Reproduction of bug with red test and targeted repair.
3. `bench-03-api-refactor`: Multi-file refactor testing dependency boundaries.

### 4.2 Worktree Isolation
Evaluation of candidate mutations is executed inside isolated worktrees created from a reproducible git commit. Evaluated mutations never touch the active working branch.

### 4.3 Pareto Fitness Function

A candidate mutation $M$ is evaluated against baseline $B$ on:
1. **Pass Rate Delta ($\Delta P$):** Must satisfy $\Delta P = P(M) - P(B) \ge 0$. (Strict zero regressions).
2. **Wall-clock Duration Delta ($\Delta T$):** Percentage decrease in runtime $\frac{T(B) - T(M)}{T(B)}$.
3. **Token Consumption Delta ($\Delta C$):** Percentage decrease in cost/tokens $\frac{C(B) - C(M)}{C(B)}$.
4. **Repair Attempt Delta ($\Delta A$):** Reduction in implement retry loops $A(B) - A(M)$.

A mutation is **promoted** only if:
$$\Delta P \ge 0 \quad \text{AND} \quad (\Delta T > 0.05 \lor \Delta C > 0.08 \lor \Delta A > 0)$$
Otherwise, the candidate mutation is **discarded**.

---

## 5. Security & Containment Boundaries

1. **Immutable Invariant Protection:** Red-test red gate requirements cannot be bypassed or softened by any mutation.
2. **Deterministic Versioning:** All promoted mutations are written to `.sdlc/optimizations/history.json` and committed as reviewable configuration artifacts.
3. **Human Kill-Switch:** Setting `SDLC_OPTIMIZER=0` disables all auto-mutations and returns the pipeline to hardcoded defaults.
