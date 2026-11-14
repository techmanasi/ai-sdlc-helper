// tests.allowFailures: failing tests that do not block. An entry is a test file or glob ("test/e2e/*.test.ts"), or a
// file plus one test's full name ("test/a.test.ts > suite rejects input"). Red tests (the task's own) are never allowed.
import fs from 'node:fs';
import { globToRegex } from '../config/globs.js';
import { at, type Ctx } from './context.js';
import { redPattern, repairPattern } from './git.js';

export interface AllowEntry { filePattern: string; testName: string | null }
export interface FailedTest { file: string; name?: string }

const SEPARATOR = ' > ';

/** An entry as its file pattern and, after the first " > ", the full test name (null: every test in the file). */
export function parseAllowEntry(entry: string): AllowEntry {
  const i = entry.indexOf(SEPARATOR);
  if (i < 0) return { filePattern: entry.trim(), testName: null };
  return { filePattern: entry.slice(0, i).trim(), testName: entry.slice(i + SEPARATOR.length) };
}

/** Whether <entry> covers the failure of <testName> in <file>: glob match on the file, exact match on a named test. */
export function matchesAllowEntry(entry: string, file: string, testName?: string | null): boolean {
  const { filePattern, testName: wanted } = parseAllowEntry(entry);
  if (!new RegExp(globToRegex(filePattern)).test(file)) return false;
  return wanted === null || (testName !== undefined && testName !== null && testName === wanted);
}

/** Whether <file> (and <testName>) belongs to the task's red tests: changed in any red/repair commit, or failing in red.json. */
export function isRedTest(ctx: Ctx, file: string, _testName?: string | null): boolean {
  if (ctx.git) {
    const shas: string[] = [];
    if (ctx.slug && ctx.git.findCommits) {
      try { shas.push(...ctx.git.findCommits([redPattern(ctx.slug), repairPattern(ctx.slug)])); } catch { /* ignore */ }
    }
    if (ctx.redSha && !shas.includes(ctx.redSha)) shas.push(ctx.redSha);
    for (const sha of shas) {
      try {
        const changed = ctx.git.lines('diff', '--name-only', `${sha}^`, sha, '--', ...(ctx.layout?.testPathspecs || []));
        if (changed.some(f => f.trim() === file)) return true;
      } catch { /* no parent or git error: fall through */ }
    }
  }
  const redPath = at(ctx, `${ctx.log}/red.json`);
  if (fs.existsSync(redPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(redPath, 'utf8'));
      if ((data.tests || []).some((t: { status?: string; file?: string }) => t.status === 'failed' && t.file === file)) return true;
    } catch { /* corrupt: not red */ }
  }
  return false;
}

/** Splits <failures> into those <allowList> waives and those that still block. A red test is never waived: it gets a WARNING. */
export function checkAllowedFailures(
  failures: FailedTest[], allowList: string[], isRed: (file: string, name?: string) => boolean, warn: (msg: string) => void,
): { allowed: FailedTest[]; blocked: FailedTest[] } {
  const allowed: FailedTest[] = [];
  const blocked: FailedTest[] = [];
  for (const f of failures) {
    const entry = allowList.find(e => matchesAllowEntry(e, f.file, f.name));
    if (entry === undefined) { blocked.push(f); continue; }
    if (isRed(f.file, f.name)) {
      warn(`WARNING: tests.allowFailures entry "${entry}" ignored: ${f.file}${f.name ? ` :: ${f.name}` : ''} is a red test and must pass`);
      blocked.push(f);
    } else allowed.push(f);
  }
  return { allowed, blocked };
}
