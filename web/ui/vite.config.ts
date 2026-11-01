import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

function localDevSignInPlugin(): Plugin {
  return {
    name: 'local-dev-sign-in-tab',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/signin-url', (_req, res) => {
        let url = '';
        try { url = readFileSync(process.env.SDLC_UI_SIGNIN_FILE || '', 'utf8').trim(); } catch { /* not ready */ }
        res.statusCode = url ? 200 : 503;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ url }));
      });
    },
    transformIndexHtml() {
      return [{
        tag: 'script',
        attrs: { type: 'module' },
        injectTo: 'head',
        children: `
          if (new URLSearchParams(location.search).get('sdlc-track') === '1') {
            const key = 'ai-sdlc-helper.sign-in-url';
            const check = async () => {
              try {
                const response = await fetch('/__dev/signin-url', { cache: 'no-store' });
                if (!response.ok) return;
                const { url } = await response.json();
                if (!url || sessionStorage.getItem(key) === url) return;
                sessionStorage.setItem(key, url);
                const target = new URL(url);
                target.searchParams.set('return', location.href);
                location.replace(target);
              } catch { /* retry on the next poll */ }
            };
            void check();
            setInterval(check, 1000);
          }
        `,
      }];
    },
  };
}

// The app is built into dist/web/ui, which the server (web/server) serves. `npx vite web/ui` serves it for development;
// set SDLC_UI_API to a running `ai-sdlc-helper ui` (http://127.0.0.1:4477) to send /api there.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  plugins: process.env.SDLC_DEV === '1' ? [localDevSignInPlugin()] : [],
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  build: { outDir: fileURLToPath(new URL('../../dist/web/ui', import.meta.url)), emptyOutDir: true, target: 'es2020' },
  server: process.env.SDLC_UI_API ? { proxy: { '/api': { target: process.env.SDLC_UI_API, changeOrigin: false } } } : {},
});
