// Gives every agent this package's own `ai-sdlc-helper`, not an older one installed globally.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from './context.js';
import { keepError } from './errors.js';

/** The bin this package runs from (dist/bin.js next to the pipeline's own code). */
const OWN_BIN = fileURLToPath(new URL('../bin.js', import.meta.url));

const dirs = new Map<string, string | null>();

/** Creates (once per process and bin) a folder holding an `ai-sdlc-helper` launcher for <bin>; null when it could not be made. */
function launcherDir(bin: string, why: (text: string) => void): string | null {
  if (dirs.has(bin)) return dirs.get(bin) ?? null;
  let dir: string | null = null;
  try {
    if (!fs.existsSync(bin)) throw new Error(`${bin} does not exist (this package is not built)`);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-sdlc-helper-cli-'));
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, 'ai-sdlc-helper.cmd'), `@echo off\r\n"${process.execPath}" "${bin}" %*\r\n`);
    } else {
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      const file = path.join(dir, 'ai-sdlc-helper');
      fs.writeFileSync(file, `#!/bin/sh\nexec ${q(process.execPath)} ${q(bin)} "$@"\n`);
      fs.chmodSync(file, 0o755);
    }
  } catch (e) {
    why(e instanceof Error ? (e.stack || e.message) : String(e));
    dir = null;
  }
  dirs.set(bin, dir);
  return dir;
}

/** <env> with the launcher folder first on PATH (only PATH changes). A failure is kept and warned about; the env is then unchanged. */
export function withOwnCli(ctx: Pick<Ctx, 'root' | 'log' | 'out'>, env: NodeJS.ProcessEnv, bin: string = OWN_BIN): NodeJS.ProcessEnv {
  const dir = launcherDir(bin, text => {
    keepError(ctx, 'create the ai-sdlc-helper launcher for the agents', text);
    ctx.out(`WARNING: agents may run another ai-sdlc-helper than this one: could not create its launcher (see ${ctx.log}/errors.log)`);
  });
  if (!dir) return env;
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...env, [key]: env[key] ? `${dir}${path.delimiter}${env[key]}` : dir };
}
