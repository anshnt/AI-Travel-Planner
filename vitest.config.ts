import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const coreSource = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  // Resolve the workspace package to its source, so tests never depend on a
  // build step and a change in core is visible to server tests immediately.
  resolve: { alias: { '@atp/core': coreSource } },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx'],
    environment: 'node',
    // No test may depend on a live forecast. Anything that builds a provider
    // from the environment gets the offline climate model here.
    env: { WEATHER_PROVIDER: 'synthetic' },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
