// Reading a repository's layout from its files, with no git call: where the shared git folder is, and a stamp of
// files and folders that changes when they do. Used to keep the answer of a git command until its inputs change
// (docs/plans/web-performance.md, P3).
import fs from 'node:fs';
import path from 'node:path';

/** The git common dir of the checkout at <root> (a main checkout or a worktree); null when <root> is not one. */
export function commonDirOf(root: string): string | null {
  const dot = path.join(root, '.git');
  try {
    if (fs.statSync(dot).isDirectory()) return dot;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
    if (!m) return null;
    const gitDir = path.resolve(root, m[1].trim());
    try { return path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { return gitDir; }
  } catch { return null; }
}

/** The files whose change means the commits or the staged files of the working tree at <worktree> changed, read without running git. */
export function worktreeInputs(worktree: string, commonDir: string | null, branch: string): string[] {
  const dot = path.join(worktree, '.git');
  let gitDir = dot;
  try {
    if (!fs.statSync(dot).isDirectory()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
      if (m) gitDir = path.resolve(worktree, m[1].trim());
    }
  } catch { gitDir = dot; }
  const out = [path.join(gitDir, 'HEAD'), path.join(gitDir, 'index')];
  if (commonDir) {
    out.push(path.join(commonDir, 'packed-refs'));
    if (branch) out.push(path.join(commonDir, 'refs', 'heads', branch));
  }
  return out;
}

/** One text for the modification time and size of each path ('-' for a missing one): equal texts, nothing changed. */
export const stampOf = (files: readonly string[]): string =>
  files.map(f => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } }).join('|');

/**
 * What changes when a branch <prefix>… is added, removed or packed, locally or on origin: the packed refs file, the
 * two ref folders, and the folders the prefix names under each (for "sdlc/": refs/heads/sdlc). A new commit on a
 * branch in one of these folders also touches the folder (git writes through a lock file), which costs one more read
 * and gives the same names.
 */
export function branchNameInputs(commonDir: string, prefix: string): string[] {
  const folders = prefix.split('/').slice(0, -1).filter(Boolean);
  const out = [path.join(commonDir, 'packed-refs')];
  for (const base of ['refs/heads', 'refs/remotes/origin']) {
    out.push(path.join(commonDir, base));
    for (let i = 1; i <= folders.length; i++) out.push(path.join(commonDir, base, ...folders.slice(0, i)));
  }
  return out;
}
