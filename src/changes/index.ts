// Which files did this SDLC cycle change? Used by the Finalise stage, and by the control pane for the files of each stage.
// Every function works on the git repository at <root> (its paths are relative to it).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from '../trace.js';
import { has } from '../util.js';

/** Files above this size are skipped as "too large" (the `finalise.maxFileBytes` setting). */
export const MAX_BYTES = 1024 * 1024;

export interface ChangesOptions { root: string; maxBytes?: number }
/** Path -> git content hash, null when the file is gone. */
export type FileState = Record<string, string | null>;
export interface Baseline { files: FileState; env?: Record<string, string[]> }
export interface Changed {
  include: string[];
  skipped: { path: string; reason: string }[];
  envMirror: { env: string; example: string; keys: string[] }[];
}

const git = (root: string, args: string[], input?: string): string =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input });

/** The blob hash of <file> in commit <rev>, null when the commit does not have it (the same hash git hash-object gives). */
const blobAt = (root: string, rev: string, file: string): string | null => {
  try { return execFileSync('git', ['rev-parse', '--verify', '-q', `${rev}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
};

const isFile = (f: string): boolean => fs.existsSync(f) && fs.statSync(f).isFile();

/** Every path git reports as modified, deleted, untracked or staged, with a content hash (null when the file is gone). */
export function currentState(root: string): FileState {
  const parts = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  const state: FileState = {};
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      // rename: "R  new\0old\0" is one delete (old) plus one add (new)
      const old = parts[++i];
      if (code[0] === 'R') state[old] = null;
    }
    state[file] = null;
  }
  const present = Object.keys(state).filter(f => isFile(path.join(root, f)));
  if (present.length) {
    const hashes = git(root, ['hash-object', '--stdin-paths'], `${present.join('\n')}\n`).trim().split('\n');
    present.forEach((f, i) => { state[f] = hashes[i]; });
  }
  return state;
}

const isEnvFile = (base: string): boolean => /^\.env(\..+)?$/.test(base) && base !== '.env.example';

/** The key names in an env file's text, in order, each once. */
export function parseKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
  }
  return keys;
}

// Keys of the git-ignored .env files (they never show up in git status, so they are tracked separately).
function envKeys(root: string): Record<string, string[]> {
  const keys: Record<string, string[]> = {};
  for (const file of git(root, ['ls-files', '-o', '-i', '--exclude-standard', '-z']).split('\0')) {
    if (!file || file.includes('node_modules/') || !isEnvFile(path.basename(file))) continue;
    keys[file] = parseKeys(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  return keys;
}

/** Why <file> is left out of the commit, or null. The first matching rule wins: it decides the reason the developer sees. */
export function skipReason(file: string, preExisting: boolean, { root, maxBytes = MAX_BYTES }: ChangesOptions): string | null {
  const base = path.basename(file);
  if (preExisting) return 'pre-existing local changes';
  if (isEnvFile(base) || /\.(pem|key|p12|keystore)$/.test(base) || /^id_rsa/.test(base)) return 'sensitive file';
  if (file.split('/').slice(0, -1).some(dir => ['.vscode', '.idea', '.claude'].includes(dir))) return 'local or agent configuration';
  if (file.split('/').includes('node_modules') || base === '.DS_Store') return 'generated';
  const full = path.join(root, file);
  if (fs.existsSync(full) && fs.statSync(full).size > maxBytes) return 'too large';
  return null;
}

/** Records every dirty path and its content hash, and the keys of the git-ignored .env files, in <target>. */
export function snapshot(target: string, { root }: ChangesOptions): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ files: currentState(root), env: envKeys(root) }, null, 2));
}

/** What the cycle changed since the baseline in <baselineFile>: the files to commit, those skipped and why, and new .env keys. */
export function changed(baselineFile: string, opts: ChangesOptions): Changed {
  const baseline: Baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const now = currentState(opts.root);
  const include: string[] = [];
  const skipped: Changed['skipped'] = [];
  for (const file of Object.keys(now).sort()) {
    const inBaseline = has(baseline.files, file);
    if (inBaseline && baseline.files[file] === now[file]) continue; // dirty before, untouched since
    const reason = skipReason(file, inBaseline, opts);
    if (reason) skipped.push({ path: file, reason });
    else include.push(file);
  }
  // New keys added to a git-ignored .env since the baseline, to mirror into the sibling .env.example.
  const envMirror: Changed['envMirror'] = [];
  const nowEnv = envKeys(opts.root);
  for (const file of Object.keys(nowEnv).sort()) {
    const before = baseline.env && baseline.env[file] ? baseline.env[file] : [];
    const added = nowEnv[file].filter(k => !before.includes(k));
    if (added.length) envMirror.push({ env: file, example: path.posix.join(path.posix.dirname(file), '.env.example'), keys: added });
  }
  return { include, skipped, envMirror };
}

/**
 * Copies the key names the cycle added to a git-ignored .env into its sibling .env.example, with a placeholder value
 * (never the real value). An .env.example the developer had already modified is left alone. <log> gets what was done.
 */
export function mirror(baselineFile: string, opts: ChangesOptions, log: (line: string) => void = () => {}): void {
  const baseline: Baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  for (const { example, keys } of changed(baselineFile, opts).envMirror) {
    if (has(baseline.files, example)) {
      log(`WARNING: ${example} had local changes before the run; not updated with new keys ${keys.join(', ')}`);
      continue;
    }
    const file = path.join(opts.root, example);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const missing = keys.filter(k => !parseKeys(existing).includes(k));
    if (!missing.length) continue;
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(file, existing + sep + missing.map(k => `${k}=change-me`).join('\n') + '\n');
    log(`mirrored ${missing.join(', ')} from ${path.basename(example)} sibling .env into ${example}`);
  }
}

interface StageFiles { marker: { files: FileState; head: string } | null; stages: Record<string, string[]> }

/**
 * Files each stage changed, for the control pane. The marker is the dirty state and HEAD at the last mark; what differs
 * now is credited to <stage>, the stage that just ended (no stage: only reset the marker). A file committed during a
 * stage counts for it when its committed content differs from the last mark, so a commit that merely collects earlier
 * work (Finalise) is not credited, while an earlier stage's file this stage changed and committed is.
 */
export function mark(target: string, stage: string, opts: ChangesOptions): void {
  let state: StageFiles = { marker: null, stages: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(target, 'utf8')) }; } catch { /* first mark */ }
  const now = currentState(opts.root);
  const head = git(opts.root, ['rev-parse', 'HEAD']).trim();
  if (stage && state.marker) {
    const before = state.marker.files;
    const files = new Set<string>();
    for (const f of Object.keys(now)) if (!has(before, f) || before[f] !== now[f]) files.add(f);
    if (state.marker.head !== head) {
      // A file committed during the stage counts when its committed content differs from what it was at the last mark
      // (its working copy then, or the last mark's commit when it was clean). A commit that only collects earlier work,
      // unchanged since the last mark, is not credited; a test an earlier stage wrote and this one changed is.
      for (const f of git(opts.root, ['diff', '--name-only', '-z', state.marker.head, head]).split('\0')) {
        if (f && (!has(before, f) || before[f] !== blobAt(opts.root, head, f))) files.add(f);
      }
    }
    const listed = [...files].filter(f => !skipReason(f, false, opts)).sort();
    if (listed.length) state.stages[stage] = [...new Set([...(state.stages[stage] || []), ...listed])].sort();
  }
  state.marker = { files: now, head };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(state));
}

/**
 * The files of the stage that is being redone: what <stage-files.json> credits to it, plus what changed since the last mark
 * (a stage that stopped early was never credited). A file an earlier stage is credited with is left out, so redoing a stage
 * never takes back another stage's work. <is> says whether a stage name in the file is the one asked for.
 */
export function stageWork(target: string, opts: ChangesOptions, is: (name: string) => boolean): string[] {
  let state: StageFiles = { marker: null, stages: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(target, 'utf8')) }; } catch { /* nothing recorded */ }
  const mine = new Set<string>();
  const others = new Set<string>();
  for (const [name, files] of Object.entries(state.stages)) for (const f of files) (is(name) ? mine : others).add(f);
  if (state.marker) {
    const before = state.marker.files;
    const now = currentState(opts.root);
    for (const f of Object.keys(now)) if (!has(before, f) || before[f] !== now[f]) mine.add(f);
  }
  return [...mine].filter(f => !others.has(f)).sort();
}

/** Forgets what <stage-files.json> credits to the redone stage and moves the marker to the tree as it is now. */
export function forgetStage(target: string, opts: ChangesOptions, is: (name: string) => boolean): void {
  let state: StageFiles = { marker: null, stages: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(target, 'utf8')) }; } catch { return; }
  for (const name of Object.keys(state.stages)) if (is(name)) delete state.stages[name];
  state.marker = { files: currentState(opts.root), head: git(opts.root, ['rev-parse', 'HEAD']).trim() };
  fs.writeFileSync(target, JSON.stringify(state));
}

export interface WorktreeChanges {
  /** Files changed since the merge-base with <base> (committed) or not committed yet, sorted, each once. */
  files: string[];
  /** Entries of `git status` (a rename counts once). */
  uncommitted: number;
}

const gitOrEmpty = (root: string, args: string[]): string => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
};

/**
 * What a pipeline's worktree changed: the files committed since its merge-base with <base> plus the uncommitted ones.
 * No merge-base (an orphan or unknown base) leaves only the uncommitted part. Reads nothing outside <worktree>.
 */
export function worktreeChanges(worktree: string, base: string): WorktreeChanges {
  const files = new Set<string>();
  const mb = base ? gitOrEmpty(worktree, ['merge-base', 'HEAD', base]).trim() : '';
  if (mb) for (const f of gitOrEmpty(worktree, ['diff', '--name-only', '-z', `${mb}..HEAD`]).split('\0')) if (f) files.add(f);
  // --no-optional-locks: a status read must not take index.lock while the pipeline may be committing in this worktree.
  const st = gitOrEmpty(worktree, ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  let uncommitted = 0;
  for (let i = 0; i < st.length; i++) {
    const code = st[i].slice(0, 2);
    files.add(st[i].slice(3));
    uncommitted++;
    if (/[RC]/.test(code)) i++; // the old path of a rename or copy follows
  }
  return { files: [...files].sort(), uncommitted };
}
