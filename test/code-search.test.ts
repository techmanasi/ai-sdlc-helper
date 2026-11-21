import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, test } from 'vitest';
import { codeIndexers, codeSearchErrors, codeSearchFor, codeSearchGuide, inspectCodeSearch } from '../src/config/codeSearch.js';
import { resolve } from '../src/config/settings.js';
import { renderSkill, renderTemplate } from '../src/config/skills.js';
import { pathWith, run, tmp } from './helpers.js';

const cli = (args, env?) => run(args, env);
// A project with the given files (an index is a file or a folder: a trailing slash makes a folder).
const project = (...entries) => {
  const dir = tmp();
  for (const e of entries) {
    if (e.endsWith('/')) fs.mkdirSync(path.join(dir, e), { recursive: true });
    else { fs.mkdirSync(path.dirname(path.join(dir, e)), { recursive: true }); fs.writeFileSync(path.join(dir, e), '{}'); }
  }
  return dir;
};
const both = () => project('graft/', 'graphify-out/graph.json');
// Fixture part and skill files (written here, not the repo's own text).
const fixtures = () => {
  const dir = tmp('sdlc-parts-');
  fs.mkdirSync(path.join(dir, 'skills'));
  fs.mkdirSync(path.join(dir, 'parts'));
  fs.writeFileSync(path.join(dir, 'skills/demo.md'), 'Step 1. {{CODE_SEARCH}}\nStep 2: again {{CODE_SEARCH}}\n');
  fs.writeFileSync(path.join(dir, 'parts/code-search.graft.md'), 'USE-GRAFT & callers\n');
  fs.writeFileSync(path.join(dir, 'parts/code-search.graphify.md'), 'USE-GRAPHIFY\n');
  fs.writeFileSync(path.join(dir, 'parts/code-search.md'), 'USE-GREP\n');
  return { skillsDir: path.join(dir, 'skills'), partsDir: path.join(dir, 'parts') };
};
const CUSTOM = { codeIndexers: { sourcegraph: { command: 'src', tools: ['mcp__sourcegraph'], commands: ['src search'], guide: 'USE-SRC' } } };

