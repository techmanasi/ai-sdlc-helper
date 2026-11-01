#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  configFile: path.join(root, 'web/ui/vite.config.ts'),
  server: { host: '127.0.0.1' },
});

function signedUrl() {
  try { return fs.readFileSync(process.env.SDLC_UI_SIGNIN_FILE, 'utf8').trim(); } catch { return ''; }
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no desktop browser */ }
}

await server.listen();
server.printUrls();
server.bindCLIShortcuts({
  print: true,
  customShortcuts: [
    {
      key: 'u',
      description: 'show signed sign-in URL',
      action() {
        const url = signedUrl();
        server.config.logger.info(url ? `\n  Sign-in URL: ${url}` : '\n  No signed URL is available; start with npm run dev.');
      },
    },
    {
      key: 'o',
      description: 'open signed server URL',
      action() {
        const url = signedUrl();
        if (url) openBrowser(url);
        else server.config.logger.info('\n  No sign-in or dev URL is available.');
      },
    },
    ...(process.send ? [{
      key: 'b',
      description: 'rebuild and restart the app',
      action() {
        server.config.logger.info('\n  Rebuilding, then restarting the UI server...');
        process.send({ type: 'build-restart' });
      },
    }] : []),
  ],
});
