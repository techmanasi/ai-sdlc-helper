import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { snapshot } from '../src/changes/index.js';
import { Git } from '../src/pipeline/git.js';
import { envModels, providerEnv, resolveProvider, stageModel, stageModels, type ModelEnv } from '../src/pipeline/models.js';
import { manualInput, renderPrompt } from '../src/pipeline/prompts.js';
import { ship } from '../src/pipeline/ship.js';
import { Status } from '../src/pipeline/status.js';
import { autoAcceptQuestions, formatCheckFailures, isAutoAccept } from '../src/pipeline/stages.js';
import type { AgentRequest } from '../src/pipeline/agent.js';
import { tmp, write } from './helpers.js';
import { DOCS, SLUG, fixture, pipeline, read, statusOf } from './pipeline-fixture.js';

afterEach(() => new Promise<void>(resolve => { setImmediate(resolve); }));
vi.setConfig({ testTimeout: 300_000 });

const PROVIDER_ENV = {
  SDLC_PROVIDERS: 'openrouter, local',
  SDLC_PROVIDER_OPENROUTER_ENDPOINT: 'https://gw.example/api',
  SDLC_PROVIDER_OPENROUTER_API_KEY: 'sk-secret-1',
  SDLC_PROVIDER_OPENROUTER_MODELS: 'openai/gpt-5,google/gemini-2.5-pro',
  SDLC_PROVIDER_LOCAL_ENDPOINT: 'http://localhost:4000',
  SDLC_PROVIDER_LOCAL_API_KEY: 'sk-local',
  SDLC_PROVIDER_LOCAL_MODELS: 'llama3:8b',
  SDLC_PROVIDER_LOCAL_EFFORT: 'yes',
};
const KEY = 'sk-reg-secret-1';
const REG = { reg: { endpoint: 'https://reg.example/api', api_key_env: 'REG_KEY', models: ['m1', 'org/m2'], effort: false } };

const regDir = () => tmp('sdlc-reg-');
const menv = (env: NodeJS.ProcessEnv, providers?: unknown, fromFile = {}): ModelEnv => {
  const file = path.join(regDir(), 'models.json');
  if (providers !== undefined) fs.writeFileSync(file, typeof providers === 'string' ? providers : JSON.stringify({ providers }));
  return { env, fromFile, registryFile: file };
};
const errorOf = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };
const brief = (p: { active: boolean; model: string; endpoint: string; key: string; effortFlag: boolean }) => `${p.active ? 1 : 0}|${p.model}|${p.endpoint}|${p.key}|${p.effortFlag ? 1 : 0}`;

