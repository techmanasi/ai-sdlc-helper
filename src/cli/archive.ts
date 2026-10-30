// The archive command: archive completed tasks in docs/backlog/index.md.
import path from 'node:path';
import { backlogPlace } from '../backlog/index.js';
import { archiveCompleted, archiveTask, unarchiveTask } from '../backlog/archive.js';
import { parseArgs } from './args.js';
import type { Io } from './main.js';

export const ARCHIVE_COMMANDS = ['archive', 'unarchive'];
export const ARCHIVE_VALUED = ['--days', '--cwd'];
export const ARCHIVE_FLAGS = ['--all'];

export const ARCHIVE_USAGE = `  archive [slug] [--all] [--days <N>] [--cwd <path>]
                                   move completed task(s) into the ## Archive section of index.md
  unarchive <slug> [--cwd <path>]
                                   move an archived task back to the active section of index.md
`;

export async function archiveCommand(argv: string[], valued: string[], io: Io): Promise<number> {
  const cmd = argv[0];
  const a = parseArgs(argv, valued);
  const cwd = path.resolve(io.cwd || process.cwd(), a.value('--cwd') || '.');
  const place = backlogPlace(cwd);

  if (cmd === 'unarchive') {
    const slug = a.positional[1];
    if (!slug) {
      io.err('ERROR: unarchive requires a slug\n');
      return 2;
    }
    const ok = unarchiveTask(place, slug);
    if (!ok) {
      io.err(`ERROR: ${slug} not found in archive section of ${place.backlogDir}/index.md\n`);
      return 1;
    }
    io.out(`Unarchived ${slug}\n`);
    return 0;
  }

  // archive
  const slug = a.positional[1];
  const all = a.flag('--all');
  const daysStr = a.value('--days');
  const days = daysStr ? parseInt(daysStr, 10) : undefined;

  if (slug) {
    const ok = archiveTask(place, slug);
    if (!ok) {
      io.err(`ERROR: ${slug} not found in ${place.backlogDir}/index.md\n`);
      return 1;
    }
    io.out(`Archived ${slug}\n`);
    return 0;
  }

  if (all || days !== undefined) {
    const res = archiveCompleted(place, { all, olderThanDays: days });
    io.out(`Archived ${res.count} completed task(s)${res.count ? `: ${res.archived.join(', ')}` : ''}\n`);
    return 0;
  }

  io.err('Usage: ai-sdlc-helper archive [slug] [--all] [--days <N>]\n');
  return 2;
}
