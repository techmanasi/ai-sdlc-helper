import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The app is built into dist/web/ui, which the server (web/server) serves. `npx vite web/ui` serves it for development;
// set SDLC_UI_API to a running `ai-sdlc-helper ui` (http://127.0.0.1:4477) to send /api there.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { outDir: fileURLToPath(new URL('../../dist/web/ui', import.meta.url)), emptyOutDir: true, target: 'es2020' },
  server: process.env.SDLC_UI_API ? { proxy: { '/api': { target: process.env.SDLC_UI_API, changeOrigin: false } } } : {},
});
