/** The baker. Node only — pulls in Dawn, sharp and xatlas. See `tscene/bakery` for the runtime half. */
export { bake, type BakeOptions, type BakeResult, type BakeStage } from "./bake.ts";
export { bakeSceneFile, type BakeFileOptions, type BakeFileResult } from "./file.ts";
export { unwrap, type Atlas, type UnwrapOptions } from "./atlas.ts";
export { createHeadlessRenderer, installWebGPU } from "./headless.ts";
export { denoise, dilate } from "./filter.ts";
export { rasterize, type Texels } from "./raster.ts";
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
export { trace, traceProbes, type ProbeImage, type TraceOptions } from "./tracer.ts";
export { writeBake, type WriteOptions } from "./io.ts";
export { installNodeLoaders, loadSceneFile } from "./tscene.ts";
export * from "./index.ts";
