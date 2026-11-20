import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { Ctx } from '../src/pipeline/context.js';
import { lintFailures, staticCheckFailures, typecheckFailures } from '../src/pipeline/stages.js';
import { tmp } from './helpers.js';

function makeCtx(dir: string, checks: { lint?: string | null; typecheck?: string | null } = {}): Ctx {
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return {
    root: dir,
    log: 'logs',
    docs: 'docs',
    slug: 'my-feature',
    env: {},
    out: vi.fn(),
    err: vi.fn(),
    failLog: '',
    config: {
      root: dir,
      suites: [],
      integration: null,
      lint: checks.lint ?? null,
      typecheck: checks.typecheck ?? null,
    },
  } as unknown as Ctx;
}

const TS2835 = "web/test/code-search-ui.test.ts(59,39): error TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean '../ui/src/api.js'?";
const TS2307 = "web/test/code-search-ui.test.ts(12,10): error TS2307: Cannot find module '../ui/src/codeSearchSetup' or its corresponding type declarations.";

describe('the typecheck errors the red gate reports', () => {
  test('an import that needs its extension is kept, with the file and the code', () => {
    expect(typecheckFailures(TS2835, ['web/test/code-search-ui.test.ts'])).toEqual([
      `TYPECHECK: web/test/code-search-ui.test.ts(59,39) TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean '../ui/src/api.js'?`,
    ]);
  });

  test('a module the tests expect and the code does not have yet is expected before implementation, not a defect', () => {
    expect(typecheckFailures(TS2307, ['web/test/code-search-ui.test.ts'])).toEqual([]);
    expect(typecheckFailures("web/test/a.test.ts(3,14): error TS2339: Property 'output' does not exist on type 'ApiError'.", ['web/test/a.test.ts'])).toEqual([]);
    expect(typecheckFailures("web/test/a.test.ts(4,20): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.", ['web/test/a.test.ts'])).toEqual([]);
  });

  test('an error in another file is not the test file the red gate wrote', () => {
    expect(typecheckFailures("src/index.ts(1,1): error TS2835: x", ['web/test/a.test.ts'])).toEqual([]);
    expect(typecheckFailures("web/test/other.test.ts(3,1): error TS1005: ';' expected.", ['web/test/a.test.ts'])).toEqual([]);
  });

  test('a parse error in a task test file is kept, and an absolute path and colour codes are read', () => {
    const red = `\u001b[31m${path.join('/repo', 'web/test/a.test.ts')}(3,1): error TS1005: ';' expected.\u001b[0m`;
    expect(typecheckFailures(red, ['web/test/a.test.ts'])).toEqual([
      `TYPECHECK: /repo/web/test/a.test.ts(3,1) TS1005: ';' expected.`,
    ]);
  });
});

describe('the static checks at the red gate', () => {
  const STYLISH = '/repo/web/test/a.test.ts\n  4:9  error  \'vi\' is defined but never used  @typescript-eslint/no-unused-vars\n\n/repo/src/other.ts\n  1:1  error  Unexpected any  @typescript-eslint/no-explicit-any\n\n✖ 2 problems (2 errors, 0 warnings)\n';

  test('runs the lint and typecheck commands and reports only the task test files', async () => {
    const dir = tmp('sdlc-red-checks-');
    fs.writeFileSync(path.join(dir, 'lint.txt'), STYLISH);
    fs.writeFileSync(path.join(dir, 'ts.txt'), `${TS2835.replace('web/test/code-search-ui.test.ts', 'web/test/a.test.ts')}\n${TS2307.replace('web/test/code-search-ui.test.ts', 'web/test/a.test.ts')}\n`);
    const ctx = makeCtx(dir, { lint: 'cat lint.txt; exit 1', typecheck: 'cat ts.txt; exit 2' });
    const fails = await staticCheckFailures(ctx, ['web/test/a.test.ts']);
    expect(fails).toEqual([
      "LINT: /repo/web/test/a.test.ts:4:9 'vi' is defined but never used (@typescript-eslint/no-unused-vars)",
      "TYPECHECK: web/test/a.test.ts(59,39) TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean '../ui/src/api.js'?",
    ]);
    // the log the run page points at holds both commands' output, for the files it kept and the ones it did not
    const log = fs.readFileSync(path.join(dir, 'logs/red-checks.log'), 'utf8');
    expect(log).toContain('$ cat lint.txt; exit 1');
    expect(log).toContain('$ cat ts.txt; exit 2');
    expect(log).toContain('Unexpected any');
  });

  test('a new test that only expects code which does not exist yet passes: no failure, no log', async () => {
    const dir = tmp('sdlc-red-checks-ok-');
    fs.writeFileSync(path.join(dir, 'ts.txt'), `${TS2307}\n`);
    const ctx = makeCtx(dir, { typecheck: 'cat ts.txt; exit 2' });
    expect(await staticCheckFailures(ctx, ['web/test/code-search-ui.test.ts'])).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'logs/red-checks.log'))).toBe(false);
  });

  test('a project with no lint or typecheck command is not checked', async () => {
    const dir = tmp('sdlc-red-checks-none-');
    const ctx = makeCtx(dir);
    expect(await staticCheckFailures(ctx, ['web/test/a.test.ts'])).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'logs'))).toEqual([]);
  });

  test('a lint failure in another file does not stop the red gate', async () => {
    const dir = tmp('sdlc-red-checks-other-');
    fs.writeFileSync(path.join(dir, 'lint.txt'), '/repo/src/other.ts\n  1:1  error  Unexpected any  @typescript-eslint/no-explicit-any\n');
    const ctx = makeCtx(dir, { lint: 'cat lint.txt; exit 1' });
    expect(await staticCheckFailures(ctx, ['web/test/a.test.ts'])).toEqual([]);
  });
});

describe('the linter output the red gate reads', () => {
  test('still reads as it did: one LINT line per rule failure, the fallback sample when nothing parses', () => {
    expect(lintFailures('/repo/src/a.ts\n  70:81  error  Unnecessary escape character: \\/  no-useless-escape\n')).toEqual([
      'LINT: /repo/src/a.ts:70:81 Unnecessary escape character: \\/ (no-useless-escape)',
    ]);
    expect(lintFailures('something went wrong: error loading config\n')).toEqual(['LINT: something went wrong: error loading config']);
  });
});
