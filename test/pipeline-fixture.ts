// A project for pipeline runs, and a stand-in for `claude` that writes what each stage's agent is expected to write.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPipeline, type PipelineOptions } from '../src/pipeline/run.js';
import { tmp, write } from './helpers.js';

/**
 * The stand-in: it tells the stage from the prompt's first words, records the prompt (prompts.txt), its arguments one per
 * line (args-<stage>.txt) and the environment (env-<stage>.txt), runs <fake>/<stage>.sh, and answers like
 * `claude --output-format json`. <fake>/<stage>.deny names a Bash rule: the agent is refused `git push origin main`
 * unless that rule is in its allowed tools. The auditor (no JSON output) prints <fake>/test-audit.out.
 */
const FAKE_CLAUDE = `#!/bin/bash
prompt=""; json=0; tools="|"
args=("$@")
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="$2"; shift 2 ;;
    --output-format) json=1; shift 2 ;;
    --allowedTools) shift; while [ $# -gt 0 ] && [[ "$1" != --* ]]; do tools="$tools$1|"; shift; done ;;
    *) shift ;;
  esac
done
stage=other
case "$prompt" in
  "You are a Requirements Agent"*) stage=spec ;; "You are an Architecture Planner"*) stage=plan ;;
  "You are a QA Engineer"*) stage=red-tests ;; "You are a Senior TDD Developer"*) stage=implement ;;
  "You are a Test Repair Agent"*) stage=test-repair ;; "You are an independent, skeptical Test Auditor"*) stage=test-audit ;;
  "You are a code reviewer"*) stage=review ;;
  "You are an independent, skeptical Conflict Reviewer"*) stage=resolve-review ;; "You are the Conflict Review Judge"*) stage=resolve-judge ;;
esac
printf '== %s\\n%s\\n' "$stage" "$prompt" >> "$FAKE_DIR/prompts.txt"
printf '%s\\n' "\${args[@]}" > "$FAKE_DIR/args-$stage.txt"
echo "$stage" >> "$FAKE_DIR/calls.txt"
env > "$FAKE_DIR/env-$stage.txt"
rc=0
[ ! -f "$FAKE_DIR/$stage.sh" ] || bash "$FAKE_DIR/$stage.sh" || rc=$?
if [ "$json" -eq 0 ]; then cat "$FAKE_DIR/$stage.out" 2>/dev/null || echo "VERDICT: VALID"; exit $rc; fi
denials='[]'
if [ -f "$FAKE_DIR/$stage.deny" ] && [[ "$tools" != *"|$(cat "$FAKE_DIR/$stage.deny")|"* ]]; then
  denials='[{"tool_name":"Bash","tool_use_id":"t1","tool_input":{"command":"git push origin main"}}]'
fi
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"$stage done\\",\\"permission_denials\\":$denials}"
exit $rc
`;

export const SLUG = 'add-sum';
export const DOCS = `work/items/${SLUG}`;
export const LOG = `${DOCS}/logs`;
/** node:test on every Node the tool supports (globs in --test need Node 21). */
export const NODE_TEST = Number(process.versions.node.split('.')[0]) >= 21 ? 'node --test "src/**/*.test.mjs"' : 'node --test src/';

export const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
export const read = (dir: string, f: string): string => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8') : '');

/** What each stage's stand-in agent writes, by default: a passing cycle that adds sum(a, b). */
export const STAGES: Record<string, string> = {
  spec: 'echo "spec" > "$FAKE_DOCS/specs-1.md"',
  plan: 'echo "plan" > "$FAKE_DOCS/plan-1.md"',
  'red-tests': `echo "cases" > "$FAKE_DOCS/test-cases-1.md"
printf "import { test } from 'node:test';\\nimport assert from 'node:assert/strict';\\nimport { sum } from './sum.mjs';\\ntest('sum adds', () => assert.equal(sum(2, 3), \${FAKE_EXPECT:-5}));\\n" > src/sum.test.mjs`,
  implement: `n=$(ls "$FAKE_DIR" | grep -c "^seen-tests-" || true)\ncp "$FAKE_LOG/tests.log" "$FAKE_DIR/seen-tests-$n.log" 2>/dev/null || true
[ -z "\${FAKE_NO_IMPL:-}" ] || exit 0
printf 'export const sum = (a, b) => a + b;\\n' > src/sum.mjs
[ -z "\${FAKE_CLAIM:-}" ] || echo "src/sum.test.mjs :: sum adds :: contradicts the spec decision (sum(2, 3) is 5)" > "$FAKE_DOCS/test-issues.md"
[ -z "\${FAKE_TOUCH_TEST:-}" ] || echo "// edited" >> src/sum.test.mjs
[ -z "\${FAKE_FLAKY:-}" ] || rm -f "$FAKE_FLAKY"`,
  'test-repair': `[ -z "\${FAKE_REPAIR_FAILS:-}" ] || exit 1
sed -i.bak 's/sum(2, 3), 6/sum(2, 3), 5/' src/sum.test.mjs && rm -f src/sum.test.mjs.bak
echo "sum adds: expected 6, the spec says 5; changed the expected value" > "$FAKE_DOCS/test-repair-1.md"`,
  review: 'echo "reviewed" > "$FAKE_DOCS/review-1.md"',
};

