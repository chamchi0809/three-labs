import { defineConfig } from "vite";
import threeScene from "tscene/vite";

export default defineConfig({
  plugins: [threeScene()],
  // top-level await in src/main.ts needs an esnext target
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  server: { port: 8126 },
});
