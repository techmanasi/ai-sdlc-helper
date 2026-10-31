#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const uiOnly = args.includes('--ui');
const serverOnly = args.includes('--server');

// Ensure initial build exists before watching
const binFile = path.join(root, 'dist/bin.js');
const serverFile = path.join(root, 'dist/web/server/index.js');
if (!fs.existsSync(binFile) || !fs.existsSync(serverFile)) {
  console.log('Building initial artifacts...');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

const procs = [];

function run(cmd, cmdArgs, env = {}) {
  const p = spawn(cmd, cmdArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  procs.push(p);
  p.on('exit', (code) => {
    if (code && code !== 0 && code !== 130) {
      console.error(`[dev] Process exited with code ${code}: ${cmd} ${cmdArgs.join(' ')}`);
    }
  });
  return p;
}

function cleanup() {
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', () => cleanup());

if (!uiOnly) {
  run('npx', ['tsc', '-p', 'tsconfig.build.json', '-w', '--preserveWatchOutput']);
  run('npx', ['tsc', '-p', 'web/tsconfig.build.json', '-w', '--preserveWatchOutput']);
  run('node', ['--watch', '--watch-path=dist/web/server', 'dist/bin.js', 'ui', '--no-open']);
}

if (!serverOnly) {
  run('npx', ['vite', 'web/ui'], {
    SDLC_UI_API: process.env.SDLC_UI_API || 'http://127.0.0.1:4477',
  });
}
