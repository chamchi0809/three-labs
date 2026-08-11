import { defineConfig } from "vite";

// GitHub Pages serves the demo from /<repo>/, so builds are based there while
// the dev server stays at the root.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/three-rc-25d/" : "/",
  server: {
    port: 8123,
  },
}));
