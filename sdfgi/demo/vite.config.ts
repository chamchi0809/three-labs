import { defineConfig } from 'vite';

// top-level await in src/main.ts needs an esnext target
export default defineConfig({
  build: { target: 'esnext' },
  esbuild: { target: 'esnext' },
});
