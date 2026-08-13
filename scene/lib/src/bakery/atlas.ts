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
  /**
   * texels of empty space around every chart. Keep it at or above the bake's `dilateRadius`: dilation
   * grows the lit region outwards, and anything it grows past the padding bleeds into the next chart.
   */
  padding?: number;
  /**
   * texels per world unit. 0 (the default) lets xatlas pick the scale that fills `size`,
   * which is what you want unless you are baking several scenes to a shared density.
   */
  texelsPerUnit?: number;
  /** 0..1 — how far the unwrap has got, straight out of xatlas' own phases */
  onProgress?: (fraction: number) => void;
};

/**
 * Where each of xatlas' four phases — add, chart, pack, build — starts and ends in the 0..1 the caller
 * sees. Sponza splits 17s charting to 38s packing at size 2048, so the two get room to move in;
 * `addMesh` itself returns immediately, and its share is the join at the front of charting.
 */
const PHASE = [0, 0.05, 0.4, 0.98, 1];

export async function unwrap(meshes: BakeMesh[], opts: UnwrapOptions = {}): Promise<Atlas> {
  const size = opts.size ?? 1024;
  const xatlas = await createXAtlas();
  const atlas = xatlas.createAtlas();
  try {
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i]!;
      const err = atlas.addMesh({
        // `@bakery { density }` is a scale on the geometry xatlas measures: charts are sized in texels
        // per world unit, so a mesh handed in twice as large gets twice the atlas area at the same
        // density. The uv it returns is in atlas space, so nothing has to be scaled back.
        positions: m.density && m.density !== 1 ? scaled(m.positions, m.density) : m.positions,
        normals: m.normals,
        meshCountHint: meshes.length,
      });
      if (err !== 0) throw new Error(`tscene/bakery: xatlas rejected "${m.key}": ${xatlas.addMeshErrorString(err)}`);
    }

    if (opts.onProgress) {
      const report = opts.onProgress;
      atlas.setProgressCallback((category, percent) => {
        const from = PHASE[category] ?? 0;
        report(from + ((PHASE[category + 1] ?? 1) - from) * (percent / 100));
        return true;
      });
    }

    atlas.generate(
      // normal seams matter more than chart count: a chart that folds over a crease bakes a hard edge
      { maxIterations: 2, normalSeamWeight: 8, fixWinding: true },
      {
        resolution: size,
        texelsPerUnit: opts.texelsPerUnit ?? 0,
        padding: opts.padding ?? 2,
        bilinear: true,
        // Brute force tries every offset for every chart, and it is most of the unwrap: 38 of sponza's
        // 56 seconds at size 2048, against 0.7s for random placement. It stays on anyway, because both
        // of the ways out are worse. Random placement packs sponza to 77% instead of 94%, and the 21%
        // larger texture that buys is a cost every viewer pays forever for a saving only the bake sees.
        // `blockAlign` is as fast and packs *tighter* by xatlas' own metric, but the rasterizer then
        // covers 0.974M texels where brute force covers 0.855M — it rounds chart footprints up to 4x4
        // blocks, and the trace pays that 14% back on every sample. At the settings sponza's sheet
        // actually asks for, the packer is 38s of a 380s bake and the trace is 320s of it.
        bruteForce: true,
      },
    );
    atlas.setProgressCallback(null);

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

const scaled = (positions: Float32Array, by: number): Float32Array => {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) out[i] = positions[i]! * by;
  return out;
};
