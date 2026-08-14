import { defineConfig } from "vite";
import threeScene from "tscene/vite";
import { DECLARED } from "./declared.ts";

export default defineConfig({
  // the sheet's materials, section tables and `barrier()` come from src/registry.ts at runtime, so the
  // checker is told their names — everything else in the sheet is three's, addons included
  plugins: [threeScene({ declare: [...DECLARED] })],
  // top-level await in src/main.ts needs an esnext target
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  server: { port: 8127 },
});
