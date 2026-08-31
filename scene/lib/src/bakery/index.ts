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
export { applyLightmap, loadLightmap, decodeFloats, encodeFloats, MANIFEST_VERSION, type Lightmap, type LightmapManifest } from "./apply.ts";
export { probeDirection, probeWeights, type PlacedProbe, type ProbeWeight } from "./probe.ts";
// `validateBakery` alongside them: it reads a loaded scene and nothing else, so a tool that builds the
// scene itself — an editor baking the document it has open — can check the sheet's `@bakery` blocks
// without going through `bakeSceneFile`, which is the only thing that used to call it
export { bakeEnabled, bakeGeometry, bakerySettings, nodeKey, validateBakery } from "./scene.ts";
export type { MaterialBakery, NodeBakery, SceneBakery } from "../names.ts";