describe('choosing a code indexer', () => {
  test('built in: graft and graphify, each needing its command on PATH and its index', async () => {
    const all = codeIndexers({});
    expect(Object.keys(all)).toEqual(['graft', 'graphify']);
    expect(all.graft).toMatchObject({ command: 'graft', index: 'graft', tools: ['mcp__graft'], commands: ['graft'] });
    expect(all.graphify).toMatchObject({ command: 'graphify', index: 'graphify-out/graph.json', tools: [], commands: ['graphify'] });
  });

  test('auto takes the first available, in agent.codeSearchOrder when given; none means Grep and Glob', async () => {
    const name = (dir, agent, env) => codeSearchFor(dir, { agent }, env).codeSearch;
    expect(name(both(), {}, pathWith('graft', 'graphify'))).toBe('graft');
    expect(name(both(), { codeSearchOrder: ['graphify', 'graft'] }, pathWith('graft', 'graphify'))).toBe('graphify');
    expect(name(both(), {}, pathWith('graphify'))).toBe('graphify');
    expect(name(project('graft/'), {}, pathWith('graft', 'graphify'))).toBe('graft');
    expect(name(project('graphify-out/'), {}, pathWith('graphify'))).toBe('none'); // the index is graph.json, not the folder
    expect(name(both(), { codeSearch: 'none' }, pathWith('graft', 'graphify'))).toBe('none');

    const nothing = codeSearchFor(project(), {}, pathWith());
    expect(nothing).toMatchObject({ codeSearch: 'none', indexer: null });
    expect(nothing.warning).toBe('no code indexer is available; code search uses Grep and Glob. A code indexer is recommended: '
      + 'graft (npm install -g @nanonets/graft, then graft build), or graphify (uv tool install graphifyy (or pipx install graphifyy), then build the graph with /graphify . in Claude Code)');

    // graft installed but the project has no index yet: build it, not install it
    expect(codeSearchFor(project(), {}, pathWith('graft')).warning).toBe('no code indexer is available; code search uses Grep and Glob. '
      + 'A code indexer is recommended: graft (installed; build its index: graft build), or graphify (uv tool install graphifyy (or pipx install graphifyy), then build the graph with /graphify . in Claude Code)');
  });

  test('a named indexer is used when available, else Grep and Glob with how to set it up', async () => {
    expect(codeSearchFor(both(), { agent: { codeSearch: 'graphify' } }, pathWith('graft', 'graphify'))).toMatchObject({ codeSearch: 'graphify', warning: null });
    expect(codeSearchFor(project(), { agent: { codeSearch: 'graphify' } }, pathWith('graphify')).warning)
      .toBe('agent.codeSearch is "graphify" but the project has no graphify index (graphify-out/graph.json); code search uses Grep and Glob. '
        + 'To set it up: uv tool install graphifyy (or pipx install graphifyy), then build the graph with /graphify . in Claude Code');
    expect(codeSearchFor(both(), { agent: { codeSearch: 'graft' } }, pathWith()).warning).toMatch(/^agent.codeSearch is "graft" but graft is not installed \(no graft command\)/);
  });

  test('a project declares its own indexer, or changes a built-in one field by field', async () => {
    const custom = codeSearchFor(project(), { agent: { codeSearch: 'sourcegraph', ...CUSTOM } }, pathWith('src'));
    expect(custom).toMatchObject({ codeSearch: 'sourcegraph', indexer: { tools: ['mcp__sourcegraph'], commands: ['src search'], guide: 'USE-SRC' } });
    const moved = codeIndexers({ agent: { codeIndexers: { graft: { index: '.cache/graft' } } } }).graft;
    expect(moved).toMatchObject({ command: 'graft', index: '.cache/graft', tools: ['mcp__graft'] });
    expect(codeSearchFor(project('.cache/graft/'), { agent: { codeIndexers: { graft: { index: '.cache/graft' } } } }, pathWith('graft')).codeSearch).toBe('graft');
  });

  test('settings that name unknown indexers or declare incomplete ones are errors', async () => {
    expect(codeSearchErrors({ agent: { codeSearch: 'nope' } })).toEqual(['agent.codeSearch: "nope" is not a code indexer (use auto, none, graft, graphify)']);
    expect(codeSearchErrors({ agent: { codeSearchOrder: ['graft', 'x'] } })).toEqual(['agent.codeSearchOrder: "x" is not a code indexer']);
    expect(codeSearchErrors({ agent: { codeIndexers: { mine: {}, Bad_Name: { command: 'a b', guide: 'g' }, auto: { command: 'x', guide: 'g' } } } })).toEqual([
      'agent.codeIndexers.mine: needs "command" (the program that must be on PATH)',
      'agent.codeIndexers.mine: needs "guide" or "guideFile" (how the agents should search with it)',
      'agent.codeIndexers.Bad_Name: names use lowercase letters, digits and dashes',
      'agent.codeIndexers.Bad_Name.command: a program name, not a command line',
      'agent.codeIndexers.auto: "auto" is reserved',
    ]);
    expect(codeSearchErrors({ agent: { codeSearch: 'sourcegraph', ...CUSTOM } })).toEqual([]);

    const dir = project();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), JSON.stringify({ agent: { codeIndexers: { x: { command: 'x', guide: 'g', extra: 1 } } } }));
    expect(resolve(dir).errors).toEqual(['sdlc.config.json: agent.codeIndexers.x.extra: unknown setting']);
  });

  test('the settings carry the indexer, its index as a worktree link, and the recommendation as a warning', async () => {
    const dir = both();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    const on = resolve(dir, { env: pathWith('graphify') });
    expect(on).toMatchObject({ errors: [], warnings: [], config: { agent: { codeSearch: 'graphify', codeIndexer: { commands: ['graphify'] } } } });
    expect(on.config.worktree.link).toEqual(['node_modules', 'graphify-out']);
    const off = resolve(dir, { env: pathWith() });
    expect(off.errors).toEqual([]);
    expect(off.config.agent).toMatchObject({ codeSearch: 'none', codeIndexer: null });
    expect(off.warnings).toEqual([expect.stringContaining('no code indexer is available')]);
  });
});

