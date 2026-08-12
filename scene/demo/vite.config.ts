import { defineConfig } from "vite";
import threeScene from "three-scene/vite";

export default defineConfig({
  plugins: [threeScene()],
  build: { target: "esnext" },
  server: { port: 8125 },
});
