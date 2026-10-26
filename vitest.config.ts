import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts}'],
    passWithNoTests: false,
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    allowOnly: false,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{js,mjs,cjs,ts,mts,cts}'],
      exclude: ['**/*.d.{ts,mts,cts}'],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100, perFile: true },
    },
  },
});
