// Sheet on disk -> lightmap on disk, in one call. Node only.
import { basename, dirname, extname } from "node:path";
import type * as THREE from "three/webgpu";
import { bake, type BakeOptions, type BakeResult } from "./bake.ts";
import { createHeadlessRenderer } from "./headless.ts";
import { writeBake, type WriteOptions } from "./io.ts";
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
 * Every knob of {@link bake} and {@link writeBake} passes straight through. Reach for the pieces
 * themselves when the scene is not a sheet on disk, or when one renderer bakes several scenes.
 */
export async function bakeSceneFile(file: string, opts: BakeFileOptions = {}): Promise<BakeFileResult> {
  const { out, name, renderer: given, ...rest } = opts;
  const root = await loadSceneFile(file);
  const renderer = given ?? (await createHeadlessRenderer());
  try {
    const result = await bake(root, { ...rest, renderer });
    const files = await writeBake(result, out ?? dirname(file), name ?? basename(file, extname(file)), opts);
    return { ...result, files };
  } finally {
    if (!given) renderer.dispose();
  }
}
