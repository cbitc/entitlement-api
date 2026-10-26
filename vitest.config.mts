import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Nest relies on `emitDecoratorMetadata` for constructor injection, which
// esbuild (Vitest's default transformer) does not emit. SWC does, so the test
// runtime sees the same decorator metadata as the Nest CLI build.
const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
});

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/**/*.e2e-spec.ts'],
          testTimeout: 30_000,
          // The suites share one MySQL database and each clears its tables in
          // beforeEach, so they must never run concurrently.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/**/*.module.ts', 'src/**/*.spec.ts'],
    },
  },
});
