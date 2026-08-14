import { defineConfig } from "vite";
import threeScene from "tscene/vite";
import { DECLARED } from "./src/loft/declared.ts";

export default defineConfig({
  // loft.tscene's materials, section tables and `barrier()` come from src/loft/registry.ts at runtime, so
  // the checker is told their names — everything else in both sheets is three's, addons included
  plugins: [threeScene({ declare: [...DECLARED] })],
  // top-level await in src/main.ts needs an esnext target
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  server: { port: 8125 },
});
