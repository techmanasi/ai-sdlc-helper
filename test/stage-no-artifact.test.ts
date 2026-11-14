import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { fixture, pipeline, read } from './pipeline-fixture.js';

// A run is a chain of git and test subprocesses: give the runner room to report.
vi.setConfig({ testTimeout: 60_000 });

describe('a stage whose agent wrote no artifact', () => {
  test('Spec says what the agent said and where its log is, instead of stopping blankly', async () => {
    const f = fixture({ spec: 'true' });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Spec not produced: spec-1 said "spec done" (see work/items/add-sum/logs/spec-1.log)');
    // A claude stage has the Read/Grep/Glob tools, and its prompt says the shell is refused: the codex rules would mislead it.
    expect(r.prompts).toContain('read files with the Read tool');
    expect(r.prompts).not.toContain('no Read/Grep/Glob tools');
  });

  test('Plan does the same', async () => {
    const f = fixture({ plan: 'true' });
    const r = await pipeline(f);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Plan not produced: plan said "plan done" (see work/items/add-sum/logs/plan.log)');
  });

  test('a codex stage is told to read with its shell, and its JSONL answer is read and quoted', async () => {
    const f = fixture({ spec: 'true' });
    fs.writeFileSync(path.join(f.bin, 'codex'), `#!/bin/bash
printf '%s\\n' "$@" > "$FAKE_DIR/codex-args.txt"
printf '%s\\n' '{"type":"thread.started","thread_id":"t1"}'
printf '%s\\n' '{"type":"turn.started"}'
printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"stub codex"}}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'
`, { mode: 0o755 });
    const r = await pipeline(f, { AGENT_SPEC: 'codex' });
    expect(r.status).toBe(1);
    const args = read(f.fake, 'codex-args.txt');
    expect(args).toContain('read files with the shell (rg, sed -n, cat, git show)');
    expect(args).toContain('You are a Requirements Agent');
    // codex has no Read/Grep/Glob, and it reads for real with the shell: the rule refusing those commands must be gone.
    expect(args).toContain('To check one test file, run');
    expect(args).not.toContain('Do not use cat');
    // The JSONL answer is a real answer (no empty-answer warning), and the stop quotes it.
    expect(r.stdout).not.toContain('empty answer');
    expect(r.stdout).toContain('Spec not produced: spec-1 said "stub codex"');
  });
});
