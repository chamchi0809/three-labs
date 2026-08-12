/**
 * scene-lightmapper — path-traced lightmaps for tscene / three.js scenes, baked on a headless WebGPU
 * device in Node.
 *
 * This entry point is the browser half: it applies a bake to a live scene and nothing more.
 *
 * ```ts
 * const { manifest, texture } = await loadLightmap("/lightmaps/room.lightmap.json");
 * applyLightmap(scene, manifest, texture);
 * muteBakedLights(scene);
 * ```
 *
 * The atlas holds irradiance, which is exactly what three's `lightMap` slot expects, so this is a
 * texture assignment and a `uv1` attribute — no custom material.
 *
 * The baker itself pulls in sharp, xatlas and Dawn, so it lives behind `scene-lightmapper/node`:
 *
 * ```ts
 * import { bake, createHeadlessRenderer, loadSceneFile, writeBake } from "scene-lightmapper/node";
 *
 * const renderer = await createHeadlessRenderer();
 * const result = await bake(await loadSceneFile("room.tscene"), { renderer, samples: 1024 });
 * await writeBake(result, "public/lightmaps", "room");
 * ```
 */
export { applyLightmap, loadLightmap, muteBakedLights, decodeFloats, encodeFloats, type LightmapManifest } from "./apply.ts";
export { bakeGeometry, nodeKey } from "./scene.ts";
