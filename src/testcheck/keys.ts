import fs from 'node:fs';
import path from 'node:path';
import { keyDir, layout, testSpec, type Config } from '../config/settings.js';
import { norm } from '../runners/types.js';

/**
 * Where a project's tests are, as the checks need it: the test folders, the folder test keys are relative to, and the
 * test files as git pathspecs (folders, or ":(glob)" patterns for tests beside the source).
 */
export interface TestLayout {
  testDirs: string[];
  keyDir: string;
  pathspecs: string[];
}

/** The test layout from resolved settings. */
export const testLayout = (config: Config): TestLayout => ({
  testDirs: layout(config).testDirs, keyDir: keyDir(config), pathspecs: config.suites.flatMap(s => testSpec(s).pathspecs),
});

/**
 * The test layout the pipeline script passes in the environment (SDLC_TEST_DIRS colon-separated, SDLC_KEY_DIR,
 * SDLC_TEST_PATHSPECS one per line), or null when SDLC_TEST_DIRS is not set.
 */
export function layoutFromEnv(env: NodeJS.ProcessEnv): TestLayout | null {
  const testDirs = (env.SDLC_TEST_DIRS || '').split(':').filter(Boolean);
  if (!testDirs.length) return null;
  const pathspecs = (env.SDLC_TEST_PATHSPECS || testDirs.join('\n')).split('\n').filter(Boolean);
  return { testDirs, keyDir: env.SDLC_KEY_DIR || '.', pathspecs };
}

/** Failing, passing and all test keys ("<file>::<full name>") of a result file. */
export interface Collected {
  all: Set<string>;
  failed: Set<string>;
  passed: Set<string>;
  /** Files with no failure (a suite that failed to run counts as one). */
  passedFiles: Set<string>;
}

/** A line of test-issues.md: "<test file> :: <full test name> :: <reason citing the spec>". */
export interface Claim { file: string; name: string; why: string; key: string }

export const SUITE_FAILED = '<suite failed to run>';

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Result files: Jest's --json output, or a RunResult (any runner; { tests, suiteErrors }). */
export const isRunResult = (j: any): boolean => Boolean(j) && Array.isArray(j.tests);
export const isResult = (j: any): boolean => Boolean(j) && (Array.isArray(j.testResults) || isRunResult(j));

/** Test keys for a layout, with files relative to its key folder; Jest file names are resolved from <cwd>. */
export class Keys {
  constructor(readonly layout: TestLayout, readonly cwd: string = process.cwd()) {}

  private fromRoot(p: string): string {
    return p.replace(/\\/g, '/').replace(new RegExp(`^(?:.*/)?(${this.layout.testDirs.map(escRe).join('|')})/`), '$1/');
  }

  /** A test file as a key's file. */
  rel(p: string): string {
    const k = this.layout.keyDir;
    return k === '.' ? this.fromRoot(p) : this.fromRoot(p).replace(new RegExp(`^${escRe(k)}/`), '');
  }

  /** A key's file as a path from the project root. */
  rootPath(f: string): string {
    return this.layout.keyDir === '.' ? f : `${this.layout.keyDir}/${f}`;
  }

  /** The key file of a Jest testResults entry. */
  fileOf(f: { name: string }): string {
    return this.rel(path.relative(path.join(this.cwd, this.layout.keyDir), f.name) || f.name);
  }

  collect(j: any): Collected {
    const all = new Set<string>(); const failed = new Set<string>(); const passed = new Set<string>(); const passedFiles = new Set<string>();
    if (isRunResult(j)) {
      // RunResult files are relative to the project root; keys use the same form as for Jest.
      const fileFailed = new Set<string>();
      for (const e of j.suiteErrors || []) { const file = this.rel(e.file || '<unknown>'); failed.add(`${file}::${SUITE_FAILED}`); fileFailed.add(file); }
      for (const t of j.tests) {
        const file = this.rel(t.file || '<unknown>');
        const key = `${file}::${norm(t.name)}`;
        all.add(key);
        if (t.status === 'failed') { failed.add(key); fileFailed.add(file); }
        if (t.status === 'passed') { passed.add(key); passedFiles.add(file); }
      }
      for (const f of fileFailed) passedFiles.delete(f);
      return { all, failed, passed, passedFiles };
    }
    for (const f of j.testResults) {
      const file = this.fileOf(f);
      if (f.status === 'passed') passedFiles.add(file);
      if (!f.assertionResults.length && f.status === 'failed') failed.add(`${file}::${SUITE_FAILED}`);
      for (const a of f.assertionResults) {
        const key = `${file}::${norm(a.fullName)}`;
        all.add(key);
        if (a.status === 'failed') failed.add(key);
        if (a.status === 'passed') passed.add(key);
      }
    }
    return { all, failed, passed, passedFiles };
  }

  /** All and failing keys of a result file (it must exist and be JSON). */
  results(jsonFile: string): Pick<Collected, 'all' | 'failed'> {
    const { all, failed } = this.collect(JSON.parse(fs.readFileSync(path.resolve(this.cwd, jsonFile), 'utf8')));
    return { all, failed };
  }

  /** The claims in a test-issues.md file; none when it is missing. */
  claims(file: string): Claim[] {
    const abs = path.resolve(this.cwd, file);
    if (!fs.existsSync(abs)) return [];
    return fs.readFileSync(abs, 'utf8').split('\n')
      .map(l => l.replace(/^[-*]\s*/, '').split(/\s*::\s*/).map(s => s.trim()))
      .filter(p => p.length >= 3 && p[0] && p[1] && p[2])
      .map(([f, name, ...why]) => ({ file: this.rel(f), name, why: why.join(' :: '), key: `${this.rel(f)}::${norm(name)}` }));
  }
}
