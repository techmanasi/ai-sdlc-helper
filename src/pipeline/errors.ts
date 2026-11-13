// The whole text of errors that the run output shortens to one line.
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from './context.js';

/** Keeps the whole text of an error in logs/errors.log (what a one-line message in run.out cannot hold), with the time and where it happened. */
export function keepError(ctx: Pick<Ctx, 'root' | 'log'>, where: string, text: string): void {
  try {
    const dir = path.join(ctx.root, ctx.log);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'errors.log'), `=== ${new Date().toISOString()} ${where}\n${String(text).trim()}\n\n`);
  } catch { /* keeping an error must never fail the run */ }
}
