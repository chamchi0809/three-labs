// collect -> unwrap -> rasterize -> trace -> filter -> pack. Browser or Node; the only requirement is
// a WebGPURenderer, and `createHeadlessRenderer()` supplies one in Node.
import * as THREE from "three/webgpu";
import { unwrap, type UnwrapOptions } from "./atlas.ts";
import { denoise, dilate } from "./filter.ts";
import { rasterize } from "./raster.ts";
import { collectScene, type CollectOptions } from "./scene.ts";
import { trace, type TraceOptions } from "./tracer.ts";
import { encodeFloats, type LightmapManifest } from "./apply.ts";

export type BakeStage = "unwrap" | "rasterize" | "trace" | "filter";

export type BakeOptions = UnwrapOptions &
  Omit<TraceOptions, "onProgress"> &
  CollectOptions & {
    /** an initialized WebGPURenderer. Required — `createHeadlessRenderer()` makes one in Node. */
    renderer: THREE.WebGPURenderer;
    /** 0 disables the edge-aware blur; 1 is a 3x3 kernel */
    denoiseRadius?: number;
    /** texels of lit-region growth past the chart edges. Keep >= the atlas padding. */
    dilateRadius?: number;
    onProgress?: (stage: BakeStage, fraction: number) => void;
  };

export type BakeResult = {
  width: number;
  height: number;
  /** linear irradiance, RGBA, `width * height * 4`, bottom row first. Alpha marks covered texels. */
  image: Float32Array;
  /** divisor that maps `image` into [0,1] for an 8-bit texture; also the `lightMapIntensity` to use */
  exposure: number;
  /** fraction of the atlas the charts cover */
  utilization: number;
  /** everything the runtime needs except the texture file name, which the writer fills in */
  manifest: Omit<LightmapManifest, "texture">;
};

export async function bake(root: THREE.Object3D, opts: BakeOptions): Promise<BakeResult> {
  const scene = collectScene(root, opts);
  if (!scene.meshes.length) throw new Error("scene-lightmapper: nothing to bake — no visible meshes under the root");

  opts.onProgress?.("unwrap", 0);
  const atlas = await unwrap(scene.meshes, opts);
  opts.onProgress?.("unwrap", 1);

  opts.onProgress?.("rasterize", 0);
  const texels = rasterize(scene.meshes, atlas);
  if (!texels.index.length) throw new Error("scene-lightmapper: the unwrap produced no usable texels");
  opts.onProgress?.("rasterize", 1);

  const traced = await trace(opts.renderer, scene, texels, {
    ...opts,
    onProgress: (fraction) => opts.onProgress?.("trace", fraction),
  });

  opts.onProgress?.("filter", 0);
  const image = new Float32Array(atlas.width * atlas.height * 4);
  for (let i = 0; i < texels.index.length; i++) {
    const samples = traced[i * 4 + 3] || 1;
    const d = texels.index[i] * 4;
    for (let k = 0; k < 3; k++) image[d + k] = traced[i * 4 + k] / samples;
    image[d + 3] = 1;
  }

  if ((opts.denoiseRadius ?? 1) > 0) denoise(image, texels, opts.denoiseRadius ?? 1);
  dilate(image, texels.mask, atlas.width, atlas.height, opts.dilateRadius ?? 4);
  opts.onProgress?.("filter", 1);

  const exposure = autoExposure(image, texels.mask);

  return {
    width: atlas.width,
    height: atlas.height,
    image,
    exposure,
    utilization: atlas.utilization,
    manifest: {
      version: 1,
      width: atlas.width,
      height: atlas.height,
      intensity: exposure,
      meshes: scene.meshes.map((m, i) => ({
        key: m.key,
        vertices: m.positions.length / 3,
        uv: encodeFloats(atlas.uv[i]),
      })),
    },
  };
}

/**
 * The divisor that puts almost everything inside [0,1]. The 99th percentile rather than the maximum,
 * so one blown texel next to a lamp doesn't crush the whole atlas into the bottom of an 8-bit range.
 * Clipping above it is the intended trade — use the EXR output when clipping is unacceptable.
 */
function autoExposure(image: Float32Array, mask: Uint8Array): number {
  const luminance: number[] = [];
  // every 7th texel is plenty for a percentile and keeps the sort off a million element array
  for (let i = 0; i < mask.length; i += 7) {
    if (!mask[i]) continue;
    luminance.push(0.2126 * image[i * 4] + 0.7152 * image[i * 4 + 1] + 0.0722 * image[i * 4 + 2]);
  }
  if (!luminance.length) return 1;
  luminance.sort((a, b) => a - b);
  const p99 = luminance[Math.min(luminance.length - 1, Math.floor(luminance.length * 0.99))];
  return Math.max(1e-4, p99);
}
