// Writing a bake to disk. Node only.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as THREE from "three/webgpu";
import { EXRExporter, ZIP_COMPRESSION } from "three/addons/exporters/EXRExporter.js";
import sharp from "sharp";
import type { BakeResult } from "./bake.ts";
import type { LightmapManifest } from "./apply.ts";

export type WriteOptions = {
  /** also write a 32-bit float EXR of the unexposed irradiance next to the PNG */
  exr?: boolean;
};

/**
 * Writes `<dir>/<name>.png` (exposure-scaled sRGB) and `<dir>/<name>.lightmap.json`.
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
  await sharp(encodeSRGB(result), { raw: { width: result.width, height: result.height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(png);
  written.push(png);

  if (opts.exr) {
    const exr = join(dir, `${name}.exr`);
    await writeFile(exr, await encodeEXR(result));
    written.push(exr);
  }

  const manifest: LightmapManifest = { ...result.manifest, texture: `${name}.png` };
  const json = join(dir, `${name}.lightmap.json`);
  await mkdir(dirname(json), { recursive: true });
  await writeFile(json, JSON.stringify(manifest));
  written.push(json);

  return written;
}

/** The atlas is stored bottom row first; both file formats are top row first. */
function flipRows(source: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(source.length);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    out.set(source.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  }
  return out;
}

function encodeSRGB(result: BakeResult): Buffer {
  const flipped = flipRows(result.image, result.width, result.height);
  const out = Buffer.allocUnsafe(result.width * result.height * 3);
  for (let i = 0, o = 0; i < flipped.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const linear = Math.min(1, Math.max(0, flipped[i + k] / result.exposure));
      const srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
      out[o++] = Math.round(srgb * 255);
    }
  }
  return out;
}

async function encodeEXR(result: BakeResult): Promise<Uint8Array> {
  const texture = new THREE.DataTexture(
    flipRows(result.image, result.width, result.height),
    result.width,
    result.height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  return new EXRExporter().parse(texture, { type: THREE.FloatType, compression: ZIP_COMPRESSION });
}
