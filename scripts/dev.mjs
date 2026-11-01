#!/usr/bin/env node
import { spawn, execSync } from 'node:child_process';
import console from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const uiOnly = args.includes('--ui');
const serverOnly = args.includes('--server');
const buildFirst = args.includes('--build');
const signInDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-sdlc-dev-'));
const signInFile = path.join(signInDir, 'signin-url');

// Ensure initial build exists before watching
const binFile = path.join(root, 'dist/bin.js');
const serverFile = path.join(root, 'dist/web/server/index.js');
if (buildFirst || !fs.existsSync(binFile) || !fs.existsSync(serverFile)) {
  console.log(buildFirst ? 'Building artifacts before starting dev servers...' : 'Building initial artifacts...');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

const procs = [];
const watchers = [];
let uiProc = null;
let viteProc = null;
let building = false;

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
    if (cmd === 'node' && cmdArgs[0] === 'scripts/dev-vite.mjs') {
      console.log('[dev] Vite stopped; stopping the build watchers and UI server.');
      cleanup();
      process.exit(code ?? 0);
    }
  });
  return p;
}

function startWatchers() {
  watchers.push(run('npx', ['tsc', '-p', 'tsconfig.build.json', '-w', '--preserveWatchOutput']));
  watchers.push(run('npx', ['tsc', '-p', 'web/tsconfig.build.json', '-w', '--preserveWatchOutput']));
}

function waitForExit(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => { p.once('exit', resolve); p.kill('SIGTERM'); });
}

async function buildAndRestart() {
  if (building || uiOnly || serverOnly) return;
  building = true;
  console.log('[dev] Stopping watchers and UI server before rebuilding...');
  await Promise.all([...watchers.map(waitForExit), waitForExit(uiProc)]);
  watchers.length = 0;
  uiProc = null;

  console.log('[dev] Running npm run build...');
  const build = spawn('npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });
  procs.push(build);
  const code = await new Promise(resolve => build.once('exit', resolve));
  if (code !== 0) console.error(`[dev] Build exited with code ${code}; restarting with the current build artifacts.`);

  startWatchers();
  startUiServer();
  building = false;
}

function cleanup() {
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', () => {
  cleanup();
  fs.rmSync(signInDir, { recursive: true, force: true });
});

if (!uiOnly) {
  startWatchers();
  startUiServer();
}

if (uiOnly) {
  viteProc = run('node', ['scripts/dev-vite.mjs'], {
    SDLC_UI_API: process.env.SDLC_UI_API || 'http://127.0.0.1:4477',
    SDLC_UI_SIGNIN_FILE: signInFile,
  });
}

function startUiServer() {
  // The UI server can pick the next free port when no port was fixed. Wait for
  // its printed URL so Vite proxies to the port it actually selected.
  const ui = spawn('node', ['--watch', '--watch-path=dist/web/server', 'dist/bin.js', 'ui', '--no-open'], {
    cwd: root,
    stdio: ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, SDLC_DEV: '1' },
  });
  procs.push(ui);
  uiProc = ui;
  let pending = '';
  let lastSignInUrl = '';
  let apiUrl = '';
  ui.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    pending += text;
    const matches = [...pending.matchAll(/ai-sdlc-helper ui: (http:\/\/\S+)/g)];
    const signIns = [...pending.matchAll(/Open \(signs this browser in\): (http:\/\/\S+)/g)];
    if (matches.length) apiUrl = matches[matches.length - 1][1];
    if (signIns.length && signIns[signIns.length - 1][1] !== lastSignInUrl) {
      lastSignInUrl = signIns[signIns.length - 1][1];
      fs.writeFileSync(signInFile, lastSignInUrl, { mode: 0o600 });
      console.log(`[dev] Fresh sign-in URL (changes after a server restart): ${lastSignInUrl}`);
    }
    if (apiUrl && lastSignInUrl && !viteProc && !serverOnly) {
      viteProc = spawn('node', ['scripts/dev-vite.mjs'], {
        cwd: root,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
          ...process.env,
          SDLC_DEV: '1',
          SDLC_UI_API: process.env.SDLC_UI_API || apiUrl,
          SDLC_UI_SIGNIN_FILE: signInFile,
        },
      });
      procs.push(viteProc);
      viteProc.on('message', message => {
        if (message && message.type === 'build-restart') void buildAndRestart();
      });
      viteProc.on('exit', (code) => {
        if (building) return;
        if (code && code !== 0 && code !== 130) console.error(`[dev] Vite exited with code ${code}`);
        console.log('[dev] Vite stopped; stopping the build watchers and UI server.');
        cleanup();
        process.exit(code ?? 0);
      });
    }
    pending = pending.slice(-500);
  });
}