describe('skills and prompts in a version per indexer', () => {
  test('the guide: the indexer\'s own text or file, its part file, else the Grep/Glob part', async () => {
    const { partsDir } = fixtures();
    const dir = both();
    const guide = (agent, env) => codeSearchGuide(codeSearchFor(dir, { agent }, env), dir, partsDir);
    expect(guide({}, pathWith('graft'))).toBe('USE-GRAFT & callers');
    expect(guide({}, pathWith('graphify'))).toBe('USE-GRAPHIFY');
    expect(guide({}, pathWith())).toBe('USE-GREP');
    expect(guide({ codeSearch: 'sourcegraph', ...CUSTOM }, pathWith('src'))).toBe('USE-SRC');
    fs.writeFileSync(path.join(dir, 'search.txt'), 'FROM-FILE\n');
    expect(guide({ codeSearch: 'g2', codeIndexers: { g2: { command: 'src', guideFile: 'search.txt' } } }, pathWith('src'))).toBe('FROM-FILE');
    expect(guide({ codeIndexers: { graft: { guide: 'MY-GRAFT' } } }, pathWith('graft'))).toBe('MY-GRAFT');
    expect(renderTemplate('a {{CODE_SEARCH}} b {{CODE_SEARCH}} c', 'X')).toBe('a X b X c');
  });

  test('a skill is rendered for the project; a broken settings file searches as auto; unknown names give null', async () => {
    const f = fixtures();
    const dir = both();
    const skill = env => renderSkill('demo', dir, { ...f, env });
    expect(skill(pathWith('graft'))).toBe('Step 1. USE-GRAFT & callers\nStep 2: again USE-GRAFT & callers\n');
    expect(skill(pathWith('graphify'))).toBe('Step 1. USE-GRAPHIFY\nStep 2: again USE-GRAPHIFY\n');
    expect(skill(pathWith())).toBe('Step 1. USE-GREP\nStep 2: again USE-GREP\n');
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), JSON.stringify({ agent: { codeSearch: 'none' } }));
    expect(skill(pathWith('graft'))).toContain('USE-GREP');
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), JSON.stringify({ agent: { codeSearch: 'nope' } }));
    expect(skill(pathWith('graft'))).toContain('USE-GRAFT');
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), '{ broken');
    expect(skill(pathWith('graft'))).toContain('USE-GRAFT');
    expect(renderSkill('missing', dir, f)).toBeNull();
    expect(renderSkill('../demo', dir, f)).toBeNull();
  });
});

describe('command line', () => {
  test('code-search prints the indexer in use and never fails', async () => {
    const dir = both();
    expect((await cli(['code-search', dir], pathWith('graft'))).stdout).toBe('graft\n');
    const off = await cli(['code-search', dir], pathWith());
    expect(off).toMatchObject({ status: 0, stdout: 'none\n' });
    expect(off.stderr).toContain('NOTE: no code indexer is available');
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), JSON.stringify({ agent: { codeSearch: 'nope' } }));
    const bad = await cli(['code-search', dir], pathWith('graphify'));
    expect(bad).toMatchObject({ status: 0, stdout: 'graphify\n' });
    expect(bad.stderr).toContain('NOTE: agent.codeSearch: "nope" is not a code indexer (use auto, none, graft, graphify); using "auto"');

  });

  test('--list shows every indexer and whether it is available; --use saves the choice in sdlc.config.json', async () => {
    const dir = project('graphify-out/graph.json');
    fs.writeFileSync(path.join(dir, 'sdlc.config.json'), JSON.stringify({ backlogDir: 'Docs/backlog', agent: { allowCommands: ['make'] } }));
    const list = (await cli(['code-search', dir, '--list'], pathWith('graphify'))).stdout;
    expect(list).toContain('agent.codeSearch: auto; in use: graphify');
    expect(list).toContain('graft     not available: graft is not installed (no graft command)\n');
    expect(list).toContain('set up: npm install -g @nanonets/graft, then graft build');
    expect(list).toContain('* graphify  available');
    expect(list).toContain('code-search --use <graft|graphify|auto|none>');

    const use = await cli(['code-search', dir, '--use', 'graft'], pathWith('graphify'));
    expect(use.status).toBe(0);
    expect(use.stdout).toContain('agent.codeSearch = "graft" in sdlc.config.json; code search now uses Grep and Glob');
    expect(use.stdout).toContain('NOTE: agent.codeSearch is "graft" but graft is not installed');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'sdlc.config.json'), 'utf8'))).toEqual({ backlogDir: 'Docs/backlog', agent: { allowCommands: ['make'], codeSearch: 'graft' } });
    expect((await cli(['code-search', dir, '--use', 'none'], pathWith('graphify'))).stdout).toContain('code search now uses Grep and Glob');
    expect((await cli(['code-search', dir, '--use', 'auto'], pathWith('graphify'))).stdout).toContain('code search now uses graphify');

    const fresh = project();
    await cli(['code-search', fresh, '--use', 'graphify'], pathWith());
    expect(JSON.parse(fs.readFileSync(path.join(fresh, 'sdlc.config.json'), 'utf8'))).toEqual({ agent: { codeSearch: 'graphify' } });
    const bad = await cli(['code-search', fresh, '--use', 'nope'], pathWith());
    expect(bad.status).toBe(2);
    expect(bad.stderr).toBe('ERROR: "nope" is not a code indexer (use auto, none, graft, graphify)\n');
  });

  test('skill prints a rendered skill or exits 2', async () => {
    for (const env of [pathWith('graft'), pathWith('graphify'), pathWith()]) {
      const r = await cli(['skill', 'plan', both()], env);
      expect(r.status).toBe(0);
      expect(r.stdout.length).toBeGreaterThan(0);
      expect(r.stdout).not.toContain('{{CODE_SEARCH}}');
    }
    const bad = await cli(['skill', 'nope']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/^ERROR: no skill "nope" \(skills: .*plan.*triage/);
  });
});

