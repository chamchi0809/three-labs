/** The baker. Node only — pulls in Dawn, sharp and xatlas. See `scene-lightmapper` for the runtime half. */
export { bake, type BakeOptions, type BakeResult, type BakeStage } from "./bake.ts";
export { unwrap, type Atlas, type UnwrapOptions } from "./atlas.ts";
export { createHeadlessRenderer, installWebGPU } from "./headless.ts";
export { denoise, dilate } from "./filter.ts";
export { rasterize, type Texels } from "./raster.ts";
export {
  areaLights,
  bvhProxy,
  collectScene,
  type BakeLight,
  type BakeMaterial,
  type BakeMesh,
  type BakeScene,
  type BakeSky,
  type CollectOptions,
} from "./scene.ts";
export { trace, type TraceOptions } from "./tracer.ts";
export { writeBake, type WriteOptions } from "./io.ts";
export { installNodeLoaders, loadSceneFile } from "./tscene.ts";
export * from "./index.ts";
