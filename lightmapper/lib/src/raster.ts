// Atlas space -> surface samples. Every covered texel gets the world position, normal and material
// of the point the path tracer has to shade. Pure CPU, so this is the part that has a unit test.
import type { Atlas } from "./atlas.ts";
import type { BakeMesh } from "./scene.ts";

export type Texels = {
  width: number;
  height: number;
  /** width*height, 1 where a chart covers the texel */
  mask: Uint8Array;
  /** width*height*4 — world position xyz, w unused */
  position: Float32Array;
  /** width*height*4 — world normal xyz, material id in w */
  normal: Float32Array;
  /** the covered texel indices, ascending — what the compute shader is dispatched over */
  index: Uint32Array;
};

/**
 * Texture space, not image space: texel row 0 is v = 0. That matches a `DataTexture` directly and
 * costs the PNG/EXR writers one row flip.
 */
export function rasterize(meshes: BakeMesh[], atlas: Atlas): Texels {
  const { width, height } = atlas;
  const mask = new Uint8Array(width * height);
  const position = new Float32Array(width * height * 4);
  const normal = new Float32Array(width * height * 4);

  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi];
    const uv = atlas.uv[mi];
    const triCount = mesh.faceMaterial.length;

    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3;
      const ax = uv[i0 * 2] * width;
      const ay = uv[i0 * 2 + 1] * height;
      const bx = uv[(i0 + 1) * 2] * width;
      const by = uv[(i0 + 1) * 2 + 1] * height;
      const cx = uv[(i0 + 2) * 2] * width;
      const cy = uv[(i0 + 2) * 2 + 1] * height;

      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0) continue; // degenerate in uv space: nothing to shade
      const inv = 1 / area;

      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx) + 0.5));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy) + 0.5));

      let hit = false;
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) * inv;
          const w2 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) * inv;
          const w0 = 1 - w1 - w2;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          write(mesh, t, w0, w1, w2, y * width + x, mask, position, normal);
          hit = true;
        }
      }

      // a triangle smaller than a texel covers no center; without this it would bake black
      if (!hit) {
        const x = Math.min(width - 1, Math.max(0, Math.floor((ax + bx + cx) / 3)));
        const y = Math.min(height - 1, Math.max(0, Math.floor((ay + by + cy) / 3)));
        const at = y * width + x;
        if (!mask[at]) write(mesh, t, 1 / 3, 1 / 3, 1 / 3, at, mask, position, normal);
      }
    }
  }

  let covered = 0;
  for (let i = 0; i < mask.length; i++) covered += mask[i];
  const index = new Uint32Array(covered);
  for (let i = 0, n = 0; i < mask.length; i++) if (mask[i]) index[n++] = i;

  return { width, height, mask, position, normal, index };
}

function write(
  mesh: BakeMesh,
  tri: number,
  w0: number,
  w1: number,
  w2: number,
  at: number,
  mask: Uint8Array,
  position: Float32Array,
  normal: Float32Array,
): void {
  const o = tri * 9;
  const d = at * 4;
  for (let k = 0; k < 3; k++) {
    position[d + k] = mesh.positions[o + k] * w0 + mesh.positions[o + 3 + k] * w1 + mesh.positions[o + 6 + k] * w2;
    normal[d + k] = mesh.normals[o + k] * w0 + mesh.normals[o + 3 + k] * w1 + mesh.normals[o + 6 + k] * w2;
  }
  const len = Math.hypot(normal[d], normal[d + 1], normal[d + 2]) || 1;
  normal[d] /= len;
  normal[d + 1] /= len;
  normal[d + 2] /= len;
  normal[d + 3] = mesh.faceMaterial[tri];
  mask[at] = 1;
}
