/**
 * What the bake looks like, in the viewport it was baked from.
 *
 * A bake that ends in a file on disk is a bake nobody can judge. The whole reason for baking inside the
 * editor rather than from a terminal is the loop — bake, look, move a light, bake again — and the loop
 * needs the atlas back on the map.
 *
 * It cannot go on the map the editor draws. `render/scene.ts` batches the entire level into one mesh with
 * one material per declaration, which is exactly what makes selecting fifty solids cheap and exactly what
 * makes a per-mesh lightmap impossible: the atlas is keyed by `nodeKey()` — a path through the scene
 * graph — and the batch has no scene graph to walk. Rebuilding the batch so it could carry `uv1` would be
 * rebuilding it for the one case where nothing is being edited.
 *
 * So the preview is a second scene. The same sheet the baker loaded, loaded again through tscene's own
 * runtime, which is the thing that guarantees the node keys line up: both sides walked the same text with
 * the same builder. It is what the game will load, lit by what the baker wrote, standing in the same place
 * as the map it replaces. And it is thrown away the moment it is switched off, because it is a copy of the
 * level in memory and holding one open while somebody edits the other is two levels to keep in step.
 */
import { loadScene } from "tscene";
import { applyLightmap, type Lightmap } from "tscene/bakery";
import type { Group, Material, Mesh, Object3D, Texture } from "three/webgpu";
import { sceneRegistry } from "./registry.ts";

export type Preview = {
  group: Group;
  lightmap: Lightmap;
  /** how many meshes the atlas actually reached, which is the number worth doubting */
  meshes: number;
};

/**
 * Loads the sheets and puts the bake on them.
 *
 * `base` is the url the root sheet would have been fetched from, so its relative `texture()` paths point
 * at the same files the baker read off disk — the dev server serves the project root, and the baker reads
 * the project root, so the two agree by construction.
 */
export async function buildPreview(
  files: Record<string, string>,
  root: string,
  manifest: string,
): Promise<Preview> {
  const text = files[root];
  if (text === undefined) throw new Error(`${root} is not among the sheets to preview`);

  // the same registry the bake used, which is what makes this the scene the atlas was made for rather
  // than a scene that merely looks like it
  const group = (await loadScene(text, {
    registry: await sceneRegistry(),
    base: new URL(root, location.href).href,
    // the sheet's own `@bakery { lightmap }` names whatever was baked last time; this preview is showing
    // the atlas that was just made, and two of them on one material is the second one silently winning
    lightmap: false,
    load: async (path: string, from?: string) => {
      const file = new URL(path, from ?? new URL(root, location.href).href).href;
      const key = decodeURIComponent(new URL(file).pathname.replace(/^\//, ""));
      const held = files[key] ?? files[path];
      if (held !== undefined) return { text: held, file };
      const res = await fetch(file);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
      return { text: await res.text(), file };
    },
  })) as Group;

  const lightmap = await applyLightmap(group, manifest);
  return { group, lightmap, meshes: lightmap.meshes };
}

/**
 * Gives the preview back.
 *
 * Every geometry, every material and every texture, because a level's worth of them is tens of megabytes
 * of GPU memory and a designer who toggles the preview twenty times over an afternoon would otherwise be
 * holding twenty levels. The lightmap goes first: it owns the atlas it loaded, and it puts the materials
 * back the way it found them before they are disposed of anyway — which costs nothing and means this is
 * still correct on the day the group stops being ours to destroy.
 */
export function disposePreview(preview: Preview): void {
  preview.lightmap.dispose();
  preview.group.traverse((object: Object3D) => {
    const mesh = object as Mesh;
    mesh.geometry?.dispose?.();
    const materials: Material[] = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    for (const material of materials) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        const texture = value as Texture | null;
        if (texture?.isTexture) texture.dispose();
      }
      material.dispose();
    }
  });
  preview.group.clear();
}
