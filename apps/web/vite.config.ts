import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.API_URL ?? 'http://127.0.0.1:8787';
const coreSource = fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Bundle core from source: no build step between editing the engine and
  // seeing the result in the browser.
  resolve: { alias: { '@atp/core': coreSource } },
  server: {
    port: 5173,
    // Keeps the browser on one origin in development, so no CORS in the way.
    proxy: { '/api': { target: apiTarget, changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
