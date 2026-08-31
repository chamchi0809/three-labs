import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import threeScene from "tscene/vite";
import { bakery } from "./src/bake/server.ts";

export default defineConfig({
  // The editor loads sheets it was handed at runtime, not sheets a bundler saw — but its own fixture
  // sheets go through the plugin, so a broken fixture fails the build rather than the first click.
  // `bakery` is the lightmap baker behind four dev-only routes: see src/bake/server.ts for why it is a
  // server plugin and not something the editor could have done for itself. It is also the reason this
  // config is loaded by the bundling loader rather than `--configLoader runner`: a config the runner
  // evaluated keeps its dynamic imports inside the runner, and the runner is closed once the config has
  // been read — so the baker's first `import()`, minutes later, fails with "module runner has been closed".
  plugins: [svelte(), threeScene(), bakery()],
  // top-level await in src/main.ts needs an esnext target
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  server: { port: 8126 },
});