export interface Fixture { dir: string; fake: string; bin: string }

let template: string | null = null;
/** The project once: node:test with tests beside the source, another backlog folder and branch prefix. */
function buildTemplate(): string {
  const dir = path.join(tmp('sdlc-pipe-tpl-'), 'repo');
  const files: Record<string, unknown> = {
    'package.json': { name: 'demo', private: true, type: 'module', scripts: { test: NODE_TEST } },
    'sdlc.config.json': {
      backlogDir: 'work/items', git: { branchPrefix: 'feature/' }, agent: { codeSearch: 'none' }, ui: { timezone: 'UTC' },
      suites: [{ name: 'app', dir: '.', runner: 'node-test', testCmd: NODE_TEST, testGlobs: ['src/**/*.test.mjs'] }],
    },
    '.gitignore': 'work/items/*/logs/\n',
    'src/existing.mjs': 'export const one = () => 1;\n',
    'src/existing.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { one } from './existing.mjs';\ntest('one is 1', () => assert.equal(one(), 1));\n",
    'src/flaky.test.mjs': "import fs from 'node:fs';\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
      + "test('sometimes slow', () => {\n  const f = process.env.FAKE_FLAKY;\n  if (f && !fs.existsSync(f)) { fs.writeFileSync(f, ''); assert.fail('timed out under load'); }\n});\n",
    [`${DOCS}/../index.md`]: `# Backlog\n\n- [ ] \`${SLUG}\` - Feature: add numbers\n- [ ] \`other\` - Feature: later\n`,
    [`${DOCS}/brief.md`]: `# ${SLUG}\n\nAdd sum(a, b).\n`,
  };
  for (const [f, v] of Object.entries(files)) write(dir, path.normalize(f), typeof v === 'string' ? v : `${JSON.stringify(v, null, 2)}\n`);
  git(dir, 'init', '-q', '-b', 'main');
  // No background maintenance or gc: they create and delete files in .git while the template is copied.
  git(dir, 'config', 'maintenance.auto', 'false');
  git(dir, 'config', 'gc.auto', '0');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', '/dev/null');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** A fresh copy of the project, with the stand-in on PATH and <stages> (the defaults, overridden) for its agents. */
export function fixture(stages: Record<string, string | null> = {}): Fixture {
  if (!template) template = buildTemplate();
  const base = tmp('sdlc-pipe-');
  const dir = path.join(base, 'repo');
  fs.cpSync(template, dir, { recursive: true });
  const fake = path.join(base, 'fake');
  const bin = path.join(fake, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  for (const [stage, script] of Object.entries({ ...STAGES, ...stages })) {
    if (script !== null) fs.writeFileSync(path.join(fake, `${stage}.sh`), `set -e\n${script}\n`);
  }
  return { dir, fake, bin };
}

/** The test process's environment without anything that steers a run (models, providers, FROM, CI, limits). */
export function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SDLC_|MODEL_|EFFORT_|ANTHROPIC_|AI_SDLC_HELPER_|MAX_|FAKE_)/.test(k) && !['FROM', 'CI', 'NODE_OPTIONS'].includes(k)));
  return { ...env, ...extra };
}

export interface Run { status: number; stdout: string; stderr: string; prompts: string; calls: string[] }

/** Runs the pipeline in-process in the fixture, with the stand-in first on PATH. */
export async function pipeline(f: Fixture, env: NodeJS.ProcessEnv = {}, opts: Partial<PipelineOptions> = {}): Promise<Run> {
  let stdout = '';
  let stderr = '';
  fs.rmSync(path.join(f.fake, 'calls.txt'), { force: true });
  const status = await runPipeline({
    cwd: f.dir, slug: SLUG, testFileCmd: 'ai-sdlc-helper run --file',
    env: cleanEnv({
      FAKE_DIR: f.fake, FAKE_DOCS: DOCS, FAKE_LOG: LOG, PATH: `${f.bin}:${process.env.PATH}`,
      AI_SDLC_HELPER_MODELS_FILE: path.join(f.fake, 'no-models.json'), ...env,
    }),
    out: l => { stdout += `${l}\n`; }, err: l => { stderr += `${l}\n`; },
    ...opts,
  });
  await new Promise(resolve => setImmediate(resolve));
  return { status, stdout, stderr, prompts: read(f.fake, 'prompts.txt'), calls: read(f.fake, 'calls.txt').split('\n').filter(Boolean) };
}

/** The commit subjects on the branch since main, newest first. */
export const subjects = (dir: string): string[] => git(dir, 'log', '--format=%s', 'main..HEAD').split('\n').filter(Boolean);
export const filesIn = (dir: string, ref: string): string[] => git(dir, 'show', '--name-only', '--format=', ref).split('\n').filter(Boolean).sort();
export const statusOf = (dir: string): Record<string, any> => JSON.parse(read(dir, `${LOG}/status.json`));