describe('model and provider resolution', () => {
  test('an Anthropic model needs nothing; provider/model splits on the first slash; _EFFORT=yes passes --effort', () => {
    expect(brief(resolveProvider('opus', 'review', menv(PROVIDER_ENV)))).toBe('0|opus|||1');
    expect(brief(resolveProvider('openrouter/openai/gpt-5', 'implement', menv(PROVIDER_ENV)))).toBe('1|openai/gpt-5|https://gw.example/api|sk-secret-1|0');
    expect(resolveProvider('local/llama3:8b', 'implement', menv(PROVIDER_ENV)).effortFlag).toBe(true);
  });

  test('an unlisted provider or model, and a provider without endpoint or key, say what to configure', () => {
    expect(errorOf(() => resolveProvider('acme/foo', 'plan', menv(PROVIDER_ENV)))).toBe("ERROR: model 'acme/foo' (stage plan): provider 'acme' is not listed in SDLC_PROVIDERS (see .env.example)");
    expect(errorOf(() => resolveProvider('openrouter/other', 'plan', menv(PROVIDER_ENV))))
      .toBe("ERROR: model 'other' (stage plan) is not in SDLC_PROVIDER_OPENROUTER_MODELS (allowed: openai/gpt-5,google/gemini-2.5-pro)");
    expect(errorOf(() => resolveProvider('openrouter/openai/gpt-5', 'plan', menv({ ...PROVIDER_ENV, SDLC_PROVIDER_OPENROUTER_API_KEY: '' }))))
      .toBe('ERROR: provider \'openrouter\' (stage plan) needs SDLC_PROVIDER_OPENROUTER_ENDPOINT and SDLC_PROVIDER_OPENROUTER_API_KEY');
  });

  test('the registry wins as a whole for a provider it lists; its key comes from the variable it names, never from .env', () => {
    expect(brief(resolveProvider('reg/org/m2', 'implement', menv({ REG_KEY: KEY }, REG)))).toBe(`1|org/m2|https://reg.example/api|${KEY}|0`);
    expect(resolveProvider('reg/m1', 'implement', menv({ REG_KEY: KEY }, { reg: { ...REG.reg, effort: true } })).effortFlag).toBe(true);
    const both = { REG_KEY: KEY, SDLC_PROVIDERS: 'openrouter', SDLC_PROVIDER_OPENROUTER_ENDPOINT: 'https://env.example', SDLC_PROVIDER_OPENROUTER_API_KEY: 'sk-env', SDLC_PROVIDER_OPENROUTER_MODELS: 'only-env' };
    const reg = { openrouter: { ...REG.reg, models: ['only-reg'] } };
    expect(brief(resolveProvider('openrouter/only-reg', 'plan', menv(both, reg)))).toBe(`1|only-reg|https://reg.example/api|${KEY}|0`);
    expect(errorOf(() => resolveProvider('openrouter/only-env', 'plan', menv(both, reg)))).toContain("model 'only-env' (stage plan) is not in the registry models of provider 'openrouter' (allowed: only-reg)");
    for (const env of [{}, { REG_KEY: '' }]) {
      expect(errorOf(() => resolveProvider('reg/m1', 'implement', menv(env, REG))))
        .toBe("ERROR: provider 'reg' (stage implement): key variable REG_KEY is not set in the environment (export it; .env is not read for a registry provider)");
    }
    expect(errorOf(() => resolveProvider('reg/m1', 'implement', menv({}, REG, { REG_KEY: KEY })))).toContain('REG_KEY is not set');
  });

  test('a broken registry fails the run at the start and on any provider model; Anthropic models never read it', () => {
    const broken = menv({}, '{ broken');
    expect(errorOf(() => stageModels(broken))).toBe(`${broken.registryFile}: not valid JSON`);
    expect(errorOf(() => resolveProvider('reg/m1', 'plan', broken))).toBe(`ERROR: model registry: ${broken.registryFile}: not valid JSON`);
    expect(resolveProvider('sonnet', 'plan', broken).model).toBe('sonnet');
    expect(stageModels(menv({}))).toMatchObject({ spec: { model: 'opus', effort: 'medium' }, 'test-audit': { model: 'opus', effort: 'medium' } });
  });

  test('stage values win over SDLC_MODEL/SDLC_EFFORT, which win over the defaults; a bad effort is refused', () => {
    const env = { SDLC_MODEL: 'haiku', SDLC_EFFORT: 'low', MODEL_RED_TESTS: 'opus', EFFORT_TEST_AUDIT: 'max' };
    expect([stageModel('red-tests', menv(env)), stageModel('test-audit', menv(env))].map(s => `${s.model} ${s.effort}`)).toEqual(['opus low', 'haiku max']);
    expect(errorOf(() => stageModel('plan', menv({ EFFORT_PLAN: 'huge' })))).toBe("ERROR: invalid effort 'huge' for stage plan (use low, medium, high, xhigh or max)");
  });

  test('envModels reads only SDLC_PROVIDER* keys from .env, strips quotes, and the shell wins', () => {
    const dir = tmp('sdlc-env-');
    expect(envModels(dir, {})).toEqual({});
    fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://x\nSDLC_PROVIDERS="openrouter"\nSDLC_PROVIDER_OPENROUTER_API_KEY=\'k-1\'\nSDLC_PROVIDER_X_MODELS=a\nADMIN_TOKEN=t\n');
    expect(envModels(dir, { SDLC_PROVIDER_X_MODELS: 'shell' })).toEqual({ SDLC_PROVIDERS: 'openrouter', SDLC_PROVIDER_OPENROUTER_API_KEY: 'k-1' });
    expect(brief(resolveProvider('openrouter/m', 'plan', menv({}, undefined, { SDLC_PROVIDERS: 'openrouter', SDLC_PROVIDER_OPENROUTER_ENDPOINT: 'https://e', SDLC_PROVIDER_OPENROUTER_API_KEY: 'k-1', SDLC_PROVIDER_OPENROUTER_MODELS: 'm' }))))
      .toBe('1|m|https://e|k-1|0');
  });

  test('providerEnv points claude at the endpoint and empties the Anthropic key', () => {
    expect(providerEnv(resolveProvider('opus', 'plan', menv({})))).toEqual({});
    expect(providerEnv(resolveProvider('openrouter/openai/gpt-5', 'plan', menv(PROVIDER_ENV)))).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example/api', ANTHROPIC_AUTH_TOKEN: 'sk-secret-1', ANTHROPIC_API_KEY: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'openai/gpt-5', ANTHROPIC_SMALL_FAST_MODEL: 'openai/gpt-5',
    });
  });
});

