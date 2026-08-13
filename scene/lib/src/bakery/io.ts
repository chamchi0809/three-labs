// Writing a bake to disk. Node only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as THREE from "three/webgpu";
import { EXRExporter, ZIPS_COMPRESSION } from "three/addons/exporters/EXRExporter.js";
import sharp from "sharp";
import type { BakeResult } from "./bake.ts";
import type { LightmapManifest } from "./apply.ts";

export type WriteOptions = {
  /** also write a 32-bit float EXR of the unexposed irradiance next to the PNG */
  exr?: boolean;
};

/**
 * Writes `<dir>/<name>.png` (exposure-scaled sRGB), `<dir>/<name>.ao.png` if the bake produced one,
 * `<dir>/<name>.probeN.exr` per reflection probe, and `<dir>/<name>.lightmap.json`.
 * @returns the paths written.
 */
export async function writeBake(
  result: BakeResult,
  dir: string,
  name: string,
  opts: WriteOptions = {},
): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const written: string[] = [];

  const png = join(dir, `${name}.png`);
  // RGBA, not RGB: the alpha channel is the coverage mask, which is what a rebake and any tool
  // reading the atlas back needs to tell "black because unlit" from "black because nothing is here"
  await sharp(encodeSRGB(result), { raw: { width: result.width, height: result.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(png);
  written.push(png);

  if (opts.exr) {
    const exr = join(dir, `${name}.exr`);
    await writeFile(exr, await encodeEXR(result.image, result.width, result.height));
    written.push(exr);
  }

  // always float, never exposed: a probe is what a metal reflects, and the sun in it clipped to the
  // atlas' 8-bit range would be a grey blob. One file each, indexed — the manifest names them.
  for (const [at, probe] of result.probes.entries()) {
    const exr = join(dir, probeFile(name, at));
    await writeFile(exr, await encodeEXR(probe.image, probe.width, probe.height));
    written.push(exr);
  }

  if (result.ao) {
    // one channel: `aoMap` reads red, and a greyscale PNG is a quarter of the bytes. No sRGB curve
    // either — occlusion is a linear multiplier, not a colour.
    const ao = join(dir, `${name}.ao.png`);
    await sharp(greyscale(result.ao, result.width, result.height), {
      raw: { width: result.width, height: result.height, channels: 1 },
    })
      .png({ compressionLevel: 9 })
      .toFile(ao);
    written.push(ao);
  }

  const manifest: LightmapManifest = {
    ...result.manifest,
    texture: `${name}.png`,
    ...(opts.exr ? { hdr: `${name}.exr` } : {}),
    ...(result.ao ? { ao: `${name}.ao.png` } : {}),
    ...(result.probes.length
      ? { probes: result.probes.map((p, at) => ({ key: p.key, position: p.position, texture: probeFile(name, at) })) }
      : {}),
  };
  const json = join(dir, `${name}.lightmap.json`);
  await mkdir(dirname(json), { recursive: true });
  await writeFile(json, JSON.stringify(manifest));
  written.push(json);

  return written;
}

const probeFile = (name: string, at: number) => `${name}.probe${at}.exr`;

/** The atlas is stored bottom row first; PNG is top row first. EXR is not — see {@link encodeEXR}. */
function flipRows(source: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(source.length);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    out.set(source.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  }
  return out;
}

/** The red channel of an RGBA float atlas as 8-bit grey, top row first. */
function greyscale(source: Float32Array, width: number, height: number): Buffer {
  const flipped = flipRows(source, width, height);
  const out = Buffer.allocUnsafe(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, flipped[i * 4]!)) * 255);
  return out;
}

function encodeSRGB(result: BakeResult): Buffer {
  const flipped = flipRows(result.image, result.width, result.height);
  const out = Buffer.allocUnsafe(result.width * result.height * 4);
  for (let i = 0, o = 0; i < flipped.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const linear = Math.min(1, Math.max(0, flipped[i + k] / result.exposure));
      const srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
      out[o++] = Math.round(srgb * 255);
    }
    out[o++] = Math.round(Math.min(1, Math.max(0, flipped[i + 3])) * 255);
  }
  return out;
}

/**
 * The EXR of a previous bake, read back as the linear image {@link bake} produced — the input a
 * partial rebake patches. Node only; the exporter's own layout is the one being undone here.
 */
export async function readEXR(file: string): Promise<{ width: number; height: number; image: Float32Array }> {
  const { EXRLoader } = await import("three/addons/loaders/EXRLoader.js");
  const buffer = await readFile(file);
  // the loader decodes to half floats unless told otherwise, and a lightmap's dynamic range is the
  // whole reason the EXR exists
  const loader = new EXRLoader().setDataType(THREE.FloatType);
  const exr = loader.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const data = exr.data as ArrayLike<number>;
  const width = exr.width ?? 0;
  const height = exr.height ?? 0;
  if (!width || !height) throw new Error(`tscene/bakery: ${file} has no image`);
  const image = new Float32Array(width * height * 4);
  // rows already agree with the atlas — {@link encodeEXR} wrote them bottom first — but the file may be RGB
  const channels = data.length / (width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * channels;
      const to = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) image[to + k] = data[from + k]!;
      image[to + 3] = channels > 3 ? data[from + 3]! : 1;
    }
  }
  return { width, height, image };
}

/**
 * The occlusion PNG of a previous bake, back in the layout {@link bake} produces — what a partial
 * rebake patches so the charts it does not touch keep their occlusion. Node only.
 */
export async function readGrey(file: string): Promise<{ width: number; height: number; image: Float32Array }> {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const image = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // the file is top row first, the atlas bottom row first
      const value = data[((height - 1 - y) * width + x) * channels]! / 255;
      const to = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) image[to + k] = value;
      image[to + 3] = 1;
    }
  }
  return { width, height, image };
}

/**
 * Rows go out exactly as the bake holds them, bottom first. `EXRLoader` hands its data back in the
 * same order on a texture with `flipY: false`, so row 0 is what v = 0 samples — the atlas' first row,
 * and a probe's straight-down. Flipping here is what makes an equirect probe reflect upside down.
 *
 * ponytail: ZIPS, one scanline per block, not ZIP's sixteen — three's exporter and loader disagree
 * about a partial ZIP block, so a height that is not a multiple of 16 comes back as garbage. Costs
 * roughly twice the bytes; switch back once that round trips (the check in raster.test.ts is the test).
 */
async function encodeEXR(image: Float32Array, width: number, height: number): Promise<Uint8Array> {
  const texture = new THREE.DataTexture(image, width, height, THREE.RGBAFormat, THREE.FloatType);
  return new EXRExporter().parse(texture, { type: THREE.FloatType, compression: ZIPS_COMPRESSION });
}
