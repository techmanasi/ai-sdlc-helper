// A run's pull request link, kept in its brief: in the run's worktree and in the checkout the run was started from.
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../runs/records.js';
import type { Ctx } from './context.js';
import { keepError } from './errors.js';
import { getPrFromBrief, recordPrInBrief } from './finalise.js';

const real = (p: string): string => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Records <url> as the run's pull request in <docs>/brief.md here and in the main checkout's copy (the project the run was
 * started from), replacing any older link. A brief that is missing there is left alone; one that already holds <url> is
 * not written. A failure to write is kept in errors.log and said in one line: it never stops the run.
 */
export function linkPrEverywhere(ctx: Pick<Ctx, 'root' | 'docs' | 'log' | 'env' | 'out'>, url: string): void {
  const rel = path.join(ctx.docs, 'brief.md');
  const files = [path.join(ctx.root, rel)];
  let main: string | null = null;
  try { main = projectRoot(ctx.root, ctx.env); } catch (e) {
    keepError(ctx, 'link pull request: find the main checkout', (e as Error).message);
    ctx.out(`WARNING: could not find the main checkout to link ${url} in its brief (see ${ctx.log}/errors.log)`);
  }
  if (main && real(main) !== real(ctx.root)) files.push(path.join(main, rel));
  for (const file of files) {
    let text: string;
    // A checkout without this brief has nothing to link.
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (getPrFromBrief(text) === url) continue;
    try { fs.writeFileSync(file, recordPrInBrief(text, url)); } catch (e) {
      keepError(ctx, 'link pull request in the brief', `${file}: ${(e as Error).message}`);
      ctx.out(`WARNING: could not write the pull request link into ${file} (see ${ctx.log}/errors.log)`);
    }
  }
}
