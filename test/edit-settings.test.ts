// Changing a project's setup after it was added: the validated write path, the agent per stage, and what uses it.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { agentSources, mergeAgent } from '../src/config/personal.js';
import { pipelineEnv, runContext } from '../src/runs/index.js';
import { applyPatch, editOverrides, editSettings, hashOf } from '../src/config/edit.js';
import { EFFORT_LEVELS, HARNESS_IDS, agentFor, harnessFor, resolve } from '../src/config/settings.js';
import { DefaultHarnessRegistry } from '../src/pipeline/harness/registry.js';
import type { AgentRequest } from '../src/pipeline/agent.js';
import { readRegistry, writeRegistry } from '../src/registry/projects.js';
import { doctor } from '../src/registry/doctor.js';
import { project, run, tmp } from './helpers.js';
import { DOCS, fixture, pipeline } from './pipeline-fixture.js';

const SUITE = { dir: '.', runner: 'vitest', testCmd: 'vitest run' };
const read = (dir: string) => fs.readFileSync(path.join(dir, 'sdlc.config.json'), 'utf8');
const config = (extra: Record<string, unknown> = {}) => ({ suites: [SUITE], agent: { codeSearch: 'none' }, lint: 'npm run lint', ...extra });

describe('editing sdlc.config.json', () => {
  test('a valid harness changes only that key; the indentation, other keys and their order stay', () => {
    const dir = project({ 'sdlc.config.json': `${JSON.stringify(config(), null, 4)}\n` });
    const r = editSettings(dir, { agent: { harness: 'codex' } });
    expect(r.ok).toBe(true);
    const text = read(dir);
    expect(JSON.parse(text)).toEqual(config({ agent: { codeSearch: 'none', harness: 'codex' } }));
    expect(Object.keys(JSON.parse(text))).toEqual(['suites', 'agent', 'lint']);
    expect(text.startsWith('{\n    "suites"')).toBe(true);
    expect(r.hash).toBe(hashOf(text));
    expect(resolve(dir).config?.agent.harness).toBe('codex');
  });

  test('a stage can be given an agent and set back to the default; an emptied map leaves no key behind', () => {
    const dir = project({ 'sdlc.config.json': config() });
    expect(editSettings(dir, { agent: { stages: { review: { harness: 'agy', model: 'gemini-3.8-pro' }, implement: { harness: 'codex', effort: 'high' } } } }).ok).toBe(true);
    expect(resolve(dir).config?.agent.stages).toEqual({ review: { harness: 'agy', model: 'gemini-3.8-pro' }, implement: { harness: 'codex', effort: 'high' } });
    expect(editSettings(dir, { agent: { stages: { review: { harness: null, model: null }, implement: { harness: null, effort: null } } } }).ok).toBe(true);
    expect(JSON.parse(read(dir)).agent).toEqual({ codeSearch: 'none' });
  });

  test('an unknown harness, stage or key is refused with the CLI\'s wording and the file is not touched', () => {
    const dir = project({ 'sdlc.config.json': config() });
    const before = read(dir);
    expect(editSettings(dir, { agent: { harness: 'gpt' } }).errors)
      .toEqual(['sdlc.config.json: agent.harness: must be one of claude, agy, codex (got "gpt")']);
    expect(editSettings(dir, { agent: { stages: { review: { harness: 'gpt' } } } }).errors)
      .toEqual(['sdlc.config.json: agent.stages.review.harness: must be one of claude, agy, codex (got "gpt")']);
    expect(editSettings(dir, { agent: { effort: 'turbo' } }).errors)
      .toEqual(['sdlc.config.json: agent.effort: must be one of low, medium, high, xhigh, max (got "turbo")']);
    expect(editSettings(dir, { agent: { stages: { deploy: { model: 'opus' } } } }).errors)
      .toEqual([expect.stringContaining('agent.stages.deploy: unknown stage (one of spec, plan,')]);
    expect(editSettings(dir, { agentt: {} }).errors).toEqual(['sdlc.config.json: agentt: unknown setting']);
    expect(read(dir)).toBe(before);
  });

  test('a save that carries an out-of-date hash is refused and the file is not touched', () => {
    const dir = project({ 'sdlc.config.json': config() });
    const opened = hashOf(read(dir));
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), `${JSON.stringify(config({ lint: 'npm run other' }))}\n`);
    const edited = read(dir);
    const r = editSettings(dir, { agent: { harness: 'agy' } }, opened);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('changed since you opened it');
    expect(read(dir)).toBe(edited);
    expect(editSettings(dir, { agent: { harness: 'agy' } }, r.hash).ok).toBe(true);
  });

  test('a project with no file gets one holding just the change', () => {
    const dir = project({ 'package.json': { scripts: { test: 'vitest run' } } });
    expect(editSettings(dir, { agent: { harness: 'agy' } }, hashOf('')).ok).toBe(true);
    expect(JSON.parse(read(dir))).toEqual({ agent: { harness: 'agy' } });
  });

  test('random valid patches leave every key they do not name unchanged and always resolve', () => {
    const stages = ['spec', 'plan', 'red-tests', 'implement', 'test-repair', 'test-audit', 'review'];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const dir = project({ 'sdlc.config.json': config({ git: { branchPrefix: 'x/' } }) });
    for (let i = 0; i < 40; i++) {
      const patch: any = { agent: { stages: {} } };
      if (rnd(2)) patch.agent.harness = HARNESS_IDS[rnd(3)];
      if (rnd(2)) patch.agent.model = rnd(2) ? 'sonnet' : null;
      if (rnd(2)) patch.agent.effort = rnd(2) ? EFFORT_LEVELS[rnd(5)] : null;
      for (const st of stages) {
        if (rnd(3) === 0) patch.agent.stages[st] = { harness: rnd(2) ? HARNESS_IDS[rnd(3)] : null, model: rnd(2) ? 'o3-mini' : null, effort: rnd(2) ? EFFORT_LEVELS[rnd(5)] : null };
      }
      const before = JSON.parse(read(dir));
      expect(editSettings(dir, patch).ok).toBe(true);
      const after = JSON.parse(read(dir));
      expect({ ...after, agent: undefined }).toEqual({ ...before, agent: undefined });
      expect(after.agent.codeSearch).toBe('none');
      expect(resolve(dir).errors).toEqual([]);
    }
  });

  test('applyPatch merges objects, replaces values and removes keys set to null', () => {
    expect(applyPatch({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: null, e: 5 }, d: 4 })).toEqual({ a: { c: 2, e: 5 }, d: 4 });
  });
});