describe('models in a run', () => {
  test('a custom provider reaches only the agent: bare model name, no --effort, its endpoint and key; status keeps the full name', async () => {
    const f = fixture();
    const seen: AgentRequest[] = [];
    // a stand-in spawn: records the request and answers like claude, without starting a process
    const spawnAgent = async (req: AgentRequest) => {
      seen.push(req);
      fs.writeFileSync(req.stdout, JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', permission_denials: [] }));
      fs.writeFileSync(req.stderr, '');
      if (req.args[1].startsWith('You are a Requirements Agent')) fs.writeFileSync(path.join(f.dir, DOCS, 'questions.md'), '### Q1: x\n**Answer:**\n');
      return 0;
    };
    const r = await pipeline(f, { ...PROVIDER_ENV, MODEL_SPEC: 'openrouter/openai/gpt-5', ANTHROPIC_API_KEY: 'sk-ant-real' }, { spawnAgent });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('   model=openrouter/openai/gpt-5 (provider without effort)');
    expect(r.stdout + r.stderr).not.toContain('sk-secret-1');
    expect(seen).toHaveLength(1);
    expect(seen[0].args.slice(2, 4)).toEqual(['--model', 'openai/gpt-5']);
    expect(seen[0].args).not.toContain('--effort');
    expect(seen[0].env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gw.example/api', ANTHROPIC_AUTH_TOKEN: 'sk-secret-1', ANTHROPIC_API_KEY: '' });
    expect(seen[0].cwd).toBe(fs.realpathSync(f.dir));
    expect(statusOf(f.dir).models.spec).toEqual({ model: 'openrouter/openai/gpt-5', effort: 'medium' });
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test('a bad model setting fails the run before any agent, with status failed', async () => {
    const f = fixture();
    const r = await pipeline(f, { EFFORT_REVIEW: 'extreme' });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("ERROR: invalid effort 'extreme' for stage review (use low, medium, high, xhigh or max)\n");
    expect(r.calls).toEqual([]);
    expect(statusOf(f.dir)).toMatchObject({ slug: SLUG, state: 'failed', stage: '' });
  });
});

describe('prompts', () => {
  const prompts = (files: Record<string, string>) => {
    const dir = tmp('sdlc-prompts-');
    for (const [f, t] of Object.entries(files)) write(dir, f, t);
    return dir;
  };

  test('the tool rules are appended with their placeholders filled; {{CODE_SEARCH}} takes the guide, & kept as written', () => {
    const dir = prompts({ 'prompt-demo.md': 'Do {{SLUG}} in {{DOCS}}. {{CODE_SEARCH}} Then {{UNKNOWN}}.\n\n', 'parts/tools.md': 'Run only {{TEST_CMD}} or {{TEST_FILE_CMD}} <f>.\n' });
    const values = { SLUG: 's', DOCS: 'd', TEST_CMD: 'npm test', TEST_FILE_CMD: 'ai-sdlc-helper run --file' };
    expect(renderPrompt('demo', values, 'GRAFT & more', dir)).toBe('Do s in d. GRAFT & more Then {{UNKNOWN}}.\n\nRun only npm test or ai-sdlc-helper run --file <f>.');
    fs.rmSync(path.join(dir, 'parts/tools.md'));
    write(dir, 'parts/code-search.md', 'GREP-PART\n');
    expect(renderPrompt('demo', values, '', dir)).toBe('Do s in d. GREP-PART Then {{UNKNOWN}}.');
    fs.rmSync(path.join(dir, 'parts/code-search.md'));
    expect(errorOf(() => renderPrompt('demo', values, '', dir))).toBe(`ERROR: missing prompt part ${path.join(dir, 'parts/code-search.md')}`);
    expect(errorOf(() => renderPrompt('nope', values, '', dir))).toBe(`ERROR: missing prompt file ${path.join(dir, 'prompt-nope.md')}`);
  });

  test('every shipped stage prompt renders without a placeholder left', () => {
    const values = Object.fromEntries(['DOCS', 'LOG', 'TEST_DIR', 'TEST_CMD', 'TEST_FILE_CMD', 'RED_SHA', 'SLUG', 'TEST_FRAMEWORK', 'TEST_FILES', 'FETCH_CMD'].map(k => [k, `<${k}>`]));
    for (const st of ['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'test-audit', 'review']) {
      expect(renderPrompt(st, values, 'GUIDE')).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  test('manual input: only the requested section, as binding input; nothing when the file, the section or its text is missing', () => {
    const dir = tmp('sdlc-mi-');
    expect(manualInput(dir, 'plan', 'src')).toBe('');
    fs.writeFileSync(path.join(dir, 'manual-inputs.md'), '## plan\nUse a queue.\n\n## implement\nKeep it small.\nNo new deps.\n\n## review\n   \n');
    const out = manualInput(dir, 'implement', 'server/__tests__');
    expect(out).toBe('\n\nMANUAL INPUT from the developer for this stage (binding; it cannot override the rule about editing server/__tests__/ or any other rule above):\nKeep it small.\nNo new deps.');
    expect(manualInput(dir, 'review', 'src')).toBe('');
    expect(manualInput(dir, 'spec', 'src')).toBe('');
  });
});

describe('status file', () => {
  test('one JSON line with the shell pipeline\'s fields, replaced on every write', () => {
    const file = path.join(tmp('sdlc-status-'), 'status.json');
    const s = new Status(file, 'alpha', 42);
    s.stage = 'Implement';
    s.attempt = '1/4';
    s.write();
    s.write();
    const text = fs.readFileSync(file, 'utf8');
    expect(text.split('\n')).toHaveLength(2);
    expect(JSON.parse(text)).toMatchObject({ slug: 'alpha', state: 'running', stage: 'Implement', attempt: '1/4', models: {}, pid: 42 });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe('Ship', () => {
  const sh = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  const put = (dir: string, f: string, text = 'x\n') => write(dir, f, text);
  function repo() {
    const dir = tmp('sdlc-ship-');
    sh(dir, 'init', '-q');
    sh(dir, 'config', 'user.email', 't@t');
    sh(dir, 'config', 'user.name', 't');
    sh(dir, 'config', 'commit.gpgsign', 'false');
    sh(dir, 'config', 'core.hooksPath', '.git/hooks');
    put(dir, '.gitignore', '.env\nserver/.env\nDocs/backlog/*/logs/\n');
    put(dir, 'Docs/backlog/index.md', '- [ ] `alpha` - thing\n');
    put(dir, 'Docs/backlog/alpha/brief.md');
    put(dir, 'README.md', 'r\n');
    put(dir, 'dev.txt', 'dev\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'init');
    return dir;
  }
  const BASE = 'Docs/backlog/alpha/logs/baseline.json';
  const baseline = (dir: string) => snapshot(path.join(dir, BASE), { root: dir });
  const doShip = (dir: string) => {
    let out = '';
    const n = ship({ git: new Git(dir), slug: 'alpha', docs: 'Docs/backlog/alpha', baseline: BASE, backlog: 'Docs/backlog/index.md', out: l => { out += `${l}\n`; }, err: l => { out += `${l}\n`; } });
    return { n, out };
  };
  const log = (dir: string) => sh(dir, 'log', '--format=%s').stdout.trim().split('\n');

  test('commits changes anywhere in one feat commit, lists them in the body, and ticks the backlog in its own commit', () => {
    const dir = repo();
    baseline(dir);
    put(dir, 'scripts/new.sh');
    put(dir, 'README.md', 'changed\n');
    put(dir, 'server/a.js');
    const r = doShip(dir);
    expect(log(dir).slice(0, 2)).toEqual(['chore(backlog): mark alpha done', 'feat(alpha): implement per Docs/backlog/alpha/specs-1.md']);
    const body = sh(dir, 'log', '-2', '--format=%b').stdout;
    for (const f of ['scripts/new.sh', 'README.md', 'server/a.js']) expect(body).toContain(f);
    expect(sh(dir, 'status', '--porcelain').stdout).toBe('');
    expect(r.n).toBe(3);
    expect(r.out).toContain('DONE: alpha on ');
    expect(r.out).toContain('Committed 3 file(s), skipped 0 (see Docs/backlog/alpha/logs/finalise-skipped.md).');
  });

  test('files dirty or staged before the run stay as they were; .env.local is skipped and listed; new .env keys reach .env.example', () => {
    const dir = repo();
    put(dir, 'mine.txt', 'untracked\n');
    put(dir, 'dev.txt', 'modified\n');
    put(dir, 'staged.txt');
    sh(dir, 'add', 'staged.txt');
    put(dir, '.env', 'A=1\n');
    baseline(dir);
    put(dir, 'server/a.js');
    put(dir, 'server/.env.local', 'SECRET=1\n');
    put(dir, '.env', 'A=1\nTOKEN=topsecret\n');
    const r = doShip(dir);
    expect(sh(dir, 'status', '--porcelain').stdout.split('\n').filter(Boolean).sort()).toEqual([' M dev.txt', '?? mine.txt', '?? server/.env.local', 'A  staged.txt'].sort());
    expect(sh(dir, 'show', '--name-only', '--format=', 'HEAD~1').stdout).not.toContain('staged.txt');
    expect(read(dir, 'Docs/backlog/alpha/logs/finalise-skipped.md')).toBe('- server/.env.local: sensitive file\n');
    expect(r.out).toContain('Skipped:\n- server/.env.local: sensitive file\n');
    const example = sh(dir, 'show', 'HEAD~1:.env.example').stdout;
    expect(example).toContain('TOKEN=change-me');
    expect(example).not.toContain('topsecret');
  });

  test('warns with nothing to commit, with a slug missing from the backlog, and with a backlog file dirty at baseline', () => {
    let dir = repo();
    baseline(dir);
    let r = doShip(dir);
    expect(r.out).toContain('WARNING: nothing to commit');
    expect(log(dir).some(s => s.startsWith('feat('))).toBe(false);

    dir = repo();
    put(dir, 'Docs/backlog/index.md', '- [ ] `other` - x\n- [ ] `alpha-2` - y\n');
    sh(dir, 'commit', '-q', '-am', 'swap');
    baseline(dir);
    put(dir, 'server/a.js');
    r = doShip(dir);
    expect(r.out).toContain('WARNING: alpha not found in Docs/backlog/index.md; not ticked');
    expect(log(dir).some(s => s.startsWith('chore(backlog)'))).toBe(false);

    dir = repo();
    put(dir, 'Docs/backlog/index.md', '- [ ] `alpha` - thing\n# mine\n');
    baseline(dir);
    put(dir, 'server/a.js');
    r = doShip(dir);
    expect(read(dir, 'Docs/backlog/index.md')).toBe('- [x] `alpha` - thing\n# mine\n');
    expect(log(dir).some(s => s.startsWith('chore(backlog)'))).toBe(false);
    expect(r.out).toContain('WARNING: Docs/backlog/index.md had local changes before the run; ticked alpha but not committed');
  });

  test('a failing commit throws', () => {
    const dir = repo();
    baseline(dir);
    put(dir, 'server/a.js');
    fs.mkdirSync(path.join(dir, '.git/hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(() => doShip(dir)).toThrow(/git commit/);
  });
});

describe('auto-accept helpers', () => {
  test('isAutoAccept returns true for 1, true, yes, and false otherwise', () => {
    expect(isAutoAccept({ env: { SDLC_AUTO_ACCEPT: '1' } } as any)).toBe(true);
    expect(isAutoAccept({ env: { SDLC_AUTO_ACCEPT: 'true' } } as any)).toBe(true);
    expect(isAutoAccept({ env: { SDLC_AUTO_ACCEPT: 'yes' } } as any)).toBe(true);
    expect(isAutoAccept({ env: { SDLC_AUTO_ACCEPT: '0' } } as any)).toBe(false);
    expect(isAutoAccept({ env: { SDLC_AUTO_ACCEPT: 'false' } } as any)).toBe(false);
    expect(isAutoAccept({ env: {} } as any)).toBe(false);
  });

  test('autoAcceptQuestions fills every Answer line with accept', () => {
    const qFile = path.join(tmp('sdlc-auto-'), 'questions.md');
    fs.mkdirSync(path.dirname(qFile), { recursive: true });
    fs.writeFileSync(qFile, '### Q1: Database\nWhich DB?\n**Suggested:** Postgres\n**Answer:**\n\n### Q2: Port\nWhich port?\n**Suggested:** 3000\n**Answer:**\n');
    autoAcceptQuestions(qFile);
    const content = fs.readFileSync(qFile, 'utf8');
    expect(content).toContain('### Q1: Database\nWhich DB?\n**Suggested:** Postgres\n**Answer:** accept');
    expect(content).toContain('### Q2: Port\nWhich port?\n**Suggested:** 3000\n**Answer:** accept');
  });
});

describe('failure reason reporting', () => {
  test('formatCheckFailures extracts failed tests and suite errors from tests.json', () => {
    const dir = tmp('sdlc-fail-');
    const log = path.join(dir, 'logs');
    fs.mkdirSync(log, { recursive: true });
    const testsJson = path.join(log, 'tests.json');
    fs.writeFileSync(testsJson, JSON.stringify({
      suiteErrors: [{ file: 'test/bad.test.ts', message: 'SyntaxError: Unexpected token' }],
      tests: [
        { file: 'test/a.test.ts', name: 'adds numbers', status: 'passed' },
        { file: 'test/b.test.ts', name: 'handles error', status: 'failed', message: 'AssertionError: expected 1 to be 2\n  at ...' },
      ],
    }));
    const ctx = { root: dir, log: 'logs', failLog: '' } as any;
    const fails = formatCheckFailures(ctx);
    expect(fails).toHaveLength(2);
    expect(fails[0]).toBe('ERROR: suite test/bad.test.ts failed to run: SyntaxError: Unexpected token');
    expect(fails[1]).toContain('FAIL: test/b.test.ts :: handles error (AssertionError: expected 1 to be 2)');
  });

  test('formatCheckFailures falls back to failLog when tests.json is missing or empty', () => {
    const dir = tmp('sdlc-fail-');
    const failFile = path.join(dir, 'test.err');
    fs.writeFileSync(failFile, 'FAIL: test/c.test.ts\nAssertionError: boom\n');
    const ctx = { root: dir, log: 'logs', failLog: 'test.err' } as any;
    const fails = formatCheckFailures(ctx);
    expect(fails).toContain('FAIL: test/c.test.ts');
  });
});
