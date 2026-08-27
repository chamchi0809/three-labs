// collect -> unwrap -> rasterize -> trace -> filter -> probe -> pack. Browser or Node; the only requirement is
// a WebGPURenderer, and `createHeadlessRenderer()` supplies one in Node.
import * as THREE from "three/webgpu";
import { unwrap, type Atlas, type UnwrapOptions } from "./atlas.ts";
import { denoise, dilate, fireflies } from "./filter.ts";
import type { Texels } from "./raster.ts";
import { rasterizeParallel } from "./raster.ts";
import { collectScene, sampleTexture, type BakeScene, type CollectOptions } from "./scene.ts";
import { prepareTrace, SAMPLES, trace, traceProbes, type ProbeImage, type TraceOptions } from "./tracer.ts";
import { decodeFloats, encodeFloats, MANIFEST_VERSION, type LightmapManifest } from "./apply.ts";

/**
 * Every stage announces itself when it starts, and the one after it is what marks it finished — so the
 * list covers the whole bake with no gaps. `load` and `write` belong to {@link bakeSceneFile}; a caller
 * that hands `bake()` a scene it already has never sees them.
 */
export type BakeStage =
  | "load"
  | "collect"
  | "unwrap"
  | "rasterize"
  | "prepare"
  | "trace"
  | "probe"
  | "filter"
  | "write";