describe('personal overrides', () => {
  const registry = () => {
    const env = { AI_SDLC_HELPER_CONFIG_DIR: tmp() };
    writeRegistry([{ name: 'shop', path: '/p/shop', addedAt: '2026-01-01T00:00:00.000Z', overrides: { maxParallel: 3 } }], env);
    return env;
  };

  test('are merged into the project\'s entry, which keeps addedAt; null clears one and the last clear drops the key', () => {
    const env = registry();
    expect(editOverrides('shop', { worktreeBase: '/wts' }, env).ok).toBe(true);
    expect(readRegistry(env)[0]).toEqual({ name: 'shop', path: '/p/shop', addedAt: '2026-01-01T00:00:00.000Z', overrides: { maxParallel: 3, worktreeBase: '/wts' } });
    expect(editOverrides('shop', { worktreeBase: null, maxParallel: null }, env).ok).toBe(true);
    expect(readRegistry(env)[0]).toEqual({ name: 'shop', path: '/p/shop', addedAt: '2026-01-01T00:00:00.000Z' });
  });

  test('a bad value, an unknown override or an unknown project is refused', () => {
    const env = registry();
    expect(editOverrides('shop', { maxParallel: 0 }, env).errors).toEqual(['maxParallel: must be a whole number above 0']);
    expect(editOverrides('shop', { colour: 'red' }, env).errors).toEqual(['colour: unknown override']);
    expect(() => editOverrides('nope', { maxParallel: 2 }, env)).toThrow('no project called "nope"');
    expect(readRegistry(env)[0].overrides).toEqual({ maxParallel: 3 });
  });
});

