// The ui command: starts the local web app (web/server, built into dist/web/) and opens it in the browser. The engine never
// imports the web app; this command loads its built server by path when it runs.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from './args.js';
import type { Io } from './main.js';

export const UI_COMMANDS = ['ui'];
export const UI_VALUED = ['--port'];
export const UI_FLAGS = ['--no-open'];

export const UI_USAGE = `  ui [--port <n>] [--no-open]      the local web app on 127.0.0.1 (default 4477, tries the next free port if busy;
                                   --port and SDLC_UI_PORT use a fixed port): the
                                   board, runs, questions, refused actions, backlog and settings; prints its URL and
                                   opens it unless --no-open. Runs go on when it stops (Ctrl-C).`;

interface WebServer { url: string; openUrl: string; close(): Promise<void> }
type StartServer = (o: { port?: number; env?: NodeJS.ProcessEnv; cwd?: string }) => Promise<WebServer>;

/** The built server: dist/web/server/index.js, beside this file's folder in dist/. */
export const serverFile = (): string => fileURLToPath(new URL('../web/server/index.js', import.meta.url));

/** Opens <url> in the default browser; failing to (no desktop) is not an error, the URL is printed anyway. */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try { spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => { /* no browser */ }).unref(); } catch { /* no browser */ }
}

/** Runs `ui` until SIGINT or SIGTERM. Returns 0 when stopped, 1 when it cannot start, 2 on bad arguments. */
export async function ui(argv: string[], valued: string[], io: Io, opts: { file?: string; stopSignal?: Promise<void> } = {}): Promise<number> {
  const a = parseArgs(argv, valued);
  if (a.positional.length > 1) { io.err(`ERROR: ui takes no arguments, got: ${a.positional.slice(1).join(' ')}`); return 2; }
  const env = io.env || process.env;
  const portArg = a.value('--port') ?? env.SDLC_UI_PORT;
  if (portArg !== undefined && !/^\d+$/.test(portArg)) { io.err('ERROR: --port needs a number'); return 2; }
  const file = opts.file || serverFile();
  if (!fs.existsSync(file)) { io.err(`ERROR: the web app is not built (${file} is missing). Run: npm run build`); return 1; }
  const { startServer } = await import(pathToFileURL(file).href) as { startServer: StartServer };
  let server: WebServer;
  try {
    server = await startServer({ port: portArg === undefined ? undefined : Number(portArg), env, cwd: io.cwd || process.cwd() });
  } catch (e) {
    io.err(`ERROR: could not start the web app: ${(e as Error).message}`);
    return 1;
  }
  io.out(`ai-sdlc-helper ui: ${server.url}`);
  io.out(`Open (signs this browser in): ${server.openUrl}`);
  io.out('Stop with Ctrl-C; runs go on without it.');
  if (!a.flag('--no-open')) openBrowser(server.openUrl);
  await (opts.stopSignal || new Promise<void>(res => {
    const stopNow = () => { process.off('SIGINT', stopNow); process.off('SIGTERM', stopNow); res(); };
    process.on('SIGINT', stopNow);
    process.on('SIGTERM', stopNow);
  }));
  await server.close();
  return 0;
}
