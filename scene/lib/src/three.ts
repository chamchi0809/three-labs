// Opt-in: three's whole `three/webgpu` namespace as a runtime registry.
//
// The vite plugin imports exactly the classes a `.tscene` file names, so a bundled sheet never needs
// this and a bundler can drop the rest of three. A sheet that only exists at runtime — loadScene(text),
// loadSceneFromURL(url) — cannot be analysed at build time, so it needs the full namespace:
//
// ```ts
// import { loadSceneFromURL } from "tscene";
// import { threeRegistry } from "tscene/three";
//
// const root = await loadSceneFromURL("/scenes/room.tscene", { registry: threeRegistry });
// ```
//
// Importing this pulls all of three/webgpu into the bundle. That is the trade, and it is why it is
// a separate entry point rather than the default.
import * as THREE from "three/webgpu";

/** Every `three/webgpu` export, keyed by name — a `LoadOptions["registry"]` that knows all of three. */
export const threeRegistry: Record<string, any> = THREE as unknown as Record<string, any>;
