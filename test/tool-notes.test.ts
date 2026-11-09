import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { renderSkill } from '../src/config/skills.js';
import { resolve } from '../src/config/settings.js';
import { NOTES_DIR, NOTES_HEADING, readNote, toolNotes } from '../src/config/toolNotes.js';
import { renderPrompt } from '../src/pipeline/prompts.js';
import { pathWith, project, tmp, write } from './helpers.js';

const SHIPPED = path.join(NOTES_DIR, 'vitest-rpc-timeout.md');
const vitest = readNote(SHIPPED);
const suite = (dir: string, runner: string, extra: object = {}) => ({ name: dir, dir, runner, language: 'typescript', packageManager: 'npm', ...extra });
const cfg = (suites: object[], agent: object = {}) => ({ suites, agent: { harness: 'claude', stages: {}, codeIndexer: null, ...agent } }) as any;
const one = (runner: string) => cfg([suite('.', runner)]);
const noteDir = (files: Record<string, string>) => {
  const dir = tmp('sdlc-notes-');
  for (const [f, t] of Object.entries(files)) write(dir, f, t);
  return dir;
};
const words = (n: number, tag = 'w') => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
const ERROR = 'Timeout calling "onTaskUpdate"';

describe('tool notes', () => {
  test('a note loads for the stage and runner it names and for no other runner', () => {
    const want = vitest.sections['red-tests']!.text;
    for (const runner of ['jest', 'vitest', 'mocha', 'node-test', 'generic-junit']) {
      const text = toolNotes('red-tests', one(runner), {});
      if (runner === 'vitest') expect(text).toBe(`${NOTES_HEADING}\n\n${want}`);
      else expect(text).toBe('');
    }
    expect(toolNotes('spec', one('vitest'), {})).toBe('');
    expect(toolNotes('review', one('vitest'), {})).toBe('');
  });

  test('match lines follow the truth table', () => {
    const config = cfg([suite('web', 'vitest'), suite('features', 'generic-junit', { language: 'javascript' })]);
    const load = (...lines: string[]) => toolNotes('spec', config, {}, { dirs: [noteDir({ 'n.md': `${lines.map(l => `match: ${l}`).join('\n')}\n## spec\nTEXT\n` })] });
    expect(load('runner=vitest')).toContain('Applies to web/');
    expect(load('runner=vitest')).not.toContain('features/');
    expect(load('runner=jest|vitest')).toContain('Applies to web/');
    expect(load('runner=vitest, harness=codex')).toBe('');
    expect(load('runner=vitest, harness=claude')).toContain('TEXT');
    expect(load('language=python')).toBe('');
    expect(load('runner=VITEST, packageManager=NPM')).toContain('Applies to web/');
    expect(load('runner=vitest', 'runner=generic-junit')).toMatch(/^Tool notes[^\n]*\n\nApplies to web\/, features\/:\nTEXT$/);
    expect(load('never')).toBe('');
    // project-level keys: harness per stage, codeIndexer
    const staged = cfg(config.suites, { stages: { spec: { harness: 'codex' } }, codeIndexer: { name: 'graft' } });
    const on = (line: string) => toolNotes('spec', staged, {}, { dirs: [noteDir({ 'n.md': `match: ${line}\n## spec\nTEXT\n` })] });
    expect(on('harness=codex')).toContain('TEXT');
    expect(on('harness=claude')).toBe('');
    expect(on('codeIndexer=graft')).toContain('TEXT');
    expect(on('codeIndexer=graphify')).toBe('');
  });

  test('a mixed project gets a runner\'s note once, naming its suite folder', () => {
    const mixed = cfg([suite('web', 'vitest'), suite('api', 'jest'), suite('admin', 'vitest')]);
    const text = toolNotes('red-tests', mixed, {});
    expect(text.split(vitest.sections['red-tests']!.text)).toHaveLength(2);
    expect(text).toContain('Applies to web/, admin/:');
    expect(text).not.toContain('api/');
    // one suite: no prefix
    expect(toolNotes('red-tests', one('vitest'), {})).not.toContain('Applies to');
  });

  test('the red-tests skill gets the note for a Vitest project only', () => {
    const files = (runner: string) => ({
      'sdlc.config.json': { suites: [{ name: 'app', dir: '.', runner, testCmd: 'npm test', testGlobs: ['src/**/*.test.ts'] }], agent: { codeSearch: 'none' }, ui: { timezone: 'UTC' } },
      'src/x.ts': '',
    });
    const env = pathWith();
    const want = vitest.sections['red-tests']!.text;
    expect(renderSkill('red-tests', project(files('vitest')), { env })).toContain(`${NOTES_HEADING}\n\n${want}`);
    expect(renderSkill('red-tests', project(files('jest')), { env })).not.toContain(want);
    expect(renderSkill('red-tests', project({ 'sdlc.config.json': { backlogDir: 'items' } }), { env })).not.toContain(want);
    // the other stages' sections reach their skills as "If the test output shows" lines; unrelated skills get none
    const implement = renderSkill('implement', project(files('vitest')), { env })!;
    expect(implement).toContain(`If the test output shows /${vitest.sections.implement!.when}/:`);
    expect(renderSkill('triage', project(files('vitest')), { env }) ?? '').not.toContain(NOTES_HEADING);
    const loop = renderSkill('tdd-loop', project(files('vitest')), { env })!;
    expect(loop).toContain(want);
    expect(loop).toContain(vitest.sections.implement!.text);
    expect(loop.split(NOTES_HEADING)).toHaveLength(2);
    const dirs = noteDir({ 'x.md': 'match: runner=jest\n## red-tests\nJEST ONLY\n' });
    expect(renderSkill('red-tests', project(files('jest')), { env, notesDirs: [dirs] })).toContain('JEST ONLY');
  });

  test('a malformed note is refused', () => {
    const bad = (text: string) => { const f = path.join(noteDir({ 'n.md': text }), 'n.md'); return () => readNote(f); };
    expect(bad('## spec\nT\n')).toThrow(/no match: line/);
    expect(bad('hello\nmatch: runner=vitest\n## spec\nT\n')).toThrow(/before the first/);
    expect(bad('match: runner=vitest\n')).toThrow(/no "## <stage>" section/);
    expect(bad('match: flavour=x\n## spec\nT\n')).toThrow(/unknown match key/);
    expect(bad('match: runner=vitest\n## specs\nT\n')).toThrow(/unknown stage heading/);
    expect(bad('match: runner=vitest\n## spec\nwhen: (\nT\n')).toThrow(/bad when: regex/);
    expect(bad('match: runner=a+b\n## spec\nT\n')).toThrow(/"\+" is only for tools/);
    expect(bad('match: tools=a+b|c\n## spec\nT\n')).toThrow(/mixed/);
    expect(bad('match: runner=vitest\n## spec\n')).toThrow(/empty/);
    expect(bad('match: runner=vitest\n## spec\nA\n## spec\nB\n')).toThrow(/two sections/);
    expect(bad('match: runner=vitest\n## spec\nT\n')).not.toThrow();
    expect(bad('match: tools=python+behave|ruby\n## spec\nT\n')).toThrow(/mixed/);
    expect(() => toolNotes('spec', one('vitest'), {}, { dirs: [noteDir({ 'n.md': 'oops' })] })).toThrow(/^ERROR: tool note /);
    expect(toolNotes('spec', one('vitest'), {}, { dirs: [path.join(tmp(), 'missing')] })).toBe('');
  });

  test('a section over 120 words or a stage over 200 words of notes is refused', () => {
    const run = (files: Record<string, string>) => () => toolNotes('spec', one('vitest'), {}, { dirs: [noteDir(files)] });
    expect(run({ 'a.md': `match: runner=vitest\n## spec\n${words(120)}\n` })).not.toThrow();
    expect(run({ 'a.md': `match: runner=vitest\n## spec\n${words(121)}\n` })).toThrow(/121 words/);
    // the when: line is not counted
    expect(run({ 'a.md': `match: runner=vitest\n## spec\nwhen: a b c d e f\n${words(120)}\n` })).not.toThrow();
    const two = { 'a.md': `match: runner=vitest\n## spec\n${words(100)}\n`, 'b.md': `match: runner=vitest\n## spec\n${words(100)}\n` };
    expect(run(two)).not.toThrow();
    expect(run({ ...two, 'c.md': `match: runner=vitest\n## spec\n${words(1)}\n` })).toThrow(/limit is 200/);
    // a note that does not match does not count
    expect(run({ ...two, 'c.md': `match: runner=jest\n## spec\n${words(100)}\n` })).not.toThrow();
  });

  test('a when: section loads only when the stage\'s signal text matches', () => {
    const config = one('vitest');
    const has = (stage: any, signals: object) => toolNotes(stage, config, signals).includes(vitest.sections[stage as 'implement']!.text);
    expect(has('implement', { testsLog: `ERROR x\n${ERROR}\n` })).toBe(true);
    expect(has('implement', { testsLog: 'ok: 3 passed' })).toBe(false);
    expect(has('implement', { testIssues: ERROR })).toBe(false);
    expect(has('implement', {})).toBe(false);
    for (const stage of ['test-repair', 'test-audit']) {
      expect(has(stage, { testIssues: `a.test.ts :: <suite failed to run> :: ${ERROR}` })).toBe(true);
      expect(has(stage, { testIssues: 'a.test.ts :: x :: spec' })).toBe(false);
      expect(has(stage, { testsLog: ERROR })).toBe(false);
    }
    // a when: section of another stage never loads in a run
    const dirs = [noteDir({ 'n.md': 'match: runner=vitest\n## review\nwhen: .\nT\n' })];
    expect(toolNotes('review', config, { testsLog: 'x', testIssues: 'x' }, { dirs })).toBe('');
    expect(toolNotes('review', config, 'skill', { dirs })).toContain('If the test output shows /./:\nT');
  });

  test('the Red tests and Test audit prompts carry the shipped Vitest note for a Vitest project', () => {
    const values = Object.fromEntries(['DOCS', 'LOG', 'TEST_DIR', 'TEST_CMD', 'TEST_FILE_CMD', 'RED_SHA', 'SLUG', 'TEST_FRAMEWORK', 'TEST_FILES', 'FETCH_CMD', 'LINT_NOTE', 'LINT_TESTS_NOTE'].map(k => [k, `<${k}>`]));
    const config = one('vitest');
    const red = renderPrompt('red-tests', values, 'GUIDE', undefined, toolNotes('red-tests', config, {}));
    expect(red.endsWith(`${NOTES_HEADING}\n\n${vitest.sections['red-tests']!.text}`)).toBe(true);
    expect(red).not.toMatch(/\{\{[A-Z_]+\}\}/);
    const audit = renderPrompt('test-audit', values, 'GUIDE', undefined, toolNotes('test-audit', config, { testIssues: ERROR }));
    expect(audit.endsWith(vitest.sections['test-audit']!.text)).toBe(true);
    expect(audit).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(renderPrompt('test-audit', values, 'GUIDE', undefined, toolNotes('test-audit', one('jest'), { testIssues: ERROR }))).not.toContain(NOTES_HEADING);
    // placeholders are not filled inside notes
    expect(renderPrompt('spec', values, 'GUIDE', undefined, 'NOTE {{DOCS}}')).toMatch(/\n\nNOTE \{\{DOCS\}\}$/);
    expect(fs.existsSync(SHIPPED)).toBe(true);
  });

  describe('project notes', () => {
    const BEHAVE = 'match: tools=python+behave\n## red-tests\nSTEPS in features/steps/\n## implement\nwhen: AmbiguousStep\nCLAIM the step file\n';
    const env = pathWith();
    /** A project with a Python+Behave suite (features/) and a Vitest suite (web/), and <notes> under .sdlc/notes. */
    const proj = (notes: Record<string, string>, extra: object = {}) => {
      const files: Record<string, unknown> = {
        'sdlc.config.json': {
          suites: [
            { name: 'features', dir: 'features', runner: 'generic-junit', testCmd: 'behave --junit', report: 'r.xml', tools: ['python', 'behave'] },
            { name: 'web', dir: 'web', runner: 'vitest', testCmd: 'npx vitest run' },
          ], agent: { codeSearch: 'none' }, ui: { timezone: 'UTC' }, ...extra,
        },
        'features/.keep': '', 'web/.keep': '',
      };
      for (const [f, t] of Object.entries(notes)) files[`.sdlc/notes/${f}`] = t;
      const dir = project(files);
      const r = resolve(dir, { env });
      return { dir, config: r.config!, warnings: r.warnings, errors: r.errors };
    };
    const only = (config: any, suiteName: string) => ({ ...config, suites: config.suites.filter((s: any) => s.name === suiteName) });

    test('a project note for tools=python+behave loads for a suite listing both, at the stages it names, and for no other suite', () => {
      const note = readNote(path.join(noteDir({ 'behave-steps.md': BEHAVE }), 'behave-steps.md'));
      const { config, errors } = proj({ 'behave-steps.md': BEHAVE });
      expect(errors).toEqual([]);
      const red = toolNotes('red-tests', config, {});
      expect(red).toContain(`Applies to features/:\n${note.sections['red-tests']!.text}`);
      expect(red).not.toMatch(/Applies to web\/(, features\/)?:\n[^\n]*STEPS/);
      expect(toolNotes('implement', config, { testsLog: 'AmbiguousStep: x' })).toContain(note.sections.implement!.text);
      expect(toolNotes('implement', config, { testsLog: 'fine' })).not.toContain(note.sections.implement!.text);
      expect(toolNotes('spec', config, {})).toBe('');
      expect(toolNotes('red-tests', only(config, 'web'), {})).not.toContain(note.sections['red-tests']!.text);
      // the truth table's tools rows
      const loads = (line: string) => {
        const p = proj({ 'n.md': `match: ${line}\n## spec\nTEXT\n` });
        return toolNotes('spec', p.config, {}).includes('TEXT');
      };
      expect(loads('tools=python+behave')).toBe(true);
      expect(loads('tools=python+behave, runner=vitest')).toBe(false);
      expect(loads('tools=python|ruby')).toBe(true);
      expect(loads('tools=behave+pytest')).toBe(false);
      expect(loads('tools=PYTHON+Behave')).toBe(true);
    });

    test('a project note replaces a shipped note of the same name, and match: never turns it off', () => {
      const shipped = vitest.sections['red-tests']!.text;
      const base = proj({});
      expect(toolNotes('red-tests', only(base.config, 'web'), {})).toContain(shipped);
      const replaced = proj({ 'vitest-rpc-timeout.md': 'match: runner=vitest\n## red-tests\nMINE\n' });
      const text = toolNotes('red-tests', only(replaced.config, 'web'), {});
      expect(text).toContain('MINE');
      expect(text).not.toContain(shipped);
      const off = proj({ 'vitest-rpc-timeout.md': 'match: never\n## red-tests\nMINE\n' });
      expect(toolNotes('red-tests', only(off.config, 'web'), {})).toBe('');
      expect(off.warnings).toEqual([]);
    });

    test('a malformed project note is skipped and reported as a resolve() warning', () => {
      const p = proj({ 'bad.md': 'oops\n', 'good.md': 'match: tools=behave\n## spec\nGOOD\n', 'worse.md': 'match: runner=vitest\n## specs\nT\n' });
      expect(p.errors).toEqual([]);
      expect(p.warnings).toHaveLength(2);
      expect(p.warnings.join('\n')).toMatch(/bad\.md.*no match: line|bad\.md.*before the first/);
      expect(p.warnings.join('\n')).toMatch(/worse\.md.*unknown stage heading/);
      expect(toolNotes('spec', p.config, {})).toContain('GOOD');
      // the same file in the shipped folder throws
      expect(() => toolNotes('spec', p.config, {}, { dirs: [path.join(p.dir, '.sdlc/notes')] })).toThrow(/^ERROR: tool note /);
    });

    test('a project note over the caps is skipped with a warning', () => {
      const p = proj({
        'long.md': `match: tools=python\n## spec\n${words(121)}\n`,
        'a.md': `match: tools=python\n## plan\n${words(120, 'a')}\n`,
        'b.md': `match: tools=python\n## plan\n${words(81, 'b')}\n`,
        'c.md': `match: tools=python\n## plan\n${words(10, 'c')}\n`,
      });
      expect(p.errors).toEqual([]);
      expect(p.warnings.some(w => /long\.md.*121 words/.test(w))).toBe(true);
      expect(p.warnings.some(w => /project note b: .*limit is 200/.test(w))).toBe(true);
      expect(toolNotes('spec', p.config, {})).toBe('');
      const plan = toolNotes('plan', p.config, {});
      expect(plan).toContain(words(120, 'a'));
      expect(plan).not.toContain('b0 ');
      expect(plan).toContain(words(10, 'c'));
    });
  });
});