export type BakeOptions = Omit<UnwrapOptions, "onProgress"> &
  Omit<TraceOptions, "onProgress"> &
  CollectOptions & {
    /** an initialized WebGPURenderer. Required — `createHeadlessRenderer()` makes one in Node. */
    renderer: THREE.WebGPURenderer;
    /** 0 disables the edge-aware blur; 1 is a 3x3 kernel */
    denoiseRadius?: number;
    /**
     * How far above the median of its neighbours a texel may sit before it is clamped back to it.
     * Runs before the blur, which would otherwise smear the spike rather than remove it. 0 disables.
     */
    fireflyThreshold?: number;
    /** texels of lit-region growth past the chart edges. The atlas padding follows this by default. */
    dilateRadius?: number;
    /** also build an ambient-occlusion atlas — {@link BakeResult.ao}, and `<name>.ao.png` on disk */
    ao?: boolean;
    /**
     * The divisor that maps irradiance into the 8-bit PNG, and the `lightMapIntensity` that undoes it.
     * Absent, it is the atlas' 95th percentile. Fixing it makes two bakes of one scene quantize alike.
     */
    exposure?: number;
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
  // the trace checks the signal per batch; the stages around it are single calls that can each run for
  // minutes (xatlas, the rasterizer, the filters), so the boundaries between them are the other chances
  opts.signal?.throwIfAborted();
  opts.onProgress?.("collect", 0);
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
  // here rather than at the filter stage: a mismatch is knowable the moment the layout is, and finding
  // it afterwards means the whole path trace ran — minutes to hours — to reach a throw
  if (opts.previous) validatePrevious(opts.previous, atlas);

  opts.signal?.throwIfAborted();
  opts.onProgress?.("rasterize", 0);
  const texels = await rasterizeParallel(scene.meshes, atlas, {
    jobs: opts.jobs,
    onProgress: (fraction) => opts.onProgress?.("rasterize", fraction),
  });
  if (!texels.index.length) throw new Error("tscene/bakery: the unwrap produced no usable texels");

  opts.onProgress?.("prepare", 0);
  // before anything reads a normal: the trace samples its hemisphere around it, and both filters use it
  // to decide which neighbours share a surface, so the bumped normal has to be the only one in play
  applyNormalMaps(scene, texels);
  const index = opts.only?.length ? subset(texels, scene, opts.only) : texels.index;
  // both GPU stages run off one context. Building it walks and uploads every triangle in the scene, and
  // the probes used to build a second one after the atlas trace had already thrown the first away.
  const context = prepareTrace(scene, {
    lightmapUV: atlas.uv,
    albedo: albedoAtlas(scene, texels),
    width: texels.width,
    height: texels.height,
  });
  let traced: Float32Array;
  let probes: ProbeImage[];
  try {
    traced = await trace(opts.renderer, scene, { ...texels, index }, {
      ...opts,
      context,
      onProgress: (fraction) => opts.onProgress?.("trace", fraction),
    });
    // the probes see nothing the atlas didn't: same lights, same emitters, same geometry, same context.
    // They are independent of it otherwise — no unwrap, no filters, one equirect each.
    probes = await traceProbes(opts.renderer, scene, {
      ...opts,
      context,
      onProgress: (fraction) => opts.onProgress?.("probe", fraction),
    });
  } finally {
    context.dispose();
  }

  opts.signal?.throwIfAborted();
  opts.onProgress?.("filter", 0);
  // a partial rebake starts from the atlas it is patching, so untouched charts keep their light
  // ponytail: the filters then run over the whole image again, so an old texel is blurred twice.
  // Harmless on converged, already-smooth values; mask the filters per chart if it ever shows.
  const image = opts.previous ? Float32Array.from(opts.previous.image) : new Float32Array(atlas.width * atlas.height * 4);
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

  // before the blur, and only on the irradiance: occlusion is an average of 0s and 1s and has no spikes
  fireflies(image, texels, opts.fireflyThreshold ?? 4);
  if ((opts.denoiseRadius ?? 1) > 0) denoise(image, texels, opts.denoiseRadius ?? 1);
  dilate(image, texels.mask, atlas.width, atlas.height, dilateRadius);
  if (ao) {
    // the occlusion atlas is a monte carlo estimate of the same rays, so it wants the same two passes
    if ((opts.denoiseRadius ?? 1) > 0) denoise(ao, texels, opts.denoiseRadius ?? 1);
    dilate(ao, texels.mask, atlas.width, atlas.height, dilateRadius);
  }

  // the exposure percentile and the manifest's uv encoding are the tail of this stage, not free
  const exposure = opts.exposure && opts.exposure > 0 ? opts.exposure : autoExposure(image, texels.mask);

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
 * Both atlases a rebake patches have to be the shape the manifest describes. `image` was checked after
 * the trace and `ao` was never checked at all — a short one takes the per-texel writes below silently,
 * because a typed array drops an out-of-range store instead of throwing, and the occlusion comes out
 * truncated with nothing said.
 * @internal exported for the checks
 */
export function validatePrevious(previous: NonNullable<BakeOptions["previous"]>, atlas: Atlas): void {
  const expected = atlas.width * atlas.height * 4;
  for (const [what, buffer] of [["image", previous.image], ["occlusion atlas", previous.ao]] as const) {
    if (buffer && buffer.length !== expected) {
      throw new Error(
        `tscene/bakery: the previous ${what} holds ${buffer.length} floats, not the ${expected} its manifest ` +
          `describes (${atlas.width}x${atlas.height}) — rebake the whole scene`,
      );
    }
  }
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
 * Bends every covered texel's normal by its material's `normalMap`, in place, and answers how many it
 * moved. The trace then casts its hemisphere around the bumped normal, so a brick wall's mortar catches
 * its own shading instead of baking as flat as the geometry — and since three adds a lightmap without a
 * normal term, the detail can only come from here.
 *
 * The tangent frame comes out of the atlas rather than out of per-vertex tangents: two texels apart in
 * the atlas are two points whose world position and uv0 are both already in {@link Texels}, so the 2x2
 * system relating one delta to the other *is* `[∂P/∂u, ∂P/∂v]`. No tangent attribute to compute, none to
 * thread through the rasterizer's workers, and the frame lands at exactly the resolution the bake shades
 * at. It needs two neighbours of the same mesh, which the interior of every chart has and its one-texel
 * rim does not — those keep the geometry's own normal, and the dilation covers them anyway.
 * @internal exported for the checks
 */
export function applyNormalMaps(scene: BakeScene, texels: Texels): number {
  if (!scene.materials.some((m) => m.normalMap)) return 0;
  const { width, height, position, normal, uv, mesh: owner } = texels;
  const dpu = new Float64Array(3);
  const dpv = new Float64Array(3);
  const duu = new Float64Array(2);
  const duv = new Float64Array(2);
  let applied = 0;

  // negating both sides of the system leaves its solution alone, so a backward step needs no sign undone
  const delta = (at: number, x: number, y: number, dx: number, dy: number, dp: Float64Array, du: Float64Array) => {
    for (const s of [1, -1]) {
      const nx = x + dx * s;
      const ny = y + dy * s;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const to = ny * width + nx;
      if (owner[to] !== owner[at]) continue;
      for (let k = 0; k < 3; k++) dp[k] = position[to * 4 + k]! - position[at * 4 + k]!;
      for (let k = 0; k < 2; k++) du[k] = uv[to * 2 + k]! - uv[at * 2 + k]!;
      return true;
    }
    return false;
  };

  for (const at of texels.index) {
    const material = scene.materials[normal[at * 4 + 3]! | 0];
    if (!material?.normalMap) continue;
    const sample = sampleTexture(material.normalMap, uv[at * 2]!, uv[at * 2 + 1]!);
    if (!sample) continue;

    const x = at % width;
    const y = (at - x) / width;
    if (!delta(at, x, y, 1, 0, dpu, duu) || !delta(at, x, y, 0, 1, dpv, duv)) continue;
    const det = duu[0]! * duv[1]! - duv[0]! * duu[1]!;
    // a chart whose uv0 does not move across a texel — an untextured face, a degenerate island — has no
    // frame to build, and 1/det would be an axis pointing anywhere
    if (!(Math.abs(det) > 1e-20)) continue;
    const r = 1 / det;

    const n = [normal[at * 4]!, normal[at * 4 + 1]!, normal[at * 4 + 2]!];
    const t = [0, 0, 0];
    const bRef = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      t[k] = (dpu[k]! * duv[1]! - dpv[k]! * duu[1]!) * r;
      bRef[k] = (dpv[k]! * duu[0]! - dpu[k]! * duv[0]!) * r;
    }
    // orthonormalize against the interpolated normal, which is the one the bump is relative to
    const along = t[0]! * n[0]! + t[1]! * n[1]! + t[2]! * n[2]!;
    for (let k = 0; k < 3; k++) t[k]! -= n[k]! * along;
    const length = Math.hypot(t[0]!, t[1]!, t[2]!);
    if (!(length > 1e-9)) continue;
    for (let k = 0; k < 3; k++) t[k]! /= length;
    const b = [n[1]! * t[2]! - n[2]! * t[1]!, n[2]! * t[0]! - n[0]! * t[2]!, n[0]! * t[1]! - n[1]! * t[0]!];
    // cross(N, T) is a bitangent; which of the two it is depends on how the chart was wound
    if (b[0]! * bRef[0]! + b[1]! * bRef[1]! + b[2]! * bRef[2]! < 0) for (let k = 0; k < 3; k++) b[k]! = -b[k]!;

    const [sx, sy] = material.normalScale ?? [1, 1];
    const mx = (sample[0]! * 2 - 1) * sx;
    const my = (sample[1]! * 2 - 1) * sy;
    // a map whose blue channel decodes at or below the surface is not a tangent-space normal map; the
    // floor keeps the frame on the outward side rather than turning the texel inside out
    const mz = Math.max(sample[2]! * 2 - 1, 1e-3);

    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) out[k] = t[k]! * mx + b[k]! * my + n[k]! * mz;
    const size = Math.hypot(out[0]!, out[1]!, out[2]!);
    if (!(size > 1e-9)) continue;
    for (let k = 0; k < 3; k++) out[k]! /= size;
    // a `normalScale` past the point where the bump tips under the surface would start rays inside it
    if (out[0]! * n[0]! + out[1]! * n[1]! + out[2]! * n[2]! < 0.05) continue;
    for (let k = 0; k < 3; k++) normal[at * 4 + k] = out[k]!;
    applied++;
  }
  return applied;
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
 * The divisor that maps this atlas into [0,1] for the PNG. The 95th percentile, not the 99th: the top
 * few per cent of a scene with emissive props is their own noisy neighbourhood, and a percentile that
 * lands in it moves with the fireflies — pica came out 0.9, 1.6 and 2.1 across three bakes of the same
 * sheet, spending a stop of 8-bit range on texels the tone mapper rolls off anyway. What sits above the
 * divisor clips in the PNG and survives in the EXR.
 *
 * `fireflies()` runs before this and takes the spikes that used to move it out; what is left is the
 * noise floor, which a percentile is steady against. `@bakery { exposure }` still pins it outright.
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
  const p95 = luminance[Math.min(luminance.length - 1, Math.floor(luminance.length * 0.95))];
  return Math.max(1e-4, p95);
}
