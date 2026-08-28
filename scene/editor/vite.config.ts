import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import threeScene from "tscene/vite";

export default defineConfig({
  // The editor loads sheets it was handed at runtime, not sheets a bundler saw — but its own fixture
  // sheets go through the plugin, so a broken fixture fails the build rather than the first click.
  plugins: [svelte(), threeScene()],
  // top-level await in src/main.ts needs an esnext target
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  server: { port: 8126 },
});
