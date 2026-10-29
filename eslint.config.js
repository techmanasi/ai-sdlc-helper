import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'assets/', '.claude/', 'graft/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // The web app stays apart from the engine: it uses only the package's public entry ('ai-sdlc-helper').
    files: ['web/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/src/*', '**/src/**', '**/dist/*', '**/dist/**'], message: "Import the engine from 'ai-sdlc-helper' (src/index.ts), not its files." }] }],
    },
  },
  {
    // The engine never depends on the web app.
    files: ['src/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/web/*', '**/web/**'], message: 'src/ must not import web/.' }] }],
    },
  },
);
