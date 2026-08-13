// Lightmap UVs, from xatlas compiled to wasm. One atlas for the whole scene.
import createXAtlas from "xatlas-wasm";
import type { BakeMesh } from "./scene.ts";

export type Atlas = {
  width: number;
  /** a multiple of the packed size: xatlas' sub-atlases are stacked into one tall texture */
  height: number;
  /** per bake mesh, 2 floats per vertex in [0,1] — the `uv1` attribute the runtime needs */
  uv: Float32Array[];
  /** fraction of the atlas actually covered by charts */
  utilization: number;
};

export type UnwrapOptions = {
  /**
   * target atlas edge length in texels. xatlas picks the chart scale from this and then packs, so the
   * atlas it returns is around this size rather than exactly it — read `Atlas.width` for the truth.
   */
  size?: number;
  /** texels of empty space around every chart — must be >= the dilation radius */
  padding?: number;
  /**
   * texels per world unit. 0 (the default) lets xatlas pick the scale that fills `size`,
   * which is what you want unless you are baking several scenes to a shared density.
   */
  texelsPerUnit?: number;
};

export async function unwrap(meshes: BakeMesh[], opts: UnwrapOptions = {}): Promise<Atlas> {
  const size = opts.size ?? 1024;
  const xatlas = await createXAtlas();
  const atlas = xatlas.createAtlas();
  try {
    for (const m of meshes) {
      const err = atlas.addMesh({
        positions: m.positions,
        normals: m.normals,
        meshCountHint: meshes.length,
      });
      if (err !== 0) throw new Error(`tscene/bakery: xatlas rejected "${m.key}": ${xatlas.addMeshErrorString(err)}`);
    }

    atlas.generate(
      // normal seams matter more than chart count: a chart that folds over a crease bakes a hard edge
      { maxIterations: 2, normalSeamWeight: 8, fixWinding: true },
      {
        resolution: size,
        texelsPerUnit: opts.texelsPerUnit ?? 0,
        padding: opts.padding ?? 2,
        bilinear: true,
        bruteForce: true,
      },
    );

    // xatlas splits into several equally sized sub-atlases when the charts do not fit one. Stacking
    // them into a single tall texture keeps everything downstream — one image, one manifest, one
    // material slot — unchanged, at the cost of a texture taller than `size`.
    const sheets = Math.max(1, atlas.atlasCount);

    const uv: Float32Array[] = [];
    for (let i = 0; i < meshes.length; i++) {
      const out = atlas.getMesh(i);
      const target = new Float32Array((meshes[i].positions.length / 3) * 2);
      for (const v of out.vertices) {
        // input is non-indexed, so every input vertex belongs to exactly one face and one chart
        target[v.xref * 2] = v.uv[0] / atlas.width;
        target[v.xref * 2 + 1] = (v.uv[1] / atlas.height + Math.max(0, v.atlasIndex)) / sheets;
      }
      uv.push(target);
    }

    let utilization = 0;
    for (let i = 0; i < sheets; i++) utilization += atlas.getUtilization(i) / sheets;

    return { width: atlas.width, height: atlas.height * sheets, uv, utilization };
  } finally {
    atlas.destroy();
  }
}
