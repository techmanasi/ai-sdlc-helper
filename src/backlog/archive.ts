// Task archiving: move completed tasks to an ## Archive section in index.md,
// keeping index.md cleanly structured and parseable while separating active and archived tasks.
import fs from 'node:fs';
import path from 'node:path';
import type { BacklogPlace } from './index.js';

export interface ArchiveOptions {
  olderThanDays?: number;
  all?: boolean;
}

/** Parses index.md into active lines and archive lines. */
export function splitIndexSections(text: string): { preamble: string[]; active: string[]; archive: string[] } {
  const lines = text.split(/\r?\n/);
  const preamble: string[] = [];
  const active: string[] = [];
  const archive: string[] = [];
  let inArchive = false;
  let seenItems = false;

  for (const line of lines) {
    if (/^##\s+Archive/i.test(line)) {
      inArchive = true;
      continue;
    }
    if (inArchive) {
      archive.push(line);
    } else {
      const isItem = /^- \[( |x|X|!|~)\] `[^`]+`/.test(line);
      if (isItem) {
        seenItems = true;
        active.push(line);
      } else if (!seenItems) {
        preamble.push(line);
      } else {
        // Line between/after items before archive
        active.push(line);
      }
    }
  }

  return { preamble, active, archive };
}

/** Combines sections back into index.md markdown text. */
export function joinIndexSections(preamble: string[], active: string[], archive: string[]): string {
  const cleanActive = active.filter((l, i, arr) => !(l.trim() === '' && (i === 0 || i === arr.length - 1 || arr[i - 1].trim() === '')));
  const cleanArchive = archive.filter((l, i, arr) => !(l.trim() === '' && (i === 0 || i === arr.length - 1 || arr[i - 1].trim() === '')));

  let out = preamble.join('\n').trimEnd();
  if (out) out += '\n\n';

  if (cleanActive.length) {
    out += cleanActive.join('\n').trimEnd() + '\n';
  }

  if (cleanArchive.length) {
    out += '\n## Archive\n\n' + cleanArchive.join('\n').trimEnd() + '\n';
  }

  return out;
}

/** Archives a task by slug in <backlogDir>/index.md. */
export function archiveTask(place: Pick<BacklogPlace, 'root' | 'backlogDir'>, slug: string): boolean {
  const indexFile = path.join(place.root, place.backlogDir, 'index.md');
  if (!fs.existsSync(indexFile)) return false;

  const text = fs.readFileSync(indexFile, 'utf8');
  const { preamble, active, archive } = splitIndexSections(text);

  // Check if already in archive
  if (archive.some(l => l.includes(`\`${slug}\``))) {
    return true;
  }

  // Find in active
  const itemRegex = new RegExp(`^- \\[( |x|X|!|~)\\] \`${slug}\``);
  const itemIndex = active.findIndex(l => itemRegex.test(l));
  if (itemIndex === -1) {
    return false;
  }

  let line = active[itemIndex];
  // Ensure it is marked as completed [x]
  line = line.replace(/^- \[( |x|X|!|~)\]/, '- [x]');

  active.splice(itemIndex, 1);
  archive.push(line);

  fs.writeFileSync(indexFile, joinIndexSections(preamble, active, archive));
  return true;
}

/** Unarchives a task by moving it from ## Archive back to active items. */
export function unarchiveTask(place: Pick<BacklogPlace, 'root' | 'backlogDir'>, slug: string): boolean {
  const indexFile = path.join(place.root, place.backlogDir, 'index.md');
  if (!fs.existsSync(indexFile)) return false;

  const text = fs.readFileSync(indexFile, 'utf8');
  const { preamble, active, archive } = splitIndexSections(text);

  const itemRegex = new RegExp(`^- \\[( |x|X|!|~)\\] \`${slug}\``);
  const itemIndex = archive.findIndex(l => itemRegex.test(l));
  if (itemIndex === -1) {
    return false;
  }

  const line = archive[itemIndex];
  archive.splice(itemIndex, 1);
  active.push(line);

  fs.writeFileSync(indexFile, joinIndexSections(preamble, active, archive));
  return true;
}

/** Archives all completed tasks or those completed older than a specified number of days. */
export function archiveCompleted(
  place: Pick<BacklogPlace, 'root' | 'backlogDir'>,
  opts: ArchiveOptions = { all: true },
): { archived: string[]; count: number } {
  const indexFile = path.join(place.root, place.backlogDir, 'index.md');
  if (!fs.existsSync(indexFile)) return { archived: [], count: 0 };

  const text = fs.readFileSync(indexFile, 'utf8');
  const { preamble, active, archive } = splitIndexSections(text);
  const archivedSlugs: string[] = [];

  const remainingActive: string[] = [];

  const nowMs = Date.now();
  const maxAgeMs = opts.olderThanDays ? opts.olderThanDays * 24 * 60 * 60 * 1000 : null;

  for (const line of active) {
    const match = line.match(/^- \[(x|X)\] `([^`]+)`/);
    if (match) {
      const slug = match[2];
      let shouldArchive = opts.all === true || maxAgeMs === null;

      if (maxAgeMs !== null) {
        // Check date
        const briefFile = path.join(place.root, place.backlogDir, slug, 'brief.md');
        if (fs.existsSync(briefFile)) {
          const stat = fs.statSync(briefFile);
          shouldArchive = nowMs - stat.mtimeMs >= maxAgeMs;
        }
      }

      if (shouldArchive) {
        archivedSlugs.push(slug);
        archive.push(line);
        continue;
      }
    }
    remainingActive.push(line);
  }

  if (archivedSlugs.length > 0) {
    fs.writeFileSync(indexFile, joinIndexSections(preamble, remainingActive, archive));
  }

  return { archived: archivedSlugs, count: archivedSlugs.length };
}