describe('the agent of each stage', () => {
  test('the harness ids the settings accept are the ones the harness registry has', () => {
    expect([...HARNESS_IDS].sort()).toEqual(new DefaultHarnessRegistry().list().map(h => h.id).sort());
  });

  test('a stage entry wins; any other stage uses the project\'s; a harness change does not inherit the project\'s model or effort', () => {
    const cfg: any = { agent: { harness: 'claude', model: 'haiku', effort: 'low', stages: { review: { harness: 'codex' }, plan: { model: 'opus' }, spec: { effort: 'max' } } } };
    expect(harnessFor(cfg, 'review')).toBe('codex');
    expect(agentFor(cfg, 'review')).toEqual({ harness: 'codex' });
    expect(agentFor(cfg, 'plan')).toEqual({ harness: 'claude', model: 'opus', effort: 'low' });
    expect(agentFor(cfg, 'spec')).toEqual({ harness: 'claude', model: 'haiku', effort: 'max' });
    expect(agentFor(cfg, 'implement')).toEqual({ harness: 'claude', model: 'haiku', effort: 'low' });
    expect(agentFor({ agent: { harness: 'claude', model: null, effort: null } } as any, 'spec')).toEqual({ harness: 'claude' });
  });

  const withAgent = (f: { dir: string }, agent: Record<string, unknown>) => {
    const file = path.join(f.dir, 'sdlc.config.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...j, agent: { ...(j.agent || {}), ...agent } }));
  };
  const commandsOf = async (agent: Record<string, unknown>, opts: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) => {
    const f = fixture();
    withAgent(f, agent);
    const seen: string[] = [];
    const spawnAgent = async (req: AgentRequest) => {
      const text = req.args.join('\n');
      const flag = (n: string) => { const i = req.args.indexOf(n); return i >= 0 ? req.args[i + 1] : '-'; };
      seen.push(`${text.includes('Requirements Agent') ? 'spec' : text.includes('Architecture Planner') ? 'plan' : 'other'}=${req.command} model=${flag('--model')} effort=${flag('--effort')}`);
      fs.writeFileSync(req.stdout, JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', permission_denials: [] }));
      fs.writeFileSync(req.stderr, '');
      if (text.includes('Requirements Agent')) fs.writeFileSync(path.join(f.dir, DOCS, 'specs-1.md'), 'spec\n');
      if (text.includes('Architecture Planner')) fs.writeFileSync(path.join(f.dir, DOCS, 'questions.md'), '### Q1: x\nwhy\n**Suggested:** y\n**Answer:**\n');
      return 0;
    };
    await pipeline(f, env, { spawnAgent, ...opts });
    return seen;
  };

  test('a run starts each stage\'s agent with that stage\'s harness, model and effort', async () => {
    const seen = await commandsOf({ stages: { spec: { harness: 'codex' } } });
    expect(seen).toEqual([expect.stringMatching(/^spec=codex /), 'plan=claude model=opus effort=medium']);
  });

  test('the project\'s model and effort replace the stage defaults; a stage\'s own entry replaces the project\'s', async () => {
    const seen = await commandsOf({ model: 'haiku', effort: 'low', stages: { plan: { model: 'sonnet', effort: 'high' } } });
    expect(seen).toEqual(['spec=claude model=haiku effort=low', 'plan=claude model=sonnet effort=high']);
  });

  test('MODEL_<STAGE> wins over the project, which wins over SDLC_MODEL', async () => {
    const seen = await commandsOf({ stages: { plan: { model: 'sonnet' } } }, {}, { SDLC_MODEL: 'haiku', MODEL_PLAN: 'opus', EFFORT_SPEC: 'max' });
    expect(seen).toEqual(['spec=claude model=haiku effort=max', 'plan=claude model=opus effort=medium']);
    const seen2 = await commandsOf({ model: 'sonnet' }, {}, { SDLC_MODEL: 'haiku' });
    expect(seen2[0]).toMatch(/model=sonnet /);
  });

  test('--agent forces one harness for every stage and drops the settings made for another one', async () => {
    const seen = await commandsOf({ model: 'haiku', stages: { spec: { harness: 'codex', model: 'o3-mini' } } }, { agent: 'agy' });
    expect(seen).toEqual(['spec=agy model=gemini-3.8-pro effort=medium', 'plan=agy model=gemini-3.8-pro effort=medium']);
  });

  test('AGENT_<STAGE> on another harness drops the model and effort the stage had; on the same one it keeps them', async () => {
    const stages = { spec: { harness: 'codex', model: 'o3-mini' }, plan: { model: 'sonnet', effort: 'low' } };
    const seen = await commandsOf({ stages }, {}, { AGENT_SPEC: 'claude', AGENT_PLAN: 'claude' });
    expect(seen).toEqual(['spec=claude model=opus effort=medium', 'plan=claude model=sonnet effort=low']);
  });

  test('--model and --effort apply to every stage and win over MODEL_<STAGE> and the project', async () => {
    const seen = await commandsOf({ model: 'haiku', stages: { plan: { model: 'sonnet', effort: 'low' } } }, { model: 'opus', effort: 'max' }, { MODEL_PLAN: 'haiku' });
    expect(seen).toEqual(['spec=claude model=opus effort=max', 'plan=claude model=opus effort=max']);
  });
});

describe('doctor with agents per stage', () => {
  const dirWith = (agent: Record<string, unknown>) => project({ 'sdlc.config.json': config({ agent: { codeSearch: 'none', ...agent } }), 'Docs/backlog/index.md': '# Backlog\n' });
  const on = (...bins: string[]) => ((b: string) => (bins.includes(b) ? `/bin/${b}` : null)) as any;

  test('checks every harness the project uses, not just the default', () => {
    const checks = doctor(dirWith({ harness: 'claude', stages: { review: { harness: 'codex' }, spec: { harness: 'agy' } } }), { which: on('claude', 'codex') });
    expect(checks.filter(c => /CLI$/.test(c.name)).map(c => [c.name, c.ok])).toEqual([['claude CLI', true], ['codex CLI', true], ['agy CLI', false]]);
  });

  test('a project that uses only the default is checked as before', () => {
    const checks = doctor(dirWith({ harness: 'codex' }), { which: on('codex') });
    expect(checks.filter(c => /CLI$/.test(c.name)).map(c => [c.name, c.ok])).toEqual([['codex CLI', true]]);
  });
});

describe('--agent, --model and --effort on the command line', () => {
  const pipe = (...args: string[]) => run(['pipeline', 'no-such-item', '--cwd', tmp(), ...args]);

  test('a wrong value is refused before anything runs, and --flag=value works like --flag value', async () => {
    expect((await pipe('--effort', 'turbo')).stderr).toContain('--effort must be one of low, medium, high, xhigh, max (got turbo)');
    expect((await pipe('--effort=turbo')).stderr).toContain('(got turbo)');
    expect((await pipe('--agent=gpt')).stderr).toContain('--agent must be one of claude, agy, codex (got gpt)');
    expect((await pipe('--model')).stderr).toContain('--model needs a value');
    expect((await pipe('--agent=claude', '--model=opus', '--effort=high')).stderr).not.toMatch(/must be one of|needs a value|unknown option/);
  });
});

describe('the run-wide agent, model and effort in the environment and on start', () => {
  test('SDLC_FORCE_* in the environment are checked like the flags, and a flag wins over them', async () => {
    const dir = tmp();
    const env = (extra: NodeJS.ProcessEnv) => ({ ...process.env, ...extra });
    expect((await run(['pipeline', 'x', '--cwd', dir], env({ SDLC_FORCE_EFFORT: 'turbo' }))).stderr)
      .toContain('SDLC_FORCE_EFFORT must be one of low, medium, high, xhigh, max (got turbo)');
    expect((await run(['pipeline', 'x', '--cwd', dir], env({ SDLC_FORCE_AGENT: 'gpt' }))).stderr)
      .toContain('SDLC_FORCE_AGENT must be one of claude, agy, codex (got gpt)');
    expect((await run(['pipeline', 'x', '--cwd', dir, '--effort', 'high'], env({ SDLC_FORCE_EFFORT: 'turbo' }))).stderr)
      .not.toContain('must be one of');
  });

  test('AGENT_<STAGE> picks one stage\'s harness for the run; a wrong one is refused', async () => {
    const f = fixture();
    const seen: string[] = [];
    const spawnAgent = async (req: AgentRequest) => {
      const text = req.args.join('\n');
      seen.push(`${text.includes('Requirements Agent') ? 'spec' : 'plan'}=${req.command}`);
      fs.writeFileSync(req.stdout, JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', permission_denials: [] }));
      fs.writeFileSync(req.stderr, '');
      if (text.includes('Requirements Agent')) fs.writeFileSync(path.join(f.dir, DOCS, 'specs-1.md'), 'spec\n');
      if (text.includes('Architecture Planner')) fs.writeFileSync(path.join(f.dir, DOCS, 'questions.md'), '### Q1: x\nwhy\n**Suggested:** y\n**Answer:**\n');
      return 0;
    };
    await pipeline(f, { AGENT_PLAN: 'codex' }, { spawnAgent });
    expect(seen).toEqual(['spec=claude', 'plan=codex']);
    const bad = await pipeline(fixture(), { AGENT_PLAN: 'gpt' }, { spawnAgent });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('ERROR: AGENT_PLAN must be one of claude, agy, codex (got gpt)');
  });

  test('start and restart take --agent, --model and --effort; other run commands refuse them; a bad value exits 2', async () => {
    expect((await run(['start', 'a-b', '--effort', 'turbo'])).stderr).toContain('--effort must be one of low, medium, high, xhigh, max (got turbo)');
    expect((await run(['start', 'a-b', '--agent=gpt'])).stderr).toContain('--agent must be one of claude, agy, codex (got gpt)');
    for (const o of ['--agent', '--model', '--effort']) expect([(await run(['start', 'a-b', o])).status, (await run(['start', 'a-b', o])).stderr]).toEqual([2, expect.stringContaining(`${o} needs a value`)]);
    const r = await run(['stop', 'a-b', '--model', 'opus']);
    expect([r.status, r.stderr]).toEqual([2, expect.stringContaining('go with start and restart')]);
  });
});

describe('personal agent settings', () => {
  /** A project whose file says claude/sonnet/high with a codex review, registered with personal settings. */
  const setup = (personal?: Record<string, unknown>) => {
    const dir = project({ 'sdlc.config.json': config({ agent: { codeSearch: 'none', harness: 'claude', model: 'sonnet', effort: 'high', stages: { review: { harness: 'codex', model: 'o3-mini' } } } }) });
    const env = { AI_SDLC_HELPER_CONFIG_DIR: tmp() };
    writeRegistry([{ name: 'shop', path: fs.realpathSync(dir), addedAt: '2026-01-01T00:00:00.000Z', ...(personal ? { overrides: { agent: personal } } : {}) }], env);
    return { dir, env };
  };

  test('sit above the project file, field by field and stage by stage; the rest of the file is untouched', () => {
    const { dir, env } = setup({ model: 'haiku', stages: { review: { effort: 'low' }, plan: { harness: 'agy' } } });
    const a = resolve(dir, { env }).config!.agent;
    expect(a).toMatchObject({ harness: 'claude', model: 'haiku', effort: 'high' });
    expect(a.stages).toEqual({ review: { harness: 'codex', model: 'o3-mini', effort: 'low' }, plan: { harness: 'agy' } });
    expect(a.codeSearch).toBe('none');
    expect(JSON.parse(read(dir)).agent.model).toBe('sonnet');
  });

  test('another harness drops the model and effort the file chose for the old one, unless the personal setting names them', () => {
    const { dir, env } = setup({ harness: 'codex' });
    expect(resolve(dir, { env }).config!.agent).toMatchObject({ harness: 'codex', model: null, effort: null });
    const own = setup({ harness: 'codex', model: 'o3-mini' });
    expect(resolve(own.dir, { env: own.env }).config!.agent).toMatchObject({ harness: 'codex', model: 'o3-mini', effort: null });
    const stage = setup({ stages: { review: { harness: 'agy' } } });
    expect(resolve(stage.dir, { env: stage.env }).config!.agent.stages.review).toEqual({ harness: 'agy' });
  });

  test('a project nobody registered, or one with no personal settings, is the file alone', () => {
    const none = setup();
    expect(resolve(none.dir, { env: none.env }).config!.agent).toMatchObject({ harness: 'claude', model: 'sonnet' });
    const dir = project({ 'sdlc.config.json': config() });
    expect(resolve(dir, { env: { AI_SDLC_HELPER_CONFIG_DIR: tmp() } }).config!.agent.harness).toBe('claude');
  });

  test('a run worktree gets them in SDLC_PERSONAL_AGENT; a broken personal setting is an error that names its source', () => {
    const { dir, env } = setup();
    expect(resolve(dir, { env: { ...env, SDLC_PERSONAL_AGENT: JSON.stringify({ harness: 'agy' }) } }).config!.agent.harness).toBe('agy');
    const bad = resolve(dir, { env: { ...env, SDLC_PERSONAL_AGENT: JSON.stringify({ harness: 'gpt' }) } });
    expect(bad.errors).toEqual(['personal settings: agent.harness: must be one of claude, agy, codex (got "gpt")']);
    expect(resolve(dir, { env: { ...env, SDLC_PERSONAL_AGENT: JSON.stringify({ allowCommands: ['rm'] }) } }).errors)
      .toEqual(['personal settings: agent.allowCommands: not a personal setting']);
  });

  test('are saved in the registry with the same checks, merge with what is there, and clear with null', () => {
    const { env } = setup({ model: 'haiku' });
    expect(editOverrides('shop', { agent: { stages: { review: { harness: 'agy' } } } }, env).ok).toBe(true);
    expect(readRegistry(env)[0].overrides).toEqual({ agent: { model: 'haiku', stages: { review: { harness: 'agy' } } } });
    expect(editOverrides('shop', { agent: { harness: 'gpt' } }, env).errors).toEqual(['agent.harness: must be one of claude, agy, codex (got "gpt")']);
    expect(editOverrides('shop', { agent: { allowCommands: ['x'] } }, env).errors).toEqual(['agent.allowCommands: not a personal setting']);
    expect(editOverrides('shop', { agent: { model: null, stages: { review: null } } }, env).ok).toBe(true);
    expect(readRegistry(env)[0].overrides).toBeUndefined();
  });

  test('each setting says where it comes from: personal, the project file, or nothing for the built-in default', () => {
    const { dir } = setup();
    const file = JSON.parse(read(dir)).agent;
    const personal = { model: 'haiku', stages: { review: { effort: 'low' }, plan: { harness: 'agy' } } };
    expect(agentSources(mergeAgent(file, personal), personal)).toEqual({
      harness: 'project', model: 'personal', effort: 'project',
      stages: { review: { harness: 'project', model: 'project', effort: 'personal' }, plan: { harness: 'personal' } },
    });
    expect(agentSources(mergeAgent({}, undefined), undefined)).toEqual({ stages: {} });
  });

  test('a personal harness that empties a file stage (its model was for the old harness) leaves no stage behind', () => {
    const file = { stages: { review: { model: 'claude-sonnet-4-5', effort: 'max' } } };
    expect(mergeAgent(file, { harness: 'codex' })).toEqual({ harness: 'codex' });
    expect(mergeAgent(file, { stages: { review: { harness: 'codex' } } })).toEqual({ stages: { review: { harness: 'codex' } } });
  });

  test('a start passes them to the pipeline of the run, and nothing when there are none', () => {
    const { dir, env } = setup({ model: 'haiku' });
    const ctx = runContext(dir, env);
    expect(JSON.parse(pipelineEnv(ctx, 'x').SDLC_PERSONAL_AGENT!)).toEqual({ model: 'haiku' });
    const none = setup();
    expect(pipelineEnv(runContext(none.dir, none.env), 'x').SDLC_PERSONAL_AGENT).toBeUndefined();
  });
});
