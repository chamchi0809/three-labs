/**
 * tscene/bakery — path-traced lightmaps for tscene / three.js scenes, baked on a headless WebGPU
 * device in Node.
 *
 * This entry point is the browser half: it applies a bake to a live scene and nothing more.
 *
 * ```ts
 * const lightmap = await applyLightmap(scene, "/lightmaps/room.lightmap.json");
 * lightmap.enabled = false;   // and the scene is back on its own lights
 * ```
 *
 * The atlas holds irradiance, which is exactly what three's `lightMap` slot expects, so this is a
 * texture assignment and a `uv1` attribute — no custom material.
 *
 * The baker itself pulls in sharp, xatlas and Dawn, so it lives behind `tscene/bakery/node`:
 *
 * ```ts
 * import { bakeSceneFile } from "tscene/bakery/node";
 *
 * const { files } = await bakeSceneFile("room.tscene", { out: "public/lightmaps", samples: 1024 });
 * ```
 */
export { applyLightmap, loadLightmap, decodeFloats, encodeFloats, type Lightmap, type LightmapManifest } from "./apply.ts";
export { bakeGeometry, nodeKey } from "./scene.ts";
