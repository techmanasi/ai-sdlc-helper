// The Finalise stage: commit exactly the files this cycle changed, tick the backlog item, report what was skipped,
// and optionally push to origin and create a GitHub PR, recording the PR link in brief.md.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { has } from '../util.js';
import { changed, mirror, type Baseline } from '../changes/index.js';
import type { Git } from './git.js';

export interface FinaliseOptions {
  git: Git;
  slug: string;
  /** The item's folder, from the root. */
  docs: string;
  /** The baseline taken at the start of the cycle, from the root. */
  baseline: string;
  /** The backlog index, from the root. */
  backlog: string;
  maxBytes?: number;
  /** Copy keys added to a git-ignored .env into .env.example (finalise.envExample). */
  envExample?: boolean;
  createPr?: boolean;
  baseBranch?: string;
  out(line: string): void;
  err(line: string): void;
}

export interface FinaliseResult {
  committed: number;
  pr: string | null;
}

/** Parses the PR URL from brief.md frontmatter or body. */
export function getPrFromBrief(text: string): string | null {
  const fmM = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmM) {
    const prLine = fmM[1].match(/^pr:\s*(\S+)/im);
    if (prLine) return prLine[1].trim();
  }
  const bodyM = text.match(/^(?:PR|pr):\s*(https?:\/\/\S+)/im);
  return bodyM ? bodyM[1].trim() : null;
}

/** Inserts or updates the PR URL in brief.md frontmatter. */
export function recordPrInBrief(text: string, prUrl: string): string {
  if (/^---\r?\n([\s\S]*?)\r?\n---/.test(text)) {
    return text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (_, fm) => {
      if (/^pr:\s*.*$/im.test(fm)) {
        return `---\n${fm.replace(/^pr:\s*.*$/im, `pr: ${prUrl}`).trim()}\n---`;
      }
      return `---\n${fm.trim()}\npr: ${prUrl}\n---`;
    });
  }
  if (/^PR:\s*.*$/im.test(text)) {
    return text.replace(/^PR:\s*.*$/im, `PR: ${prUrl}`);
  }
  return `---\npr: ${prUrl}\n---\n\n${text.trimStart()}`;
}

/** Finds or creates a GitHub PR for the branch. */
export function createOrGetPr(cwd: string, branch: string, title: string, body: string, base?: string): string | null {
  // Check if PR already exists
  try {
    const view = spawnSync('gh', ['pr', 'view', branch, '--json', 'url', '-q', '.url'], { cwd, encoding: 'utf8' });
    if (view.status === 0 && view.stdout.trim().startsWith('http')) {
      return view.stdout.trim();
    }
  } catch { /* gh might not be installed or authenticated */ }

  try {
    const list = spawnSync('gh', ['pr', 'list', '--head', branch, '--json', 'url', '-q', '.[0].url'], { cwd, encoding: 'utf8' });
    if (list.status === 0 && list.stdout.trim().startsWith('http')) {
      return list.stdout.trim();
    }
  } catch { /* best effort */ }

  // Create PR
  try {
    const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body];
    if (base) args.push('--base', base);
    const create = spawnSync('gh', args, { cwd, encoding: 'utf8' });
    if (create.status === 0) {
      const match = (create.stdout + '\n' + create.stderr).match(/https?:\/\/[^\s]+/);
      if (match) return match[0].trim();
    }
  } catch { /* best effort */ }

  return null;
}

/**
 * Commits the cycle's files (compared with the baseline) in one feat commit and ticks the backlog item in its own. The
 * developer's own earlier changes, secrets, editor and agent configuration, generated and large files are skipped and
 * listed in <docs>/logs/finalise-skipped.md. Nothing to commit and a slug missing from the backlog are warnings.
 * When createPr is enabled, pushes the branch to origin, creates a GitHub PR if needed, and links it in brief.md.
 * Returns the finalise result (committed count and PR URL).
 */
