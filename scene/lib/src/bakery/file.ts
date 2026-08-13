// Sheet on disk -> lightmap on disk, in one call. Node only.
import { basename, dirname, extname, resolve } from "node:path";
import type * as THREE from "three/webgpu";
import type { SceneBakery } from "../names.ts";
import { bake, type BakeOptions, type BakeResult } from "./bake.ts";
import { createHeadlessRenderer } from "./headless.ts";
import { writeBake, type WriteOptions } from "./io.ts";
import { bakerySettings } from "./scene.ts";
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
  const sheet = bakerySettings<SceneBakery>(root) ?? {};
  // an unset option must not shadow the sheet, so `undefined` entries are dropped before the merge
  const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as BakeFileOptions;
  const { out, name, renderer, ...rest } = { ...sheet, ...given };
  // the sheet's `out` reads like its `@import`s — relative to the sheet. A caller's is relative to cwd.
  const dir = given.out !== undefined ? given.out : sheet.out !== undefined ? resolve(dirname(file), sheet.out) : dirname(file);

  const gpu = renderer ?? (await createHeadlessRenderer());
  try {
    const result = await bake(root, { ...rest, renderer: gpu });
    const files = await writeBake(result, dir, name ?? basename(file, extname(file)), rest);
    return { ...result, files };
  } finally {
    if (!renderer) gpu.dispose();
  }
}
