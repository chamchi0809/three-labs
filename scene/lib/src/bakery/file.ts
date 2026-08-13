// Sheet on disk -> lightmap on disk, in one call. Node only.
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type * as THREE from "three/webgpu";
import type { SceneBakery } from "../names.ts";
import type { LightmapManifest } from "./apply.ts";
import { bake, type BakeOptions, type BakeResult } from "./bake.ts";
import { createHeadlessRenderer } from "./headless.ts";
import { readEXR, writeBake, type WriteOptions } from "./io.ts";
import { bakerySettings, validateBakery } from "./scene.ts";
import { loadSceneFile } from "./tscene.ts";

export type BakeFileOptions = Omit<BakeOptions, "renderer"> &
  WriteOptions & {
    /** an initialized WebGPURenderer. One is created — and disposed again — when this is left out. */
    renderer?: THREE.WebGPURenderer;
    /** where to write (default: next to the sheet) */
    out?: string;
    /** output base name (default: the sheet's file name) */
    name?: string;
  };

export type BakeFileResult = BakeResult & {
  /** the paths `writeBake` produced */
  files: string[];
};

/**
 * Loads a `.tscene` file, bakes it, and writes the atlas and its manifest.
 *
 * ```ts
 * const { files, width, exposure } = await bakeSceneFile("scenes/room.tscene", {
 *   out: "public/lightmaps",
 *   size: 512,
 *   samples: 1024,
 * });
 * ```
 *
 * Every knob of {@link bake} and {@link writeBake} passes straight through, and every one of them can
 * also live in the sheet's own `@bakery { … }` block — what is passed here wins. Reach for the pieces
 * themselves when the scene is not a sheet on disk, or when one renderer bakes several scenes.
 */
export async function bakeSceneFile(file: string, opts: BakeFileOptions = {}): Promise<BakeFileResult> {
  const root = await loadSceneFile(file);
  validateBakery(root, file);
  const sheet = bakerySettings<SceneBakery>(root) ?? {};
  // an unset option must not shadow the sheet, so `undefined` entries are dropped before the merge
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as BakeFileOptions;
  const { out, name, renderer, ...rest } = { ...sheet, ...given };
  // the sheet's `out` reads like its `@import`s — relative to the sheet. A caller's is relative to cwd.
  const dir = given.out !== undefined ? given.out : sheet.out !== undefined ? resolve(dirname(file), sheet.out) : dirname(file);

  const base = name ?? basename(file, extname(file));
  // a partial rebake patches the atlas that is already on disk, so it has to read it back first
  const previous = rest.only?.length && !rest.previous ? await readBake(dir, base) : rest.previous;

  const gpu = renderer ?? (await createHeadlessRenderer());
  try {
    const result = await bake(root, { ...rest, previous, renderer: gpu });
    // the EXR is the only lossless copy, and the next `--only` run needs it
    const files = await writeBake(result, dir, base, { ...rest, exr: rest.exr || !!previous });
    return { ...result, files };
  } finally {
    if (!renderer) gpu.dispose();
  }
}

/** The manifest and the float image of the bake already sitting in `dir`. */
async function readBake(dir: string, name: string): Promise<{ manifest: LightmapManifest; image: Float32Array }> {
  const path = join(dir, `${name}.lightmap.json`);
  const manifest = JSON.parse(await readFile(path, "utf8")) as LightmapManifest;
  if (!manifest.hdr) {
    throw new Error(`tscene/bakery: ${path} has no EXR to rebake on top of — bake the whole scene once with --exr`);
  }
  const { width, height, image } = await readEXR(join(dir, manifest.hdr));
  if (width !== manifest.width || height !== manifest.height) {
    throw new Error(`tscene/bakery: ${manifest.hdr} is ${width}x${height}, not the ${manifest.width}x${manifest.height} its manifest claims`);
  }
  return { manifest, image };
}