export function finalise(o: FinaliseOptions): FinaliseResult {
  const root = o.git.root;
  const opts = { root, maxBytes: o.maxBytes };
  const log = `${o.docs}/logs`;
  fs.mkdirSync(path.join(root, log), { recursive: true });
  const logIgnore = path.join(root, log, '.gitignore');
  if (!fs.existsSync(logIgnore)) fs.writeFileSync(logIgnore, '*\n');
  const branch = o.git.run('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const baselineFile = path.join(root, o.baseline);
  if (o.envExample !== false) mirror(baselineFile, opts, line => o.err(line));
  const { include, skipped } = changed(baselineFile, opts);
  const base: Baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const backlogDirty = has(base.files, o.backlog);

  if (!include.length) o.out('WARNING: nothing to commit');
  else {
    o.git.run('add', '-A', '--', ...include);
    o.git.run('commit', '-q', '-m', `feat(${o.slug}): implement per ${o.docs}/specs-1.md`, '-m', include.slice(0, 50).join('\n'), '--', ...include);
  }

  const backlogFile = path.join(root, o.backlog);
  const item = `- [ ] \`${o.slug}\``;
  const text = fs.existsSync(backlogFile) ? fs.readFileSync(backlogFile, 'utf8') : null;
  if (text !== null && text.split('\n').some(l => l.startsWith(item))) {
    fs.writeFileSync(backlogFile, text.split('\n').map(l => (l.startsWith(item) ? `- [x] ${l.slice(6)}` : l)).join('\n'));
    if (backlogDirty) o.out(`WARNING: ${o.backlog} had local changes before the run; ticked ${o.slug} but not committed`);
    else {
      o.git.run('add', '--', o.backlog);
      o.git.run('commit', '-q', '-m', `chore(backlog): mark ${o.slug} done`, '--', o.backlog);
    }
  } else {
    o.out(`WARNING: ${o.slug} not found in ${o.backlog}; not ticked`);
  }

  const lines = skipped.map(s => `- ${s.path}: ${s.reason}`);
  const skippedFile = path.join(root, log, 'finalise-skipped.md');
  fs.writeFileSync(skippedFile, lines.map(l => `${l}\n`).join(''));
  // Backward compatibility alias for any existing logs reader
  fs.writeFileSync(path.join(root, log, 'ship-skipped.md'), lines.map(l => `${l}\n`).join(''));

  if (lines.length) { o.out('Skipped:'); for (const l of lines) o.out(l); }
  o.out('');
  o.out(`DONE: ${o.slug} on ${branch}. Committed ${include.length} file(s), skipped ${lines.length} (see ${log}/finalise-skipped.md).`);

  let prUrl: string | null = null;
  const briefFile = path.join(root, o.docs, 'brief.md');
  const briefText = fs.existsSync(briefFile) ? fs.readFileSync(briefFile, 'utf8') : '';
  prUrl = getPrFromBrief(briefText);

  if (o.createPr) {
    o.out('Pushing branch to origin and checking/creating PR...');
    try {
      o.git.run('push', '-u', 'origin', branch);
    } catch (e) {
      o.err(`WARNING: git push to origin failed: ${(e as Error).message}`);
    }

    if (!prUrl) {
      const title = `feat(${o.slug}): implement per ${o.docs}/specs-1.md`;
      const body = `Automated finalisation for \`${o.slug}\`.\n\nSpecs: \`${o.docs}/specs-1.md\``;
      prUrl = createOrGetPr(root, branch, title, body, o.baseBranch);
    }

    if (prUrl) {
      o.out(`Pull Request: ${prUrl}`);
      // Record PR in brief.md
      if (fs.existsSync(briefFile)) {
        const updatedBrief = recordPrInBrief(fs.readFileSync(briefFile, 'utf8'), prUrl);
        fs.writeFileSync(briefFile, updatedBrief);
        const briefRel = path.relative(root, briefFile);
        try {
          o.git.run('add', '--', briefRel);
          o.git.run('commit', '-q', '-m', `chore(${o.slug}): link pull request`, '--', briefRel);
          try { o.git.run('push', 'origin', branch); } catch { /* best effort */ }
        } catch { /* if nothing to commit */ }
      }
    } else {
      o.err('WARNING: could not create or detect PR (ensure gh is installed and authenticated)');
    }
  }

  return { committed: include.length, pr: prUrl };
}

// Backward-compatible alias
export const ship = (o: FinaliseOptions): number => finalise(o).committed;
export type ShipOptions = FinaliseOptions;
