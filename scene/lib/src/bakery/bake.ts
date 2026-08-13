// collect -> unwrap -> rasterize -> trace -> filter -> probe -> pack. Browser or Node; the only requirement is
// a WebGPURenderer, and `createHeadlessRenderer()` supplies one in Node.
import * as THREE from "three/webgpu";
import { unwrap, type Atlas, type UnwrapOptions } from "./atlas.ts";
import { denoise, dilate } from "./filter.ts";
import type { Texels } from "./raster.ts";
import { rasterizeParallel } from "./raster.ts";
import { collectScene, sampleTexture, type BakeScene, type CollectOptions } from "./scene.ts";
import { SAMPLES, trace, traceProbes, type ProbeImage, type TraceOptions } from "./tracer.ts";
import { decodeFloats, encodeFloats, MANIFEST_VERSION, type LightmapManifest } from "./apply.ts";

export type BakeStage = "unwrap" | "rasterize" | "trace" | "filter" | "probe";

export type BakeOptions = Omit<UnwrapOptions, "onProgress"> &
  Omit<TraceOptions, "onProgress"> &
  CollectOptions & {
    /** an initialized WebGPURenderer. Required — `createHeadlessRenderer()` makes one in Node. */
    renderer: THREE.WebGPURenderer;
    /** 0 disables the edge-aware blur; 1 is a 3x3 kernel */
    denoiseRadius?: number;
    /** texels of lit-region growth past the chart edges. The atlas padding follows this by default. */
    dilateRadius?: number;
    /** also build an ambient-occlusion atlas — {@link BakeResult.ao}, and `<name>.ao.png` on disk */
    ao?: boolean;
    /** worker threads to rasterize with (Node only). 1 keeps the rasterizer on the calling thread. */
    jobs?: number;
    /**
     * A finished bake to rebake on top of: its uv layout is reused (no unwrap), and every texel
     * outside {@link only} keeps the irradiance (and occlusion) it already had.
     */
    previous?: { manifest: LightmapManifest; image: Float32Array; ao?: Float32Array };
    /** with {@link previous}, the `nodeKey()`s to re-trace. Everything else is copied over. */
    only?: string[];
    onProgress?: (stage: BakeStage, fraction: number) => void;
  };

export type BakeResult = {
  width: number;
  height: number;
  /** linear irradiance, RGBA, `width * height * 4`, bottom row first. Alpha marks covered texels. */
  image: Float32Array;
  /**
   * with `ao`, cosine-weighted openness in all three colour channels — 1 unoccluded, 0 fully closed,
   * which is what three's `aoMap` reads. Same layout as {@link BakeResult.image}.
   */
  ao?: Float32Array;
  /** one equirect per `@bakery { probe }` node, in the order the scene walk found them */
  probes: ProbeImage[];
  /** divisor that maps `image` into [0,1] for an 8-bit texture; also the `lightMapIntensity` to use */
  exposure: number;
  /** fraction of the atlas the charts cover */
  utilization: number;
  /** everything the runtime needs except the texture file name, which the writer fills in */
  manifest: Omit<LightmapManifest, "texture">;
};

