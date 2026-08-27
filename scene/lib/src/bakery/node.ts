/** The baker. Node only — pulls in Dawn, sharp and xatlas. See `tscene/bakery` for the runtime half. */
export { bake, type BakeOptions, type BakeResult, type BakeStage } from "./bake.ts";
export { bakeSceneFile, type BakeFileOptions, type BakeFileResult } from "./file.ts";
export { unwrap, type Atlas, type UnwrapOptions } from "./atlas.ts";
// `hasWebGPU` alongside the two it guards: asking whether this machine can bake at all is the first
// thing a caller does, and it used to mean importing from `tscene/bakery/headless.ts` by path
export { createHeadlessRenderer, hasWebGPU, installWebGPU } from "./headless.ts";
export { denoise, dilate } from "./filter.ts";
export { rasterize, rasterizeParallel, type RasterOptions, type Texels } from "./raster.ts";
export {
  areaLights,
  bvhProxy,
  collectScene,
  type BakeEmitter,
  type BakeLight,
  type BakeMaterial,
  type BakeMesh,
  type BakeProbe,
  type BakeScene,
  type BakeSky,
  type AreaLights,
  type CollectOptions,
} from "./scene.ts";
export {
  prepareTrace,
  trace,
  traceProbes,
  type Bases,
  type PrepareOptions,
  type ProbeImage,
  type TraceContext,
  type TraceOptions,
} from "./tracer.ts";
export { writeBake, type WriteOptions } from "./io.ts";
export { installNodeLoaders, loadSceneFile, uninstallNodeLoaders } from "./tscene.ts";
export * from "./index.ts";
