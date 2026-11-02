import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Most suites start git, node and shell processes by the hundred, so they wait on process start-up and the disk rather
// than on the CPU: with one worker per CPU they starve each other (and macOS's per-exec checks) and time out under load.
// At most 4 test files run at once; CI runners (2 to 4 CPUs) keep their default of one worker per CPU but one.
const workers = Math.max(1, Math.min(4, os.availableParallelism() - 1));

export default defineConfig({
  // web/server imports the engine by the package's name; in tests that is the source.
  resolve: { alias: { 'ai-sdlc-helper': fileURLToPath(new URL('./src/index.ts', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts', 'web/test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 60000,
    maxWorkers: workers,
    minWorkers: 1,
  },
});