export async function bake(root: THREE.Object3D, opts: BakeOptions): Promise<BakeResult> {
  const scene = collectScene(root, opts);
  if (!scene.meshes.length) throw new Error("tscene/bakery: nothing to bake — no visible meshes under the root");
  const warn = opts.onWarn ?? ((message: string) => console.warn(`tscene/bakery: ${message}`));
  const dilateRadius = opts.dilateRadius ?? 4;

  opts.onProgress?.("unwrap", 0);
  const atlas = opts.previous
    ? reuseAtlas(opts.previous.manifest, scene)
    : // dilation grows the lit region by `dilateRadius` texels, so anything less than that between two
      // charts is one chart's light bleeding into the other's
      await unwrap(scene.meshes, {
        ...opts,
        padding: opts.padding ?? dilateRadius,
        onProgress: (fraction) => opts.onProgress?.("unwrap", fraction),
      });
  opts.onProgress?.("unwrap", 1);

  opts.onProgress?.("rasterize", 0);
  const texels = await rasterizeParallel(scene.meshes, atlas, {
    jobs: opts.jobs,
    onProgress: (fraction) => opts.onProgress?.("rasterize", fraction),
  });
  if (!texels.index.length) throw new Error("tscene/bakery: the unwrap produced no usable texels");
  const index = opts.only?.length ? subset(texels, scene, opts.only) : texels.index;
  opts.onProgress?.("rasterize", 1);

  const traced = await trace(
    opts.renderer,
    scene,
    { ...texels, index },
    {
      ...opts,
      lightmapUV: atlas.uv,
      albedo: albedoAtlas(scene, texels),
      onProgress: (fraction) => opts.onProgress?.("trace", fraction),
    },
  );

  opts.onProgress?.("filter", 0);
  // a partial rebake starts from the atlas it is patching, so untouched charts keep their light
  // ponytail: the filters then run over the whole image again, so an old texel is blurred twice.
  // Harmless on converged, already-smooth values; mask the filters per chart if it ever shows.
  const image = opts.previous ? Float32Array.from(opts.previous.image) : new Float32Array(atlas.width * atlas.height * 4);
  if (image.length !== atlas.width * atlas.height * 4) {
    throw new Error("tscene/bakery: the previous image does not match its manifest — rebake the whole scene");
  }
  let ao: Float32Array | undefined;
  if (opts.ao) {
    if (opts.previous && !opts.previous.ao && opts.only?.length) {
      warn("this rebake has no previous occlusion atlas to patch — the charts it does not touch bake black");
    }
    ao = opts.previous?.ao ? Float32Array.from(opts.previous.ao) : new Float32Array(image.length);
  }

  // the divisor is the sample count the tracer was asked for, not one read back out of the buffer:
  // the .w slot carries the occlusion sum now
  const samples = Math.max(1, Math.floor(opts.samples ?? SAMPLES));
  for (let i = 0; i < index.length; i++) {
    const d = index[i]! * 4;
    for (let k = 0; k < 3; k++) image[d + k] = traced[i * 4 + k]! / samples;
    image[d + 3] = 1;
    if (ao) {
      const open = traced[i * 4 + 3]! / samples;
      for (let k = 0; k < 3; k++) ao[d + k] = open;
      ao[d + 3] = 1;
    }
  }

  if ((opts.denoiseRadius ?? 1) > 0) denoise(image, texels, opts.denoiseRadius ?? 1);
  dilate(image, texels.mask, atlas.width, atlas.height, dilateRadius);
  if (ao) {
    // the occlusion atlas is a monte carlo estimate of the same rays, so it wants the same two passes
    if ((opts.denoiseRadius ?? 1) > 0) denoise(ao, texels, opts.denoiseRadius ?? 1);
    dilate(ao, texels.mask, atlas.width, atlas.height, dilateRadius);
  }
  opts.onProgress?.("filter", 1);

  // last, so the probes see nothing the atlas didn't: same lights, same emitters, same geometry. They
  // are independent of the atlas otherwise — no unwrap, no filters, one equirect each.
  const probes = await traceProbes(opts.renderer, scene, {
    ...opts,
    onProgress: (fraction) => opts.onProgress?.("probe", fraction),
  });

  const exposure = autoExposure(image, texels.mask);

  return {
    width: atlas.width,
    height: atlas.height,
    image,
    ao,
    probes,
    exposure,
    utilization: opts.previous ? texels.index.length / (atlas.width * atlas.height) : atlas.utilization,
    manifest: {
      version: MANIFEST_VERSION,
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
 * The uv layout of a finished bake, so a rebake lands on the same texels instead of unwrapping again.
 * @internal exported for the checks
 */
export function reuseAtlas(manifest: LightmapManifest, scene: BakeScene): Atlas {
  const byKey = new Map(manifest.meshes.map((m) => [m.key, m]));
  const uv = scene.meshes.map((m) => {
    const entry = byKey.get(m.key);
    if (!entry) {
      throw new Error(`tscene/bakery: "${m.key}" is not in the lightmap being rebaked — bake the whole scene first`);
    }
    if (entry.vertices !== m.positions.length / 3) {
      throw new Error(`tscene/bakery: "${m.key}" changed shape since the bake — bake the whole scene again`);
    }
    return decodeFloats(entry.uv);
  });
  return { width: manifest.width, height: manifest.height, uv, utilization: 0 };
}

/**
 * The texels belonging to `keys` — what a partial rebake dispatches over.
 * @internal exported for the checks
 */
export function subset(texels: Texels, scene: BakeScene, keys: string[]): Uint32Array {
  const wanted = new Set(keys);
  const missing = keys.filter((k) => !scene.meshes.some((m) => m.key === k));
  if (missing.length) throw new Error(`tscene/bakery: no mesh named ${missing.map((k) => `"${k}"`).join(", ")}`);
  const picked = [...texels.index].filter((at) => wanted.has(scene.meshes[texels.mesh[at]!]?.key ?? ""));
  if (!picked.length) throw new Error(`tscene/bakery: ${keys.join(", ")} covers no texel of the atlas`);
  return Uint32Array.from(picked);
}

/**
 * The albedo of every covered texel, packed RGBA8 (alpha = "this texel really was sampled"), so a
 * bounce reads the colour under the point it hit instead of the whole texture's mean. Skipped
 * entirely when no material has a decodable map — the tracer then stays on the per-material value.
 * @internal exported for the checks
 */
export function albedoAtlas(scene: BakeScene, texels: Texels): Uint32Array | undefined {
  if (!scene.materials.some((m) => m.map && m.mapScale)) return undefined;
  const { width, height } = texels;
  const image = new Float32Array(width * height * 4);
  const sampled = new Uint8Array(width * height);
  let any = false;

  for (const at of texels.index) {
    const material = scene.materials[texels.normal[at * 4 + 3]! | 0];
    if (!material?.map || !material.mapScale) continue;
    const sample = sampleTexture(material.map, texels.uv[at * 2]!, texels.uv[at * 2 + 1]!);
    if (!sample) continue;
    for (let k = 0; k < 3; k++) image[at * 4 + k] = Math.min(1, Math.max(0, sample[k]! * material.mapScale[k]!));
    image[at * 4 + 3] = 1;
    sampled[at] = 1;
    any = true;
  }
  if (!any) return undefined;

  // a hit just off a chart edge still has to read a colour, and the atlas padding bounds the bleed
  dilate(image, sampled, width, height, 2);

  const packed = new Uint32Array(width * height);
  for (let i = 0; i < packed.length; i++) {
    const byte = (k: number) => Math.round(Math.min(1, Math.max(0, image[i * 4 + k]!)) * 255);
    packed[i] = byte(0) | (byte(1) << 8) | (byte(2) << 16) | (byte(3) << 24);
  }
  return packed;
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