describe('inspecting code search for setup', () => {
  it('reports resolved paths, independent installation and indexing, and manual Graphify instructions', () => {
    const dir = project('.cache/graft/');
    const file = { agent: { codeIndexers: { graft: { index: '.cache/graft' } } } };
    const status = inspectCodeSearch(dir, file, pathWith('graphify'));
    expect(status).toMatchObject({ setting: 'auto', current: 'none' });
    expect(status.indexers).toEqual(expect.arrayContaining([
      { name: 'graft', command: 'graft', index: '.cache/graft', installed: false, indexed: true,
        canBuild: false, build: 'graft build', setup: expect.stringContaining('npm install -g @nanonets/graft') },
      { name: 'graphify', command: 'graphify', index: 'graphify-out/graph.json', installed: true, indexed: false,
        canBuild: false, build: expect.stringContaining('/graphify .'), setup: expect.stringContaining('graphifyy') },
    ]));
    const ready = inspectCodeSearch(dir, file, pathWith('graft'));
    expect(ready.current).toBe('graft');
    expect(ready.indexers.find(i => i.name === 'graft')).toMatchObject({ installed: true, indexed: true, canBuild: true });
  });

  it('selects an installed indexer without an index path and serializes absent fields as null', () => {
    const status = inspectCodeSearch(project(), { agent: { ...CUSTOM, codeSearch: 'sourcegraph' } }, pathWith('src'));
    expect(status).toMatchObject({ setting: 'sourcegraph', current: 'sourcegraph' });
    expect(status.indexers).toContainEqual({ name: 'sourcegraph', command: 'src', index: null, installed: true,
      indexed: false, setup: null, build: null, canBuild: false });
  });

  it.each([
    { name: 'replacement instructions only', argv: undefined, programs: ['graft'], canBuild: false },
    { name: 'replacement executable available', argv: ['builder', 'a b'], programs: ['graft', 'builder'], canBuild: true },
    { name: 'replacement executable missing', argv: ['builder'], programs: ['graft'], canBuild: false },
    { name: 'indexer command missing', argv: ['builder'], programs: ['builder'], canBuild: false },
  ])('resolves Graft build overrides with $name', ({ argv, programs, canBuild }) => {
    const graft = { build: 'graft alternate', ...(argv ? { buildArgv: argv } : {}) };
    const status = inspectCodeSearch(project(), { agent: { codeIndexers: { graft } } }, pathWith(...programs));
    expect(status.indexers.find(i => i.name === 'graft')).toMatchObject({ build: graft.build, canBuild });
  });

  it.each([
    { name: 'empty vector', invalid: [] }, { name: 'invalid program', invalid: ['two words'] },
    { name: 'non-string argument', invalid: ['builder', 1] }, { name: 'NUL in argument', invalid: ['builder', 'a\0b'] },
    { name: 'scalar', invalid: 'builder' },
  ])('validates buildArgv through resolve for $name', ({ invalid }) => {
    const root = project();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    const errors = (buildArgv: unknown) => {
      fs.writeFileSync(path.join(root, 'sdlc.config.json'), JSON.stringify({ agent: { codeIndexers: { graft: { buildArgv } } } }));
      return resolve(root, { env: pathWith() }).errors;
    };
    expect(errors(['future-builder', 'a b', '$HOME'])).toEqual([]);
    expect(errors(invalid).join('\n')).toMatch(/buildArgv/i);
  });
});
