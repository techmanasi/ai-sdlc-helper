// Mechanical checks for the Test repair stage. Each check returns its rejects (an empty list passes).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shellWord } from '../util.js';
import { norm } from '../runners/types.js';
import { SUITE_FAILED, isResult, isRunResult, type Keys } from './keys.js';

const count = (s: string, re: RegExp) => (s.match(re) || []).length;
const WEAK = /\.(toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|toBeNull)\(|expect\.(anything|any)\(/g;
const SKIP = /\.(skip|only|todo)\(|\b(xit|xtest|xdescribe|fit|fdescribe)\(/g;
const escapeRe = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lines = (out: string | null) => (out || '').split('\n').filter(Boolean);

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const tryGit = (cwd: string, ...a: string[]) => { try { return git(cwd, ...a); } catch { return null; } };
const readJson = (file: string) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Failing keys of <nowJson> that test-issues.md does not claim. */
export function unclaimed(k: Keys, nowJson: string, issuesFile: string): string[] {
  const claimed = new Set(k.claims(issuesFile).map(x => x.key));
  return [...k.results(nowJson).failed].filter(key => !claimed.has(key));
}

/** Keys grouped by file, in input order. */
function byFile(keys: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const key of keys.filter(Boolean)) {
    const i = key.indexOf('::');
    const file = key.slice(0, i);
    if (!map.has(file)) map.set(file, []);
    map.get(file)!.push(key.slice(i + 2));
  }
  return map;
}

/** Per file: [file, Jest -t pattern], the pattern empty (the whole file) when the file failed to run. */
export const retryPlan = (keys: string[]): [string, string][] => [...byFile(keys)].map(([file, names]) =>
  [file, names.includes(SUITE_FAILED) ? '' : `^(?:${names.map(escapeRe).join('|')})$`]);

/** Per file: [file from the root, ...full names] for `run --file <file> --test <name>...`; no names = the whole file. */
export const retryArgs = (k: Keys, keys: string[]): string[][] => [...byFile(keys)].map(([file, names]) =>
  [k.rootPath(file), ...(names.includes(SUITE_FAILED) ? [] : names)]);

/**
 * Unclaimed failures of <nowJson> that passed on a re-run (and failed in none) become passed in <nowJson>, with a line
 * each in <flakyFile>. Unreadable re-run files are ignored. Returns the flaky keys.
 */
export function mergeRetry(k: Keys, nowJson: string, issuesFile: string, flakyFile: string, retryFiles: string[]): string[] {
  const keys = unclaimed(k, nowJson, issuesFile);
  const reruns = retryFiles.map(f => readJson(path.resolve(k.cwd, f))).filter(isResult).map(j => k.collect(j));
  const flaky = keys.filter(key => (key.endsWith(`::${SUITE_FAILED}`)
    ? reruns.some(r => r.passedFiles.has(key.slice(0, key.lastIndexOf('::'))))
    : reruns.some(r => r.passed.has(key)) && !reruns.some(r => r.failed.has(key))));
  if (!flaky.length) return flaky;
  const set = new Set(flaky);
  const nowFile = path.resolve(k.cwd, nowJson);
  const j = JSON.parse(fs.readFileSync(nowFile, 'utf8'));
  if (isRunResult(j)) {
    j.suiteErrors = (j.suiteErrors || []).filter((e: any) => !set.has(`${k.rel(e.file || '<unknown>')}::${SUITE_FAILED}`));
    for (const t of j.tests) if (set.has(`${k.rel(t.file || '<unknown>')}::${norm(t.name)}`)) t.status = 'passed';
  } else {
    for (const f of j.testResults) {
      const file = k.fileOf(f);
      if (set.has(`${file}::${SUITE_FAILED}`)) f.status = 'passed';
      for (const t of f.assertionResults) if (set.has(`${file}::${norm(t.fullName)}`)) t.status = 'passed';
    }
  }
  fs.writeFileSync(nowFile, JSON.stringify(j));
  fs.appendFileSync(path.resolve(k.cwd, flakyFile), flaky.map(key => `${key} :: first run: failed :: re-run: passed\n`).join(''));
  return flaky;
}

/** Failing tests must all be claimed; claims capped at <max>, existing, and justified. */
export function precheck(k: Keys, nowJson: string, issuesFile: string, max = 3): string[] {
  const cl = k.claims(issuesFile);
  const { all, failed } = k.results(nowJson);
  const errs: string[] = [];
  const keys = new Set(cl.map(x => x.key));
  if (!cl.length) errs.push('test-issues.md has no valid "<file> :: <test name> :: <reason>" lines');
  if (cl.length > max) errs.push(`${cl.length} tests claimed wrong; the limit is ${max}`);
  for (const key of keys) if (!all.has(key)) errs.push(`claimed test does not exist: ${key}`);
  for (const key of failed) if (!keys.has(key)) errs.push(`failing test is NOT claimed as a test defect (source bug, not test repair): ${key}`);
  for (const x of cl) if (!/(spec|plan|decision|round|S-R|isolat|mock)/i.test(x.why)) errs.push(`claim gives no spec/plan/decision/isolation justification: ${x.key}`);
  return errs;
}

/** Since <redSha>: only claimed test files changed; no skips, no weaker or fewer assertions, no fewer tests. */
export function diffcheck(k: Keys, redSha: string, issuesFile: string): string[] {
  const { cwd } = k;
  const specs = k.layout.pathspecs;
  const errs: string[] = [];
  const allowed = new Set(k.claims(issuesFile).map(x => k.rootPath(x.file)));
  const changed = new Set(lines(git(cwd, 'diff', '--name-only', redSha, '--', ...specs)));
  lines(git(cwd, 'ls-files', '--others', '--exclude-standard', '--', ...specs)).forEach(f => changed.add(f));
  if (!changed.size) errs.push('no test file was changed');
  for (const f of changed) {
    if (!allowed.has(f)) { errs.push(`changed a test file that was not claimed: ${f}`); continue; }
    const old = tryGit(cwd, 'show', `${redSha}:${f}`);
    if (old === null) { errs.push(`claimed file did not exist at red: ${f}`); continue; }
    const now = fs.readFileSync(path.join(cwd, f), 'utf8');
    if (count(now, /\bexpect\(/g) < count(old, /\bexpect\(/g)) errs.push(`fewer expect() calls than at red in ${f}`);
    if (count(now, WEAK) > count(old, WEAK)) errs.push(`weaker matchers added (toBeDefined/toBeTruthy/expect.anything...) in ${f}`);
    if (count(now, SKIP) > count(old, SKIP)) errs.push(`skip/only/todo added in ${f}`);
    if (count(now, /\b(it|test)\(/g) < count(old, /\b(it|test)\(/g)) errs.push(`fewer it()/test() blocks than at red in ${f}`);
  }
  return errs;
}

/** Every test that existed at red still exists. */
export function namecheck(k: Keys, redJson: string, nowJson: string): string[] {
  const now = k.results(nowJson).all;
  return [...k.results(redJson).all].filter(key => !now.has(key)).map(key => `test removed or renamed: ${key}`);
}

/** A test that detected the missing behaviour at red must still detect it after repair (on the red source). */
export function redcheck(k: Keys, redJson: string, repairedOnRedJson: string, issuesFile?: string): string[] {
  const redResults = k.results(redJson);
  const repResults = k.results(repairedOnRedJson);
  const claimedKeys = issuesFile ? new Set(k.claims(issuesFile).map(x => x.key)) : null;
  const redFailed = [...redResults.failed].filter(key => (claimedKeys ? claimedKeys.has(key) : true));
  return redFailed.filter(key => !repResults.failed.has(key))
    .map(key => `test failed at red but now PASSES on the unimplemented source (no longer detects the bug): ${key}`);
}

/**
 * Read-only preconditions for resuming at Test repair. <redSha> may be empty (no red-tests commit found). Test changes
 * count from <lockSha> (default <redSha>), the commit the run continues from, so a merge into a paused run is not one.
 */
export function resumecheck(k: Keys, redSha: string, issuesFile: string, slug: string, lockSha?: string): string[] {
  const { cwd } = k;
  const specs = k.layout.pathspecs;
  const errs: string[] = [];
  let sha = redSha || '';
  const lock = lockSha || sha;
  if (!sha) errs.push(`no red-tests commit found for ${slug} (expected a commit with subject "test(${slug}): add failing tests")`);
  else if (tryGit(cwd, 'rev-parse', '--verify', '--quiet', `${sha}^{commit}`) === null) { errs.push(`red-tests commit ${sha} is not a known commit`); sha = ''; }
  const claimFile = path.resolve(cwd, issuesFile);
  if (!fs.existsSync(claimFile)) errs.push(`claim file is missing: ${issuesFile}`);
  else if (!fs.readFileSync(claimFile, 'utf8').trim()) errs.push(`claim file is empty: ${issuesFile}`);
  else if (!k.claims(issuesFile).length) errs.push(`claim file has no valid "<file> :: <test name> :: <reason>" lines: ${issuesFile}`);
  if (sha) {
    const esc = slug.replace(/[.*^$[\]\\]/g, '\\$&');
    const repaired = (tryGit(cwd, 'log', '--format=%h', '-1', `--grep=^test(${esc}): repair invalid tests`, `${sha}..HEAD`) || '').trim();
    if (repaired) errs.push(`test repair was already accepted in commit ${repaired}: use FROM=review`);
    const untracked = lines(tryGit(cwd, 'ls-files', '--others', '--exclude-standard'));
    const tests = [...new Set([...lines(tryGit(cwd, 'diff', '--name-only', lock, '--', ...specs)),
      ...lines(tryGit(cwd, 'ls-files', '--others', '--exclude-standard', '--', ...specs))])];
    const words = specs.map(shellWord).join(' ');
    if (tests.length) errs.push(`tests changed since ${lock === sha ? 'the red-tests commit' : 'the commit the run continues from'} ${lock.slice(0, 7)}: ${tests.join(', ')}; restore with: git checkout ${lock} -- ${words} && git clean -fd ${words}`);
    const testSet = new Set(tests);
    const impl = [...new Set([...lines(tryGit(cwd, 'diff', '--name-only', sha)), ...untracked])].filter(f => !testSet.has(f) && !f.startsWith('Docs/'));
    if (!impl.length) errs.push(`no implementation change since the red-tests commit (changes only to tests (${specs.join(', ')}) or Docs/ do not count)`);
  }
  return errs;
}
