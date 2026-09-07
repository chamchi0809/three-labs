import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
// `tscene-editor/vite` is this same file, and would be the import — but vite loads a config by bundling it
// with every bare specifier left external, and the editor exports its sources, so node is handed a raw .ts
// and refuses it (ERR_UNKNOWN_FILE_EXTENSION). A relative path is inlined into the bundle instead, which is
// also how the editor's own config reaches its baker. Nothing at runtime imports across the boundary.
import { sheets } from "../editor/src/io/server.ts";

export default defineConfig({
  // `sheets()` is the save endpoint the mounted editor posts to: it writes public/scenes/*.tscene and
  // refuses everything else. Dev only, and it is the whole of what turns a browser tab into an editor
  // that edits the repository.
  plugins: [svelte(), sheets()],
  resolve: {
    // The editor is a workspace package that exports its own sources — .ts and .svelte, not a build — and
    // both packages must end up on the same copy of svelte or `mount()` runs against a second, empty
    // registry of component contexts.
    dedupe: ["svelte", "three"],
  },
  optimizeDeps: {
    // esbuild's pre-bundler cannot compile .svelte, so the editor has to reach the svelte plugin as source
    exclude: ["tscene-editor"],
  },
  // top-level await in src/main.ts needs an esnext target
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  server: {
    port: 8127,
    watch: {
      // The level lives in public/, because the game fetches it and a fetched file has to be served. But
      // the editor *saves* there, and a watcher firing on its own save would reload the page — throwing
      // away the session that pressed the button. So the sheets are the one thing here nobody watches:
      // the editor already has the new text; it is the one that wrote it.
      ignored: ["**/public/scenes/**"],
    },
  },
});
